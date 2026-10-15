/** Machine lock adapter. Deferred is a scheduling outcome: no failed step and no deploy-journal transition. */
import { dirname, join } from "node:path";
import { acquireDeployLock, deployLockPath, holderLiveness, readDeployLock, waitingDeployLabels } from "./pm-deploy-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH, type RecoveryMode } from "./recovery-policy.js";
import { LedgerReader } from "./ledger-read.js";
import { getTask } from "./ledger-store.js";
import type { DeployJob } from "./scheduler-deploy-job.js";
import type { StepsOutcome } from "./scheduler-deploy-steps.js";

export type MachineOutcome = StepsOutcome & { status?: "deferred" };
/** enabled true / false = on / off (kept for callers); mode wins when both are given. */
export interface MachineLockDeps { path?: string; enabled?: boolean; mode?: RecoveryMode; acquireMachine?: typeof acquireDeployLock; waiting?: () => string[] }
const deferredOutcome = (label: string): MachineOutcome => ({ ok: false, status: "deferred",
  summary: `整机部署锁占用：${/^[\w.:-]{1,64}$/.test(label) ? label : "unknown"}`, steps: [], relay: "not_needed", head: null });

function modeFor(job: DeployJob): RecoveryMode {
  const reader = new LedgerReader();
  try {
    const db = reader.get(), project = db && getTask(db, job.taskId)?.project;
    if (!project) return "on";
    return machineLockMode(project);
  } finally { reader.close(); }
}

/** Unconfigured = on (the lock predates the key); a bad file = off; otherwise the configured mode, observe included. */
export function machineLockMode(project: string, path = RECOVERY_POLICY_PATH): RecoveryMode {
  const policy = recoveryPolicy(project, "deployMachineLock", path);
  if (policy.source === "error") return "off";
  const r = readJsonStateSync(path);
  const cfg = r.status === "ok" ? (r.data as { projects?: Record<string, { mode?: string; keys?: Record<string, string> }> }).projects?.[project] : undefined;
  return cfg?.mode === undefined && cfg?.keys?.deployMachineLock === undefined ? "on" : policy.mode;
}
export const machineLockEnabled = (project: string, path = RECOVERY_POLICY_PATH): boolean => machineLockMode(project, path) === "on";

export function machineResult(r: { status?: unknown }): { status?: "deferred" } {
  return r.status === "deferred" ? { status: "deferred" } : {};
}

export async function schedulerMachineLock(job: DeployJob, request: string, deps: MachineLockDeps = {}) {
  const path = deps.path ?? deployLockPath();
  const mode = deps.mode ?? (deps.enabled === undefined ? modeFor(job) : deps.enabled ? "on" : "off"), active = mode === "on";
  const result = active ? await (deps.acquireMachine ?? acquireDeployLock)({ label: "scheduler-deploy", waitMs: 0, path }) : null;
  const append = (sample: Record<string, unknown>) => {
    const file = `${dirname(request)}.machine-events.json`, old = readJsonStateSync(file);
    const events = old.status === "ok" && Array.isArray(old.data) ? old.data : [];
    writeJsonAtomicSync(file, [...events, { ...sample, at: Date.now() }], { mode: 0o600 });
  };
  const record = (status: "acquired" | "deferred", label?: string) => {
    if (active) append({ status, label: label ?? "scheduler-deploy" });
  };
  // observe: never touch the lock; note what on would have done (the scheduler turns these into recovery_observe samples).
  const observe = (would: "acquire" | "defer", label: string) => {
    if (mode !== "observe") return;
    try { append({ status: "observed", would, label: /^[\w.:-]{1,64}$/.test(label) ? label : "unknown" }); }
    catch { console.error("整机部署锁观察样本无法落盘"); }
  };
  const otherLabel = (): string | undefined => {
    const held = readDeployLock(path), waiting = (deps.waiting ?? (() => waitingDeployLabels(path)))().find((l) => l !== "scheduler-deploy");
    // observe keeps a dead holder's lock in place; on would have reaped it, so it is not a reason to defer.
    const reaped = !active && held.status === "ok" && holderLiveness(held.record) === "dead";
    return held.status === "ok" && !reaped && held.record.label !== "scheduler-deploy" ? held.record.label : waiting;
  };
  if (mode === "observe") {
    // Same verdict as acquireDeployLock(waitMs 0), read-only: missing / dead holder = acquire (on would reap); corrupt / live / unknown = defer.
    const held = readDeployLock(path);
    if (held.status === "missing" || held.status === "ok" && holderLiveness(held.record) === "dead") observe("acquire", "scheduler-deploy");
    else observe("defer", held.status === "ok" ? held.record.label : "unknown");
  }
  const blocked = result && result.kind !== "acquired"
    ? deferredOutcome(result.kind === "timeout" ? result.holder?.label ?? "unknown" : "unknown") : null;
  try { record(blocked ? "deferred" : "acquired", blocked?.summary.split("：")[1]); }
  catch {
    if (result?.kind === "acquired") result.handle.release();
    console.error("整机部署锁样本无法落盘，部署延后");
    return { blocked: deferredOutcome("unknown"), release() {}, term: () => null };
  }
  return {
    blocked,
    release: () => { if (result?.kind === "acquired") result.handle.release(); },
    term: (): MachineOutcome | null => {
      if (mode === "off" || Date.now() >= job.createdAt + job.timeoutMs) return null;
      const label = otherLabel();
      if (!label) return null;
      if (!active) { observe("defer", label); return null; }
      try { record("deferred", label); } catch { console.error("整机部署锁 SIGTERM 样本无法落盘"); }
      return deferredOutcome(label);
    },
  };
}
export { runCenterDeployJob, centerWorkerAuthorized } from "./center-deploy-worker.js";
