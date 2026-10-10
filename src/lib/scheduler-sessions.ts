import { applyFixReplacement } from "./fix-strategy-session.js";
/** Durable per-card session claims. Sessions are created by the auto tick's ensure step and retired by scheduler-retire.ts. */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMaySchedule } from "./ledger-scheduler-settle.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { requireSessionIdentity } from "./scheduler-session-identity.js";
import type { WorkerRef } from "./scheduler-plan.js";
import type { Stage, LedgerEvent } from "./ledger-stages.js";
import {
  applyRefusalEpoch, applyReviewerSwap, type MaterialCheck, type Placement, applyReviewerSwapEffect, mayRebindReviewer, refusalBindMarks, refusalRebind, reviewerReuseNote,
} from "./scheduler-review-swap.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { securityPoolMode, securityReviewLocalOnly } from "./security-pool.js";

export type SessionRole = "author" | "reviewer";
/** Stages a card is finished in: only these retire. build / review / fix / merge / live never do (tests/scheduler-retire.test.ts). */
export const RETIRE_STAGES: readonly Stage[] = ["verified", "done", "cancelled"];
export type SessionTransport = "acp" | "tmux" | "peer";
export interface SchedulerSession {
  taskId: string;
  role: SessionRole;
  agent: string;
  sessionId: string;
  family: AuthorFamily;
  transport: SessionTransport;
  state: "active" | "retiring" | "retired";
  createIntentId: string;
  retireIntentId: string | null;
  archiveReceipt: string | null;
  killReceipt: string | null;
  createdAt: number;
  updatedAt: number;
}

const field = (v: string, what: string, max = 200): string => {
  const t = v.trim();
  if (!t || t.length > max || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(t)) throw new LedgerError("invalid", `${what}要是单行且不超过 ${max} 字`);
  return t;
};
const mayWrite = (db: Database, ctx: WriteCtx, project: string): boolean =>
  ctx.actor === "scheduler" || (ctx.actor !== getMeta(db, project).team?.dispatcher && isManager(db, ctx.actor, { project, agent: null }));

export function getSchedulerSession(db: Database, taskId: string, role: SessionRole): SchedulerSession | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get()) return null;
  return db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND role = ? ORDER BY (state != 'retired') DESC, createdAt DESC, rowid DESC LIMIT 1").get(taskId, role) as SchedulerSession | null;
}

export function taskWorkerRefs(db: Database, taskId: string): { author: WorkerRef | null; reviewer: WorkerRef | null } {
  const ref = (role: SessionRole): WorkerRef | null => {
    const row = getSchedulerSession(db, taskId, role);
    return row && row.state !== "retired" ? {
      agent: row.agent, sessionId: row.sessionId, taskId, family: row.family,
      source: row.transport === "peer" ? "peer_claim" : "local",
    } : null;
  };
  return { author: ref("author"), reviewer: ref("reviewer") };
}

/** Detail navigation keeps retired sessions addressable through their archived history. */
export function taskSessionLinks(db: Database, taskId: string): Record<SessionRole, { agent: string; sessionId: string; state: SchedulerSession["state"]; source: "local" | "peer_claim" } | null> {
  const link = (role: SessionRole) => {
    const row = getSchedulerSession(db, taskId, role);
    return row ? { agent: row.agent, sessionId: row.sessionId, state: row.state,
      source: row.transport === "peer" ? "peer_claim" as const : "local" as const } : null;
  };
  return { author: link("author"), reviewer: link("reviewer") };
}

export interface BindSessionInput {
  taskId: string;
  role: SessionRole;
  intentId: string;
  agent: string;
  sessionId: string;
  family: AuthorFamily;
  transport: SessionTransport;
  /** Test injection only; production reads the canonical registry path inside the ledger write transaction. */
  registryPath?: string;
  /** MODELX: a reviewer bound under a refusal epoch re-checks the refused ticket's frozen materials in this transaction; none = no such bind. */
  refusalCheck?: MaterialCheck;
}

