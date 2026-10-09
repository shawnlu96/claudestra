import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { EventKind } from "./ledger-stages.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";
import { readSharedLedgerMode, sharedLedgerProtectedWrites } from "./shared-ledger-mode.js";
import { parseFence, type V2Fence } from "./shared-ledger-contract-v2-validation.js";
import { assertExecutorChanges, executorSnapshot, gateFeatureIds, gateTask, gateTasks, localIntent, rejectStaleClaim, type GateTask } from "./shared-ledger-v2-write-gate-state.js";

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
const originals = new WeakMap<Database, Map<string, GateTask>>();
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
  if (originals.has(db)) return synchronous(fn);
  // Mode publication uses this same writer lock: a missing file cannot turn into execution during an admitted local write.
  if (!scopes.has(db) && !hasModes(db)) return synchronous(fn);
  if (!scopes.has(db)) {
    let protectedWrites: boolean;
    try { protectedWrites = sharedLedgerProtectedWrites(modeDir(db)); }
    catch {
      console.error("[shared-ledger-write-gate] 模式文件无法核验，回退逐卡授权检查");
      protectedWrites = true;
    } // Corrupt modes disable the shortcut; unshared cards retain local authority.
    if (!protectedWrites) return synchronous(fn);
  }
  const before = gateTasks(db);
  originals.set(db, before);
  projected.set(db, new Map());
  try {
    const result = synchronous(fn);
    const scope = scopes.get(db), after = gateTasks(db, true);
    for (const [id, task] of before) {
      const current = JSON.stringify(after.get(id)), changed = JSON.stringify(task) !== current;
      if (!changed) continue;
      for (const featureId of gateFeatureIds(task)) {
        const m = mode(db, featureId);
        if (m.authorityMode !== "execution" && !m.migrating) continue;
        if ((scope?.kind !== "projection" || scope.ref.featureId !== featureId) && (current === undefined || projected.get(db)?.get(id) !== current)) {
          forbidden("execution / migrating 卡禁止本机写入");
        }
      }
    }
    return result;
  } finally { originals.delete(db); projected.delete(db); }
}

function withScope<T>(db: Database, scope: Scope, fn: () => T): T {
  if (scopes.has(db)) forbidden("写令牌不能嵌套");
  return busyAsLedgerError("执行簿记写入", () => db.transaction(() => {
    scopes.set(db, scope);
    try {
      return withLocalWriteGate(db, () => {
        const before = scope.kind === "projection" ? gateTasks(db) : null;
        if (before) {
          // The transaction origin (or last admitted projection) is the authority anchor, never the token-entry row.
          const origin = originals.get(db)!;
          for (const id of new Set([...origin.keys(), ...before.keys()])) {
            const old = origin.get(id), current = before.get(id), encoded = JSON.stringify(current);
            if ([...gateFeatureIds(old), ...gateFeatureIds(current)].includes(scope.ref.featureId)
              && JSON.stringify(old) !== encoded && projected.get(db)?.get(id) !== encoded) forbidden("投影令牌前已有本机改动");
          }
        }
        const result = synchronous(fn);
        if (scope.kind === "projection") {
          for (const [id, task] of gateTasks(db)) {
            if (JSON.stringify(before?.get(id)) !== JSON.stringify(task)
              && gateFeatureIds(task).every(featureId => featureId === scope.ref.featureId)) projected.get(db)?.set(id, JSON.stringify(task));
          }
        }
        return result;
      });
    }
    finally { scopes.delete(db); }
  }).immediate());
}

export function withProjectionScope<T>(db: Database, ref: ProjectionRef, fn: () => T): T {
  return busyAsLedgerError("投影写入", () => db.transaction(() => {
    const m = mode(db, ref.featureId);
    if (m.migrating ? ref.batchId !== m.migrating.batchId : m.authorityMode !== "execution" || !m.centerExecution) {
      forbidden("投影不属于当前 execution / migrating 批次");
    }
    const prior = db.query(`SELECT COALESCE(MAX(CAST(json_extract(data, '$.centerSeq') AS INTEGER)), 0) AS seq FROM events
      WHERE actor=? AND json_extract(data, '$.featureId')=?`).get(PROJECTION_ACTOR, ref.featureId) as { seq: number };
    if (!Number.isSafeInteger(ref.centerSeq) || ref.centerSeq <= prior.seq) forbidden("投影 centerSeq 必须递增");
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
    const error = new LedgerError("forbidden", "v2_unmapped: 缺少可信主场 leaseId 方法");
    Object.defineProperty(error, "code", { value: "v2_unmapped" });
    throw error;
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
    const before = executorSnapshot(db, frozen.taskId);
    const result = synchronous(fn);
    assertExecutorChanges(before, executorSnapshot(db, frozen.taskId), frozen.taskId, stale);
    return result;
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
  if (!scope && !hasModes(db)) return e.data ?? {};
  const tasks = [originals.get(db)?.get(e.target), gateTask(db, e.target)];
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
