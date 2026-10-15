/** Persisted claims and outcomes share the ledger transaction and survive scheduler restarts. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { listAsks, openAskFull } from "./ledger-asks.js";
import { readPriorityModes } from "./ledger-priority-read.js";
import type { PriorityMode } from "./ledger-priority-types.js";
import { freshStallCycle, nextStallAction, PRIORITY_STALL_MS, stallNotice,
  type StallAction, type StallBasis, type StallCycle, type StallResult } from "./ledger-priority-stall.js";
import { priorityStallBases } from "./ledger-priority-stall-read.js";

const NAMESPACE = "priority-stall", PENDING_MS = 5 * 60_000;
type Stream = "observe" | "on";
interface Stored { key: string; stream: Stream; cycle: StallCycle | null }
export interface StallClaim { basis: StallBasis; cycle: StallCycle; action: StallAction; token: string; mode: Stream }

export function priorityStallRevision(db: Database, project: string, key: string): number {
  const row = db.query(`SELECT MAX(seq) AS rev FROM events WHERE project=? AND json_extract(data,'$.namespace')=?
    AND json_extract(data,'$.key')=?`).get(project, NAMESPACE, key) as { rev: number | null };
  return row.rev ?? 0;
}

function state(db: Database, project: string, key: string, stream: Stream): StallCycle | null {
  const row = db.query(`SELECT data FROM events WHERE project=? AND json_extract(data,'$.namespace')=?
    AND json_extract(data,'$.key')=? AND json_extract(data,'$.stream')=? ORDER BY seq DESC LIMIT 1`).get(project, NAMESPACE, key, stream) as { data: string } | null;
  return row ? (JSON.parse(row.data) as Stored).cycle : null;
}

function save(db: Database, ctx: WriteCtx, b: StallBasis, stream: Stream, cycle: StallCycle | null, text: string): void {
  appendEvent(db, { ...ctx, dedupKey: undefined }, { project: b.project, target: b.taskId ?? "", kind: "note", text,
    data: { namespace: NAMESPACE, op: "episode", key: b.key, stream, cycle, stage: b.stage, why: b.why } });
}

export function priorityStallThreshold(db: Database, project: string): number {
  const row = db.query("SELECT value FROM meta WHERE project=? AND key='priorityStallMs'").get(project) as { value: string } | null;
  return row ? Number(JSON.parse(row.value)) : PRIORITY_STALL_MS;
}

/** A separate audited setting; changing a title, note or threshold never rewinds the progress clock. */
export function setPriorityStallThreshold(db: Database, ctx: WriteCtx, project: string, milliseconds: number, reason: string): void {
  db.transaction(() => {
    if (ctx.actor !== "owner") throw new LedgerError("forbidden", "停滞门槛只由 owner 配置");
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000 || milliseconds > 30 * 86_400_000 || !reason.trim()) {
      throw new LedgerError("invalid", "门槛为 1000..2592000000 毫秒且需 reason");
    }
    const prior = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
    if (prior) {
      if (prior.project !== project || prior.actor !== ctx.actor || prior.data.namespace !== NAMESPACE
        || prior.data.op !== "threshold" || prior.data.after !== milliseconds || prior.text !== reason) {
        throw new LedgerError("dedup_mismatch", "门槛配置去重键内容不符");
      }
      return;
    }
    const before = priorityStallThreshold(db, project);
    db.query("INSERT INTO meta(project,key,value) VALUES (?,'priorityStallMs',?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value")
      .run(project, JSON.stringify(milliseconds));
    appendEvent(db, ctx, { project, target: "", kind: "decision", text: reason,
      data: { namespace: NAMESPACE, op: "threshold", before, after: milliseconds } });
  }).immediate();
}

function requireScheduler(ctx: WriteCtx): void {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "停滞周期只由调度服务处理");
}

function reconcile(db: Database, ctx: WriteCtx, b: StallBasis, mode: Stream, rev: number): StallCycle {
  let c = state(db, b.project, b.key, mode);
  if (!c || c.progress !== b.progress || c.epoch !== b.nowSince) {
    c = freshStallCycle(b, rev);
    save(db, ctx, b, mode, c, "按实际推进及当前 now 档位开启周期");
  }
  const now = ctx.now ?? Date.now(), modeChanged = c.modeRev !== rev;
  if (modeChanged) { c.modeRev = rev; save(db, ctx, b, mode, c, "模式重核，保留实际周期结果"); }
  if (c.pending && (modeChanged || now - c.pending.at >= PENDING_MS)) {
    const p = c.pending;
    if (p.action !== "owner") c[p.action] = { at: p.at, attempts: p.attempts, result: "unknown", detail: "动作认领后无明确回执，需核对" };
    delete c.pending;
    save(db, ctx, b, mode, c, "停滞动作结果不明");
  }
  return c;
}