/** A dispatched ensure_session intent is the only authority; unknown effects can bind after reconciliation. */
export function bindSchedulerSession(db: Database, ctx: WriteCtx, input: BindSessionInput): { session: SchedulerSession; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!mayWrite(db, ctx, task.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能绑定调度 session");
    const workflow = getWorkflow(db, task.id);
    if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev) throw new LedgerError("conflict", "任务未处于当前规格的自动流程");
    if (input.role !== "author" && input.role !== "reviewer") throw new LedgerError("invalid", "session 角色不认识");
    if (input.family !== "claude" && input.family !== "codex") throw new LedgerError("invalid", "模型家族不认识");
    if (input.transport !== "acp" && input.transport !== "tmux" && input.transport !== "peer") throw new LedgerError("invalid", "transport 不认识");
    const agent = field(input.agent, "agent"), sessionId = field(input.sessionId, "sessionId");
    requireSessionIdentity(db, task, input, agent);
    const prior = getSchedulerSession(db, task.id, input.role);
    const epoch = prior && input.role === "reviewer" ? refusalRebind(db, prior, input.intentId, input.refusalCheck) : null; // MODELX: once, after a refusal epoch
    if (prior && !epoch && !mayRebindReviewer(db, prior, input.intentId)) {
      if (prior.agent !== agent || prior.sessionId !== sessionId || prior.family !== input.family || prior.transport !== input.transport ||
        prior.createIntentId !== input.intentId) throw new LedgerError("conflict", "本卡角色已绑定另一个 session；不能换审查上下文");
      return { session: prior, duplicate: true };
    }
    const intent = getIntent(db, input.intentId);
    const reviewer = input.role === "reviewer";
    const wrote = remoteHeadFamily(db, task) ?? workflow.authorFamily; // a peer-delivered head: review across from its family
    const expectedFamily = epoch ? epoch.data.toFamily : reviewer ? (wrote === "claude" ? "codex" : "claude") : workflow.authorFamily;
    if (!intent || intent.taskId !== task.id || intent.action !== "ensure_session" || !["submitted", "unknown"].includes(intent.status) ||
      (intent.recipient !== null && intent.recipient !== agent) ||
      (reviewer ? intent.node !== "adversarial_review" : intent.node === "adversarial_review")) {
      throw new LedgerError("conflict", "缺本卡已派出的建 session 意图");
    }
    if (input.family !== expectedFamily || (reviewer && (agent === task.agent ||
      (securityReviewLocalOnly(workflow, securityPoolMode(task.project)) && input.transport === "peer"))) ||
      (!reviewer && task.agent && agent !== task.agent)) throw new LedgerError("invalid", "session 与本卡作者或跨模型审查规则不符");
    const now = ctx.now ?? Date.now();
    try {
      db.prepare(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(task.id, input.role, agent, sessionId, input.family, input.transport, input.intentId, now, now);
    } catch (e) {
      if (String(e).includes("UNIQUE constraint failed")) throw new LedgerError("conflict", "session 已属于另一张卡");
      throw e;
    }
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${input.intentId}:bind` }, {
      project: task.project, target: task.id, kind: "scheduler", text: `绑定 ${input.role} session`,
      data: { op: "session_bind", role: input.role, agent, sessionId, family: input.family, transport: input.transport,
        source: input.transport === "peer" ? "peer_claim" : "registry_runtime", intentId: input.intentId,
        ...(epoch ? refusalBindMarks(epoch) : {}), ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    const note = reviewer ? reviewerReuseNote(task, prior) : null;
    if (note) insertEvent(db, { actor: ctx.actor, now, dedupKey: `reviewer-reuse:${input.intentId}` }, note, true);
    return { session: getSchedulerSession(db, task.id, input.role) as SchedulerSession, duplicate: false };
  });
}

/** Archive must be observed before kill; each receipt is durable before the next external effect. */
export function recordSessionRetirement(db: Database, ctx: WriteCtx, input: {
  taskId: string; role: SessionRole; intentId: string; effect: "archive" | "kill"; receipt: string;
}): SchedulerSession {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!mayWrite(db, ctx, task.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能记录 session 退役");
    if (!RETIRE_STAGES.includes(task.stage)) throw new LedgerError("conflict", "任务未验证也未取消，不能退役 session");
    const intent = getIntent(db, input.intentId);
    if (!intent || intent.taskId !== task.id || intent.action !== "retire" || !["submitted", "unknown"].includes(intent.status)) {
      throw new LedgerError("conflict", "缺本卡已派出的退役意图");
    }
    const row = getSchedulerSession(db, task.id, input.role);
    if (!row) throw new LedgerError("not_found", "本卡没有该角色 session");
    if (row.retireIntentId && row.retireIntentId !== input.intentId) throw new LedgerError("conflict", "session 已由另一个意图退役");
    const receipt = field(input.receipt, "回执", 600);
    const col = input.effect === "archive" ? "archiveReceipt" : input.effect === "kill" ? "killReceipt" : null;
    if (!col) throw new LedgerError("invalid", "退役效果不认识");
    if (col === "killReceipt" && !row.archiveReceipt) throw new LedgerError("conflict", "必须先确认归档，再停止 session");
    if (row[col]) {
      if (row[col] !== receipt) throw new LedgerError("dedup_mismatch", "同一退役效果的回执不一致");
      return row;
    }
    const now = ctx.now ?? Date.now();
    db.prepare(`UPDATE scheduler_sessions SET ${col} = ?, retireIntentId = ?, state = ?, updatedAt = ? WHERE sessionId = ?`)
      .run(receipt, input.intentId, col === "killReceipt" ? "retired" : "retiring", now, row.sessionId);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${input.intentId}:${input.role}:${input.effect}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: `${input.role} session ${input.effect} 已确认`,
      data: { op: "session_retire", role: input.role, effect: input.effect, intentId: input.intentId, receipt,
        ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    return getSchedulerSession(db, task.id, input.role) as SchedulerSession;
  });
}

/** One key per card: a finished card never goes back to work, so a second retirement would only repeat the first. */
export const retireIntentId = (taskId: string): string => `retire:${taskId}`;

const projectSeq = (db: Database, project: string): number =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(project) as { seq: number }).seq;

/**
 * Open (or return, duplicate: true) the card's retire intent, already claimed (docs/architecture/scheduler-retire.md). Unlike planIntent
 * it does not require an auto workflow — most finished cards were taken to manual on the way, and their scheduler-bound sessions still
 * need collecting. It does require a finished card (RETIRE_STAGES) with no other open intent, so a card still in work is never retired.
 */
export function beginRetire(db: Database, ctx: WriteCtx, taskId: string): { intent: SchedulerIntent; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, taskId);
    if (!actorMaySchedule(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有调度服务或项目 PM / master / owner 能开退役意图");
    const id = retireIntentId(task.id);
    const prior = getIntent(db, id);
    if (prior) return { intent: prior, duplicate: true };
    if (!RETIRE_STAGES.includes(task.stage)) throw new LedgerError("conflict", `${task.id} 在 ${task.stage}，没收尾的卡不退役`);
    const open = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1")
      .get(task.id) as { id: string } | null;
    if (open) throw new LedgerError("conflict", `${task.id} 还有未结调度意图 ${open.id}，先结清再退役`);
    const now = ctx.now ?? Date.now(), causalSeq = projectSeq(db, task.project);
    const workflow = getWorkflow(db, task.id), reason = `${task.stage} 卡收尾：归档并结束 session、清 worktree`;
    db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head,
      templateVersion, status, attempts, receipt, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'retire', 'retire', NULL, ?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?, ?)`)
      .run(id, task.id, task.project, causalSeq, task.rev, task.specRev, task.headSHA, workflow?.templateVersion ?? 0, "claimed; retire", reason, now, now);
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${id}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: reason,
      data: { op: "plan", id, node: "retire", action: "retire", recipient: null, resources: [], causalSeq, taskRev: task.rev,
        specRev: task.specRev, head: task.headSHA, template: workflow?.template ?? null, version: workflow?.templateVersion ?? 0,
        claimed: true, ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    db.prepare("UPDATE scheduler_intents SET eventSeq = ? WHERE id = ?").run(event.seq, id);
    return { intent: getIntent(db, id) as SchedulerIntent, duplicate: false };
  });
}

