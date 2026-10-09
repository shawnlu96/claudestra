import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { EventKind } from "./ledger-stages.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";
import { readSharedLedgerMode, sharedLedgerProtectedWrites } from "./shared-ledger-mode.js";
import { parseFence, type V2Fence } from "./shared-ledger-contract-v2-validation.js";
import { assertExecutorChanges, beginTracking, endTracking, gateFeatureIds, gateTask, localIntent, markTracked, originTask, rejectStaleClaim,
  taskChanges, taskJson } from "./shared-ledger-v2-write-gate-state.js";

/**
 * Scope note (PM, S2G2): createItem / setItem / setFrozen / setMeta are project-level writes and stay writable under execution.
 * This deliberately narrows S2G acceptance line 1: execution governs only the feature's cards, their DAG and scheduler bookkeeping.
 * Cost: off (no mode file, or no execution / migrating feature) runs no gate query; on, TEMP triggers record touched rows only.
 * Stage-two refusal codes outside LedgerErrorCode (stale_claim, v2_unmapped) are thrown as conflict with the code name in the text.
 */

export const PROJECTION_ACTOR = "shared-ledger-v2-projection";
export type ExecutorFence = V2Fence & { leaseId: string };
export interface ProjectionRef { featureId: string; centerSeq: number; batchId?: string }
export interface ExecutorRef {
  featureId: string; taskId: string; fence: V2Fence; claimFence: V2Fence | null;
  /** X0's fence has no leaseId. S2F supplies this from S2R's trusted lease context; absence holds the card. */
  leaseIdOf?(fence: V2Fence): string | null;
}
type EventRef = { project: string; target: string; kind: EventKind; data?: Record<string, unknown> };
type Scope = { kind: "projection"; ref: ProjectionRef }
  | { kind: "executor"; ref: { featureId: string; taskId: string; fence: ExecutorFence; claimFence: ExecutorFence | null }; stale: boolean };
const scopes = new WeakMap<Database, Scope>();
const active = new WeakSet<Database>(), passive = new WeakSet<Database>();
const projected = new WeakMap<Database, Map<string, string>>();
const modeDir = (db: Database): string => db.filename === ":memory:" || !db.filename ? STATE_DIR : dirname(db.filename);
const hasModes = (db: Database): boolean => existsSync(join(modeDir(db), "shared-ledger-modes.json"));
const forbidden = (text: string): never => { throw new LedgerError("forbidden", text); };
function mode(db: Database, featureId: string) {
  try { return readSharedLedgerMode(featureId, modeDir(db)); }
  catch { return forbidden("共享执行状态无法核验"); } // Unreadable authority never falls back to a local write grant.
}
function synchronous<T>(fn: () => T): T {
  const result = fn();
  if (result && typeof (result as { then?: unknown }).then === "function") forbidden("写令牌只支持同步事务");
  return result;
}

/** Called inside the existing IMMEDIATE transaction, so the old ownership and authority check share its writer lock. */
export function withLocalWriteGate<T>(db: Database, fn: () => T): T {
  if (active.has(db) || (passive.has(db) && !scopes.has(db))) return synchronous(fn);
  // Mode publication uses this same writer lock: a missing file cannot turn into execution during an admitted local write.
  if (!scopes.has(db) && !hasModes(db)) return synchronous(fn);
  if (!scopes.has(db)) {
    let protectedWrites: boolean;
    try { protectedWrites = sharedLedgerProtectedWrites(modeDir(db)); }
    catch {
      console.warn("[shared-ledger-write-gate] 模式文件无法核验，回退逐卡授权检查");
      protectedWrites = true;
    } // Corrupt modes disable the shortcut; unshared cards retain local authority.
    if (!protectedWrites) {
      // The mode file cannot change under this writer lock, so events in this transaction skip the per-card lookup too.
      passive.add(db);
      try { return synchronous(fn); } finally { passive.delete(db); }
    }
  }
  beginTracking(db);
  active.add(db);
  projected.set(db, new Map());
  try {
    const result = synchronous(fn);
    const scope = scopes.get(db);
    for (const { id, before, after } of taskChanges(db)) {
      const current = taskJson(after);
      for (const featureId of gateFeatureIds(before)) {
        const m = mode(db, featureId);
        if (m.authorityMode !== "execution" && !m.migrating) continue;
        if ((scope?.kind !== "projection" || scope.ref.featureId !== featureId) && (current === undefined || projected.get(db)?.get(id) !== current)) {
          forbidden("execution / migrating 卡禁止本机写入");
        }
      }
    }
    return result;
  } finally { active.delete(db); projected.delete(db); endTracking(db); }
}

