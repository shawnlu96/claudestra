/**
 * `ledger scheduler-lock-yield` 的写侧：在 BEGIN IMMEDIATE 里按同一读法重核，tick 看到的停滞起点 / 依据 / 锁清单有一样变了就拒（conflict，下轮重算）。
 * phase yield：observe 记一条「本可让锁」（recordObserved，按卡 + 停滞起点去重），on 删这张卡的 scheduler_resources 行并记一条让锁事件；
 * 别的（fileGlobs、分支、worktree、绑定、阶段）都不动。phase contend / contend-sent：让过锁的卡恢复后拿不回锁，记一次、通知 PM 后标已送达。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved, type RecoveryPolicyPort } from "./recovery-policy.js";
import {
  candidateText, CONTEND_OP, contendKey, contentionOf, contentionText, LOCK_YIELD_KEY, observeActionKey, RELEASED_OP, stallOf, waitersFor,
  yieldDedupKey, type Basis, type YieldAgent, type YieldCandidate,
} from "./scheduler-lock-yield.js";
import { readYieldFacts, releasedPending, resumedAfter } from "./scheduler-lock-yield-read.js";

export type LockYieldWire =
  | { v: 1; phase: "yield"; basis: Basis; since: number; resources: string[]; agents: YieldAgent[] | null }
  | { v: 1; phase: "contend" | "contend-sent"; releaseSeq: number };

const isAgent = (a: unknown): a is YieldAgent => !!a && typeof a === "object" && typeof (a as YieldAgent).name === "string"
  && typeof (a as YieldAgent).recent === "boolean" && ((a as YieldAgent).lastAt === null || Number.isSafeInteger((a as YieldAgent).lastAt));

/** 严格解析：认不出的字段 / 类型一律 invalid，不猜 */
export function parseLockYieldWire(raw: string): LockYieldWire {
  let v: Record<string, unknown>;
  try { v = JSON.parse(raw) as Record<string, unknown>; } catch (e) { throw new LedgerError("invalid", `--data 不是 JSON：${(e as Error).message}`); }
  if (!v || typeof v !== "object" || v.v !== 1) throw new LedgerError("invalid", "--data 要是 { v: 1, phase, ... }");
  if (v.phase === "contend" || v.phase === "contend-sent") {
    if (!Number.isSafeInteger(v.releaseSeq) || (v.releaseSeq as number) < 1) throw new LedgerError("invalid", "releaseSeq 要是正整数");
    return { v: 1, phase: v.phase, releaseSeq: v.releaseSeq as number };
  }
  const agentsOk = v.agents === null || (Array.isArray(v.agents) && v.agents.every(isAgent));
  if (v.phase !== "yield" || (v.basis !== "blocked" && v.basis !== "idle") || !Number.isSafeInteger(v.since) || !agentsOk
    || !Array.isArray(v.resources) || !v.resources.every((r) => typeof r === "string")) {
    throw new LedgerError("invalid", "yield 要带 basis（blocked|idle）、since、resources[]、agents[]|null");
  }
  return { v: 1, phase: "yield", basis: v.basis, since: v.since as number, resources: [...(v.resources as string[])].sort(), agents: v.agents as YieldAgent[] | null };
}