/** Lazily widen the original per-role key at the first swap; all bindings, FKs and uniqueness survive the transaction. */
export function preserveSessionHistory(db: Database): void {
  const columns = db.query("PRAGMA table_info(scheduler_sessions)").all() as { name: string; pk: number }[];
  if (columns.some((c) => c.name === "sessionId" && c.pk)) return;
  const schema = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_sessions'").get() as { sql: string };
  db.run(schema.sql.replace("scheduler_sessions", "scheduler_sessions_history_upgrade")
    .replace(/PRIMARY KEY\s*\(taskId,\s*role\)/i, "PRIMARY KEY (taskId, role, sessionId)"));
  db.run("INSERT INTO scheduler_sessions_history_upgrade SELECT * FROM scheduler_sessions");
  db.run("DROP TABLE scheduler_sessions");
  db.run("ALTER TABLE scheduler_sessions_history_upgrade RENAME TO scheduler_sessions");
  db.run("CREATE INDEX scheduler_sessions_state ON scheduler_sessions(state)");
  db.run("CREATE UNIQUE INDEX scheduler_sessions_current ON scheduler_sessions(taskId, role) WHERE state != 'retired'");
}

/** Binding changes use the session writer's transaction/event authority; swap guards and semantics live in the swap module. */
export function beginReviewerSwap(db: Database, ctx: WriteCtx, id: string): SchedulerSession {
  return tx(db, () => applyReviewerSwap(db, ctx, id, getSchedulerSession(db, getIntent(db, id)?.taskId ?? "", "reviewer"),
    () => preserveSessionHistory(db), (c, e) => { insertEvent(db, c, e, true); }));
}