function withScope<T>(db: Database, scope: Scope, fn: () => T): T {
  if (scopes.has(db)) forbidden("写令牌不能嵌套");
  return busyAsLedgerError("执行簿记写入", () => db.transaction(() => {
    scopes.set(db, scope);
    try {
      return withLocalWriteGate(db, () => {
        if (scope.kind === "projection") {
          // The transaction origin (or last admitted projection) is the authority anchor, never the token-entry row.
          for (const { id, before, after } of taskChanges(db)) {
            if ([...gateFeatureIds(before), ...gateFeatureIds(after)].includes(scope.ref.featureId)
              && projected.get(db)?.get(id) !== taskJson(after)) forbidden("投影令牌前已有本机改动");
          }
        }
        const mark = markTracked(db);
        const result = synchronous(fn);
        if (scope.kind === "projection") {
          for (const { id, after } of taskChanges(db, mark)) {
            const ids = gateFeatureIds(after);
            if (ids.length && ids.every(featureId => featureId === scope.ref.featureId)) projected.get(db)?.set(id, taskJson(after)!);
          }
        } else assertExecutorChanges(db, mark, scope.ref.taskId, scope.stale);
        return result;
      });
    }
    finally { scopes.delete(db); }
  }).immediate());
}

/** Events are append-only, so a cached maximum stays valid while the event it last scanned still exists unchanged;
 * a rolled-back scan loses that witness and the next call rescans. Otherwise only events after the witness are read (seq PK range). */
