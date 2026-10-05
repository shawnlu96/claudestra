/** Explicit reconciliation of a paused card's registered file scope. Never retires a writer or invents an intent. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWriteLease } from "./ledger-lend-lease.js";
import { getWorkflow, resourceKey, resourcesOverlap, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { busyAsLedgerError, LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { appendEvent } from "./ledger-write.js";
import { stepsOf } from "./ledger-steps.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { bareCanonicalName, normalizeRegistryAgents, REGISTRY_PATH } from "./registry.js";
import type { SchedulerSession } from "./scheduler-sessions.js";
import { readJsonStateSync } from "./state-file.js";

interface Claim { project: string; resource: string; taskId: string; intentId: string; scope: string; acquiredAt: number }
export interface FileScopeInput {
  taskId: string; project: string; taskRev: number; workflowRev: number; reason: string; apply?: boolean;
  /** File injection only; the CLI does not expose this as a flag. */
  registryPath?: string;
}
interface Plan {
  old: string[]; target: string[]; remove: string[]; add: string[];
  conflicts: { resource: string; held: string; taskId: string }[];
  reasons: string[]; anchors: Record<string, string>; pauseSeq: number | null;
}
const OP = "scheduler_file_scope";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Scheduler file resources are bare paths/globs. Every namespaced resource, including future kinds, is preserved.
const file = (s: string): boolean => !s.includes(":") && !s.startsWith("/") && resourceKey(s) !== null;
function fileList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !file(v))) {
    throw new LedgerError("invalid", "fileGlobs 必须是明确登记的文件路径数组；缺失或特殊资源不作空范围处理");
  }
  return [...new Set(value.map(v => resourceKey(v) as string))].sort();
}

function paused(db: Database, task: LedgerTask, input: FileScopeInput, events: LedgerEvent[], p: Plan): void {
  const w = getWorkflow(db, task.id);
  if (task.rev !== input.taskRev || !w || w.rev !== input.workflowRev) p.reasons.push("任务或 workflow CAS 已变化");
  if (!w || w.project !== task.project || w.mode !== "manual") p.reasons.push("仅 manual 暂停卡可对账");
  if (!["spec", "restate", "build", "review", "fix", "blocked"].includes(task.stage)) p.reasons.push("不是可暂停的非终态卡");
  const pause = events.findLast(e => e.kind === "scheduler" && e.data.op === "workflow");
  if (!pause || pause.data.mode !== "manual" || pause.data.workflowRev !== w?.rev ||
    !(pause.data.hold || pause.data.takeover) || !actorMayConfigure(db, pause.actor, task.project)) {
    p.reasons.push("缺正式 PM 暂停依据");
  } else p.pauseSeq = pause.seq;
}

