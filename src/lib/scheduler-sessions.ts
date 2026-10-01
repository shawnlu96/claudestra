/** Durable per-card session claims. Creation and retirement effects are performed by the later worker adapter. */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type AuthorFamily } from "./ledger-scheduler.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { requireSessionIdentity } from "./scheduler-session-identity.js";
import type { WorkerRef } from "./scheduler-plan.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";

export type SessionRole = "author" | "reviewer";
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
  return db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND role = ?").get(taskId, role) as SchedulerSession | null;
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
    if (prior) {
      if (prior.agent !== agent || prior.sessionId !== sessionId || prior.family !== input.family || prior.transport !== input.transport ||
        prior.createIntentId !== input.intentId) throw new LedgerError("conflict", "本卡角色已绑定另一个 session；不能换审查上下文");
      return { session: prior, duplicate: true };
    }
    const intent = getIntent(db, input.intentId);
    const reviewer = input.role === "reviewer";
    const wrote = remoteHeadFamily(db, task) ?? workflow.authorFamily; // a peer-delivered head: review across from its family
    const expectedFamily = reviewer ? (wrote === "claude" ? "codex" : "claude") : workflow.authorFamily;
    if (!intent || intent.taskId !== task.id || intent.action !== "ensure_session" || !["submitted", "unknown"].includes(intent.status) ||
      (intent.recipient !== null && intent.recipient !== agent) ||
      (reviewer ? intent.node !== "adversarial_review" : intent.node === "adversarial_review")) {
      throw new LedgerError("conflict", "缺本卡已派出的建 session 意图");
    }
    if (input.family !== expectedFamily || (reviewer && (agent === task.agent ||
      (workflow.template === "security" && input.transport === "peer"))) ||
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
        ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
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
    if (task.stage !== "verified" && task.stage !== "done") throw new LedgerError("conflict", "任务未验证，不能退役 session");
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
    db.prepare(`UPDATE scheduler_sessions SET ${col} = ?, retireIntentId = ?, state = ?, updatedAt = ? WHERE taskId = ? AND role = ?`)
      .run(receipt, input.intentId, col === "killReceipt" ? "retired" : "retiring", now, task.id, input.role);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${input.intentId}:${input.role}:${input.effect}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: `${input.role} session ${input.effect} 已确认`,
      data: { op: "session_retire", role: input.role, effect: input.effect, intentId: input.intentId, receipt,
        ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    return getSchedulerSession(db, task.id, input.role) as SchedulerSession;
  });
}