function recheck(db: Database, taskId: string, wire: Extract<LockYieldWire, { phase: "yield" }>, now: number): YieldCandidate {
  const task = getTask(db, taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  const f = readYieldFacts(db, task.project);
  if (f.unknown.length) throw new LedgerError("conflict", `取数不完整，不让：${f.unknown.join("；")}`);
  const card = f.cards.find((c) => c.id === taskId);
  const s = card ? stallOf(card, f.held, wire.agents, now) : { kind: "skip" as const, why: "卡不在持锁名单里" };
  if (s.kind === "skip") throw new LedgerError("conflict", `重核：不让（${s.why}）`);
  const resources = f.held.filter((h) => h.taskId === taskId).map((h) => h.resource).sort();
  if (s.basis !== wire.basis || s.since !== wire.since || JSON.stringify(resources) !== JSON.stringify(wire.resources)) {
    throw new LedgerError("conflict", "重核：停滞依据、起点或锁清单已变，下轮重算");
  }
  return { taskId, basis: s.basis, since: s.since, evidence: s.evidence, resources, waiters: waitersFor(f, taskId) };
}

function yieldPhase(db: Database, ctx: WriteCtx, taskId: string, wire: Extract<LockYieldWire, { phase: "yield" }>, policy: RecoveryPolicyPort) {
  const now = ctx.now ?? Date.now(), project = getTask(db, taskId)?.project ?? "";
  const p = policy(project, LOCK_YIELD_KEY);
  if (p.source === "error" || p.mode === "off") throw new LedgerError("conflict", `恢复策略 ${LOCK_YIELD_KEY} 不让：${p.diagnostic ?? p.mode}`);
  const key = yieldDedupKey(taskId, wire.since), prior = getEventByDedup(db, key);
  if (prior) return { ok: true, mode: p.mode, duplicate: true, event: prior };
  const c = recheck(db, taskId, wire, now);
  const data = { basis: c.basis, since: c.since, evidence: c.evidence, resources: c.resources, waiters: c.waiters };
  if (p.mode === "observe") {
    const r = recordObserved(db, { project, mechanism: LOCK_YIELD_KEY, target: taskId, actionKey: observeActionKey(c.since), action: candidateText(c), data }, now);
    return { ok: true, mode: "observe", recorded: r.recorded, seq: r.seq, released: [] };
  }
  const rows = db.query("SELECT resource, scope, intentId, acquiredAt FROM scheduler_resources WHERE project = ? AND taskId = ? ORDER BY resource")
    .all(project, taskId) as { resource: string; scope: string; intentId: string; acquiredAt: number }[];
  db.query("DELETE FROM scheduler_resources WHERE project = ? AND taskId = ?").run(project, taskId);
  const { event } = appendEvent(db, { ...ctx, dedupKey: key }, { project, target: taskId, kind: "note",
    text: `[调度引擎] 停滞让锁：${candidateText(c)}`.slice(0, 600), data: { op: RELEASED_OP, ...data, rows, branch: getTask(db, taskId)?.branch ?? null } });
  return { ok: true, mode: "on", duplicate: false, event, released: c.resources };
}

function contendPhase(db: Database, ctx: WriteCtx, taskId: string, wire: Extract<LockYieldWire, { phase: "contend" | "contend-sent" }>) {
  const task = getTask(db, taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${taskId}`);
  const key = contendKey(wire.releaseSeq), prior = getEventByDedup(db, key);
  if (wire.phase === "contend-sent") {
    if (!prior || prior.target !== taskId) throw new LedgerError("conflict", "拿不回锁的记录还没记");
    return { ok: true, ...appendEvent(db, { ...ctx, dedupKey: `${key}:sent` }, { project: task.project, target: taskId, kind: "note", text: prior.text,
      data: { op: `${CONTEND_OP}_sent`, releaseSeq: wire.releaseSeq } }) };
  }
  if (prior) return { ok: true, duplicate: true, event: prior, text: prior.text };
  if (!releasedPending(db, task.project).some((r) => r.seq === wire.releaseSeq && r.taskId === taskId)) {
    throw new LedgerError("conflict", "不是这张卡待观察的让锁记录（或已正常拿回锁）");
  }
  if (!resumedAfter(db, taskId, wire.releaseSeq)) throw new LedgerError("conflict", "卡还没恢复推进");
  const f = readYieldFacts(db, task.project, [taskId]);
  const card = f.cards.find((c) => c.id === taskId), c = card && contentionOf(card, f);
  if (!card || !c) throw new LedgerError("conflict", "没有别卡占着它要的文件锁");
  const text = contentionText(card, wire.releaseSeq, c);
  const { event } = appendEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: taskId, kind: "note", text,
    data: { op: CONTEND_OP, releaseSeq: wire.releaseSeq, holders: c.holders, branch: card.branch } });
  return { ok: true, duplicate: false, event, text };
}

/** 只给调度服务身份；一个写事务里重核 + 写 */
export function lockYieldWrite(db: Database, ctx: WriteCtx, taskId: string, wire: LockYieldWire, policy: RecoveryPolicyPort): Record<string, unknown> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "停滞让锁只由调度服务记账");
  return db.transaction(() => wire.phase === "yield" ? yieldPhase(db, ctx, taskId, wire, policy) : contendPhase(db, ctx, taskId, wire)).immediate();
}