/** Every surviving binding needs durable archive AND stop receipts; an empty registry is never retirement proof. */
function writers(db: Database, task: LedgerTask, intents: SchedulerIntent[], events: LedgerEvent[], input: FileScopeInput, p: Plan): void {
  const sessions = db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND role = 'author'").all(task.id) as SchedulerSession[];
  const retired = (s: SchedulerSession): boolean => {
    const intent = intents.find(i => i.id === s.retireIntentId && i.project === task.project && i.action === "retire" && i.status === "done");
    return ["acp", "tmux", "peer"].includes(s.transport) && ["claude", "codex"].includes(s.family) &&
      s.state === "retired" && !!intent && !!s.archiveReceipt && !!s.killReceipt && ["archive", "kill"].every(effect =>
      events.some(e => e.kind === "scheduler" && e.data.op === "session_retire" && e.data.role === "author" && e.ts >= s.createdAt &&
        e.data.intentId === intent.id && e.data.effect === effect && e.data.receipt === (effect === "archive" ? s.archiveReceipt : s.killReceipt)));
  };
  for (const s of sessions) if (!retired(s)) p.reasons.push(`作者 session ${s.sessionId} 未有完整正式退役事实`);
  const writingSteps = stepsOf(db, task).filter(s => ["restate", "write", "fix"].includes(s.step));
  for (const s of writingSteps) if (!["assigned", "delivered", "done"].includes(s.state)) p.reasons.push("作者步骤状态未知");
  const names = new Set([task.agent, task.assignee, ...writingSteps.map(s => s.executor), ...sessions.map(s => s.agent),
    ...intents.filter(i => i.action === "dispatch" && !isPoolIntent(i) && (i.status === "done" || i.attempts > 0)).map(i => i.recipient)]
    .filter((n): n is string => !!n));
  for (const n of names) if (!sessions.some(s => bareCanonicalName(s.agent) === bareCanonicalName(n) && retired(s))) {
    p.reasons.push(`旧作者绑定 ${n} 缺正式退役依据`);
  }
  const state = readJsonStateSync(input.registryPath ?? REGISTRY_PATH, v => object(v) && object(v.agents) && Object.values(v.agents).every(object));
  if (state.status !== "ok") { p.reasons.push(`registry 无法核实：${state.status}`); return; }
  const wanted = new Set([...names].map(bareCanonicalName));
  for (const a of normalizeRegistryAgents(state.data)) {
    if (a.task !== task.id && !wanted.has(bareCanonicalName(a.name))) continue;
    if (!sessions.some(s => s.sessionId === a.sessionId && bareCanonicalName(s.agent) === bareCanonicalName(a.name) && retired(s)) ||
      !["dead", "stopped", "retired"].includes(a.status ?? "") || a.acpRestartPending) p.reasons.push(`registry 作者 ${a.name} 仍可写或状态未知`);
  }
  for (const table of ["task_steps", "lend_write_leases"]) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) p.reasons.push(`${table} 缺失，作者状态无法核实`);
  }
  const lease = getWriteLease(db, task.id);
  if (lease && (lease.state !== "ended" || lease.project !== task.project)) p.reasons.push("写租约仍 held 或状态不明；本命令不结束租约");
}

/** Replay only real dispatch plans and this operation's audits to detect lost claims, including after a full release. */
function provenance(db: Database, task: LedgerTask, events: LedgerEvent[], intents: SchedulerIntent[], p: Plan, own: Claim[]): Map<string, string> {
  let expected = new Map<string, string>();
  const planned = new Map<string, Set<string>>();
  const historical = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "scheduler" && e.data.op === "plan" && e.data.action === "dispatch") {
      const i = intents.find(i => i.id === e.data.id && i.eventSeq === e.seq && i.project === task.project && i.action === "dispatch");
      if (!i || !Array.isArray(e.data.resources)) { p.reasons.push("派单来源锚点损坏"); continue; }
      planned.set(i.id, new Set());
      for (const r of e.data.resources) {
        if (typeof r !== "string" || resourceKey(r) !== r) { p.reasons.push("派单资源记录损坏"); continue; }
        if (!file(r)) continue;
        planned.get(i.id)!.add(r);
        historical.set(r, i.id);
        // planIntent retains an existing claim; only an actual acquisition carries the later intent and timestamp.
        const acquired = own.some(c => c.resource === r && c.intentId === i.id && c.acquiredAt === i.createdAt);
        if (!expected.has(r) || acquired) expected.set(r, i.id);
      }
    } else if (e.kind === "decision" && e.data.op === OP) {
      if (!actorMayConfigure(db, e.actor, task.project) || !Array.isArray(e.data.target) || !object(e.data.anchors)) {
        p.reasons.push("对账审计损坏"); continue;
      }
      const next = new Map<string, string>();
      for (const r of fileList(e.data.target)) {
        const anchor = e.data.anchors[r];
        if (typeof anchor !== "string" || !planned.get(anchor)?.has(r)) {
          p.reasons.push("对账来源锚点缺失");
        } else next.set(r, anchor);
      }
      expected = next;
    }
  }
  if (!planned.size) p.reasons.push("缺真实 dispatch 来源锚点；禁止伪造旧 intent");
  for (const r of p.target) {
    const anchor = expected.get(r) ?? historical.get(r);
    if (anchor) p.anchors[r] = anchor;
    else p.reasons.push(`文件缺真实 dispatch 来源：${r}`);
  }
  return expected;
}