/** MODELX: the refusal epoch for MODEL's recorded plan event; the swap module holds every guard (scheduler-review-swap.ts). */
export function beginRefusalEpoch(db: Database, ctx: WriteCtx, taskId: string, planSeq: number, authorized: readonly Placement[], check: MaterialCheck) {
  return tx(db, () => applyRefusalEpoch(db, ctx, taskId, planSeq, getSchedulerSession(db, taskId, "reviewer"), authorized, check,
    () => preserveSessionHistory(db), (c, e) => insertEvent(db, c, e, true)));
}

export function beginLegacyReviewRetire<T>(db: Database, taskId: string, intentId: string,
  apply: (write: (ctx: WriteCtx, e: Pick<LedgerEvent, "project" | "target" | "kind" | "text" | "data">) => LedgerEvent) => T): T {
  return apply((ctx, e) => {
    if (ctx.actor !== "scheduler" || e.kind !== "scheduler" || e.target !== taskId || e.project !== mustTask(db, taskId).project ||
      e.data.op !== "reviewer_swap" || e.data.legacy !== true || e.data.intentId !== intentId || "refusal" in e.data) throw new LedgerError("forbidden", "仅限本卡旧审查单退休");
    return insertEvent(db, ctx, e, true); });
}
export function recordReviewerSwapEffect(db: Database, ctx: WriteCtx, id: string, effect: "archive" | "kill" | "reuse", receipt: string): void {
  tx(db, () => applyReviewerSwapEffect(db, ctx, id, effect, receipt, (c, e) => { insertEvent(db, c, e, true); }));
}

export function bindFixReplacement(db: Database, ctx: WriteCtx, intentId: string, ref: import("./worker-session.js").SessionRef, material: string, registryPath?: string): void {
  applyFixReplacement(db, ctx, intentId, ref, material, () => preserveSessionHistory(db), registryPath);
}