/** Claim all due targets in one transaction. Repeated/concurrent ticks see a pending claim and do nothing. */
export function claimPriorityStalls(db: Database, ctx: WriteCtx, project: string, key?: string): StallClaim[] {
  requireScheduler(ctx);
  return db.transaction(() => {
    const m = readPriorityModes(db, project).priorityStall as { mode: PriorityMode; rev: number };
    if (m.mode === "off") return [];
    const out: StallClaim[] = [], now = ctx.now ?? Date.now();
    for (const b of priorityStallBases(db, project).filter((b) => key === undefined || b.key === key)) {
      if (!b.eligible) {
        if (state(db, project, b.key, m.mode)) save(db, ctx, b, m.mode, null, "降档或终态，结束停滞周期");
        continue;
      }
      const c = reconcile(db, ctx, b, m.mode, m.rev), action = nextStallAction(c, now, priorityStallThreshold(db, project));
      if (!action) continue;
      const token = crypto.randomUUID(), attempts = (c[action]?.attempts ?? 0) + 1;
      c.pending = { action, token, at: now, attempts };
      save(db, ctx, b, m.mode, c, `${m.mode === "observe" ? "本会" : "认领"}${action}：${b.why}`);
      out.push({ basis: b, cycle: c, action, token, mode: m.mode });
    }
    return out;
  }).immediate();
}

export function livePriorityStallClaim(db: Database, project: string, key: string, token: string): StallClaim | null {
  const m = readPriorityModes(db, project).priorityStall as { mode: PriorityMode; rev: number };
  if (m.mode === "off") return null;
  const b = priorityStallBases(db, project).find((b) => b.key === key);
  const c = state(db, project, key, m.mode);
  if (!b?.eligible || !c?.pending || c.pending.token !== token || c.modeRev !== m.rev || c.progress !== b.progress || c.epoch !== b.nowSince) return null;
  return { basis: b, cycle: c, action: c.pending.action, token, mode: m.mode };
}

/** Tokens fence late completions: progress, downgrade or a different claimed attempt invalidates an old callback. */
export function finishPriorityStall(db: Database, ctx: WriteCtx, project: string, key: string, token: string, result: StallResult, detail: string): boolean {
  requireScheduler(ctx);
  return db.transaction(() => {
    const live = livePriorityStallClaim(db, project, key, token);
    if (!live) return false;
    const { basis: b, cycle: c, action, mode } = live;
    c[action] = { at: ctx.now ?? Date.now(), result, detail: detail.slice(0, 1200), attempts: c.pending!.attempts };
    delete c.pending;
    save(db, ctx, b, mode, c, `${mode === "observe" ? "本会" : "结果"}${action} ${result}`);
    return true;
  }).immediate();
}

/** A transaction owns creation and episode completion; open owner actions are linked across episodes. */
export function priorityStallOwner(db: Database, ctx: WriteCtx, project: string, key: string, token: string): string | null {
  requireScheduler(ctx);
  return db.transaction(() => {
    const live = livePriorityStallClaim(db, project, key, token);
    if (!live || live.action !== "owner" || live.mode !== "on") return null;
    const { basis: b, cycle: c } = live, now = ctx.now ?? Date.now(), body = stallNotice(b, c, now);
    const existing = listAsks(db, { project, states: ["open"] }).find((a) => a.kind === "owner_action"
      && (a.extra.priorityStallKey === key || (b.taskId && a.taskId === b.taskId && a.extra.mechanism === "priorityStall")));
    const ask = existing ?? openAskFull(db, { project, taskId: b.taskId, source: "system", kind: "owner_action", title: `now 停滞：${b.label}`,
      body, createdBy: "system:priority-stall", dedupKey: `priority-stall-owner:${project}:${key}:${c.id}`,
      extra: { mechanism: "priorityStall", priorityStallKey: key, cycle: c.id, pm: b.pm, featureId: b.featureId, label: b.label } }, now).ask;
    finishPriorityStall(db, ctx, project, key, token, "success", `${existing ? "关联" : "创建"} owner 待办 ${ask.id}\n${body}`);
    return ask.id;
  }).immediate();
}