function inspect(db: Database, task: LedgerTask, input: FileScopeInput): Plan {
  let target: string[] = [], scopeError: string | undefined;
  try { target = fileList(task.extra.fileGlobs); }
  catch (error) { scopeError = (error as Error).message; } // Preview reports corrupt scope; apply refuses before touching locks.
  const rows = db.query("SELECT * FROM scheduler_resources WHERE project = ? OR taskId = ?").all(task.project, task.id) as Claim[];
  const own = rows.filter(r => r.taskId === task.id && r.scope === "card" && file(r.resource));
  const old = own.map(r => r.resource).sort();
  const p: Plan = { old, target, remove: old.filter(r => !target.includes(r)), add: target.filter(r => !old.includes(r)),
    conflicts: [], reasons: scopeError ? [scopeError] : [], anchors: {}, pauseSeq: null };
  const events = listEvents(db, { project: task.project, target: task.id });
  const intents = db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(task.id) as SchedulerIntent[];
  paused(db, task, input, events, p);
  for (const i of intents) if (i.project !== task.project || !["done", "cancelled"].includes(i.status)) p.reasons.push(`意图 ${i.id} 未结或状态不明`);
  const orders = db.query("SELECT orderId, project, status FROM lend_orders WHERE taskId = ?").all(task.id) as
    { orderId: string; project: string; status: string }[];
  for (const o of orders) if (o.project !== task.project || !["done", "cancelled", "released"].includes(o.status)) p.reasons.push(`出借单 ${o.orderId} 未结或状态不明`);
  writers(db, task, intents, events, input, p);
  const expected = provenance(db, task, events, intents, p, own);
  for (const [resource, anchor] of expected) if (!own.some(r => r.resource === resource && r.intentId === anchor)) p.reasons.push(`失锁或来源被换：${resource}`);
  for (const r of own) if (r.project !== task.project || expected.get(r.resource) !== r.intentId) p.reasons.push(`文件锁缺匹配来源：${r.resource}`);
  for (const r of rows) {
    if (resourceKey(r.resource) !== r.resource || !["card", "intent"].includes(r.scope)) p.reasons.push("资源表存在未知状态");
    for (const wanted of new Set([...old, ...target])) {
      if ((r.taskId !== task.id || (p.add.includes(wanted) && r.scope !== "card")) && resourcesOverlap(wanted, r.resource)) {
        p.conflicts.push({ resource: wanted, held: r.resource, taskId: r.taskId });
      }
    }
  }
  if (p.conflicts.length) p.reasons.push("已有或目标范围与现存资源冲突");
  return p;
}

export function reconcileFileScope(db: Database, ctx: WriteCtx, input: FileScopeInput) {
  const transaction = db.transaction(() => {
    const task = mustTask(db, input.taskId);
    if (task.project !== input.project || ctx.actor === "scheduler" || !actorMayConfigure(db, ctx.actor, task.project)) {
      throw new LedgerError("forbidden", "只接受本项目 PM / owner / master");
    }
    const reason = textOneLine(input.reason, "对账原因", 600);
    const plan = inspect(db, task, input);
    if (!input.apply) return { ok: true, dryRun: true, executable: plan.reasons.length === 0, ...plan };
    if (plan.reasons.length) throw new LedgerError("conflict", plan.reasons.join("；"), { ...plan });
    if (!plan.remove.length && !plan.add.length) return { ok: true, dryRun: false, duplicate: true, ...plan };
    for (const r of plan.remove) {
      const result = db.query("DELETE FROM scheduler_resources WHERE project = ? AND taskId = ? AND scope = 'card' AND resource = ?")
        .run(task.project, task.id, r);
      if (result.changes !== 1) throw new LedgerError("conflict", "删锁 CAS 失败");
    }
    const now = ctx.now ?? Date.now();
    for (const r of plan.add) db.query(`INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope)
      VALUES (?, ?, ?, ?, ?, 'card')`).run(task.project, r, task.id, plan.anchors[r], now);
    const { event } = appendEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "decision", text: reason,
      data: { op: OP, ...plan, taskRev: task.rev, workflowRev: input.workflowRev, fileGlobs: task.extra.fileGlobs } });
    return { ok: true, dryRun: false, duplicate: false, eventSeq: event.seq, ...plan };
  });
  // query_only forbids BEGIN IMMEDIATE. Preview takes one read snapshot; apply rechecks everything under the write reservation.
  return busyAsLedgerError("文件锁对账", () => input.apply ? transaction.immediate() : transaction.deferred());
}