const centerSeqs = new WeakMap<Database, Map<string, { seq: number; witness: string; centerSeq: number }>>();
function priorCenterSeq(db: Database, featureId: string): number {
  const cache = centerSeqs.get(db) ?? new Map(), hit = cache.get(featureId);
  const still = hit && (db.query("SELECT json_array(ts, actor, target, kind, data) AS w FROM events WHERE seq=?").get(hit.seq) as { w: string } | null)?.w === hit.witness;
  const from = still ? hit!.seq : 0;
  const scan = db.query(`SELECT COALESCE(MAX(CAST(json_extract(data, '$.centerSeq') AS INTEGER)), 0) AS centerSeq FROM events
    WHERE seq > ? AND actor=? AND json_extract(data, '$.featureId')=?`).get(from, PROJECTION_ACTOR, featureId) as { centerSeq: number };
  const last = db.query("SELECT seq, json_array(ts, actor, target, kind, data) AS w FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; w: string } | null;
  const centerSeq = Math.max(still ? hit!.centerSeq : 0, scan.centerSeq);
  if (last) { cache.set(featureId, { seq: last.seq, witness: last.w, centerSeq }); centerSeqs.set(db, cache); }
  return centerSeq;
}

export function withProjectionScope<T>(db: Database, ref: ProjectionRef, fn: () => T): T {
  return busyAsLedgerError("投影写入", () => db.transaction(() => {
    const m = mode(db, ref.featureId);
    if (m.migrating ? ref.batchId !== m.migrating.batchId : m.authorityMode !== "execution" || !m.centerExecution) {
      forbidden("投影不属于当前 execution / migrating 批次");
    }
    if (!Number.isSafeInteger(ref.centerSeq) || ref.centerSeq <= priorCenterSeq(db, ref.featureId)) forbidden("投影 centerSeq 必须递增");
    return withScope(db, { kind: "projection", ref: { ...ref } }, fn);
  }).immediate());
}

function validFence(fence: V2Fence | null): fence is V2Fence {
  if (!fence) return false;
  try { parseFence({ serviceGeneration: fence.serviceGeneration, epoch: fence.epoch, bootId: fence.bootId }); return true; }
  catch { return false; } // Invalid trusted-context input cannot grant execution rights.
}
function executionFence(ref: ExecutorRef, fence: V2Fence): ExecutorFence {
  const leaseId = ref.leaseIdOf?.(fence);
  if (typeof leaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(leaseId)) {
    throw new LedgerError("conflict", "v2_unmapped: 缺少可信主场 leaseId 方法");
  }
  return { serviceGeneration: fence.serviceGeneration, epoch: fence.epoch, bootId: fence.bootId, leaseId };
}
export function withExecutorScope<T>(db: Database, ref: ExecutorRef, fn: () => T): T {
  if (!validFence(ref.fence)) forbidden("执行令牌缺少主场 fence");
  if (ref.claimFence !== null && !validFence(ref.claimFence)) forbidden("认领 fence 无效");
  const frozen = { featureId: ref.featureId, taskId: ref.taskId, fence: executionFence(ref, ref.fence),
    claimFence: ref.claimFence ? executionFence(ref, ref.claimFence) : null };
  const stale = !!frozen.claimFence && Object.keys(frozen.fence).some(key =>
    frozen.claimFence![key as keyof ExecutorFence] !== frozen.fence[key as keyof ExecutorFence]);
  return withScope(db, { kind: "executor", ref: frozen, stale }, () => {
    const task = gateTask(db, frozen.taskId), m = mode(db, frozen.featureId);
    if (!task || !gateFeatureIds(task).includes(frozen.featureId) || m.authorityMode !== "execution" || m.migrating) forbidden("执行令牌与 execution 卡不符");
    return synchronous(fn);
  });
}

function executorData(db: Database, scope: Extract<Scope, { kind: "executor" }>, e: EventRef): Record<string, unknown> {
  if (e.target !== scope.ref.taskId || e.kind !== "scheduler") forbidden("执行令牌只准写本卡调度簿记");
  const data = e.data ?? {}, op = data.op;
  const merge = ["merge", "merge_phase", "merge_resolve"].includes(String(op));
  if (!["plan", "settle", "session_bind", "session_retire"].includes(String(op)) && !merge) forbidden("执行令牌不能写该调度动作");
  const intentId = data.id ?? data.intentId;
  const intent = typeof intentId === "string" ? db.query("SELECT * FROM scheduler_intents WHERE id=?").get(intentId) as Record<string, string> | null : null;
  if (!intent || intent.taskId !== e.target || (merge ? intent.action !== "merge" : !localIntent(intent))) forbidden("执行令牌不能写中心动作意图");
  if (scope.stale && !(op === "settle" && data.from === "submitted" && data.to === "unknown")) rejectStaleClaim();
  return { ...data, fence: { ...scope.ref.fence }, claimFence: scope.ref.claimFence ? { ...scope.ref.claimFence } : null };
}

/** Both pre-write and current associations are checked; an actor string alone never grants projection or execution authority. */
export function gateEventData(db: Database, ctx: WriteCtx, e: EventRef): Record<string, unknown> {
  const scope = scopes.get(db);
  if (ctx.actor === PROJECTION_ACTOR && scope?.kind !== "projection") forbidden("投影身份缺少令牌");
  if (!scope && (passive.has(db) || !hasModes(db))) return e.data ?? {};
  const tasks = [active.has(db) ? originTask(db, e.target) : undefined, gateTask(db, e.target)];
  const featureIds = [...new Set(tasks.flatMap(gateFeatureIds))];
  if (scope?.kind === "projection") {
    if (ctx.actor !== PROJECTION_ACTOR || !featureIds.length || featureIds.some(id => id !== scope.ref.featureId)
      || e.kind !== "task" || e.data?.op !== "center-projection") forbidden("投影令牌与目标卡不符");
    return { ...e.data, centerSeq: scope.ref.centerSeq, featureId: scope.ref.featureId };
  }
  if (scope?.kind === "executor") {
    if (!featureIds.length || featureIds.some(id => id !== scope.ref.featureId)) forbidden("执行令牌与目标 feature 不符");
    return executorData(db, scope, e);
  }
  for (const featureId of featureIds) {
    const m = mode(db, featureId);
    if (m.authorityMode === "execution" || m.migrating) forbidden("execution / migrating 卡禁止本机写入");
  }
  return e.data ?? {};
}

/** Replays also pass the gate, but scoped bookkeeping needs the complete draft at insertEvent rather than this dedup key. */
export function assertLocalWrite(db: Database, ctx: WriteCtx, e: Omit<EventRef, "data">): void {
  if (!scopes.has(db)) gateEventData(db, ctx, e);
}
