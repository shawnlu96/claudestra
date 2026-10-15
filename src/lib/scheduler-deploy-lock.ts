/** Machine lock adapter. Deferred is a scheduling outcome: no failed step and no deploy-journal transition. */
import { dirname, join } from "node:path";
import { acquireDeployLock, deployLockPath, readDeployLock, waitingDeployLabels } from "./pm-deploy-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH } from "./recovery-policy.js";
import { LedgerReader } from "./ledger-read.js";
import { getTask } from "./ledger-store.js";
import type { DeployJob } from "./scheduler-deploy-job.js";
import type { StepsOutcome } from "./scheduler-deploy-steps.js";

export type MachineOutcome = StepsOutcome & { status?: "deferred" };
export interface MachineLockDeps { path?: string; enabled?: boolean; acquireMachine?: typeof acquireDeployLock; waiting?: () => string[] }
const deferredOutcome = (label: string): MachineOutcome => ({ ok: false, status: "deferred",
  summary: `整机部署锁占用：${/^[\w.:-]{1,64}$/.test(label) ? label : "unknown"}`, steps: [], relay: "not_needed", head: null });

function enabledFor(job: DeployJob): boolean {
  const reader = new LedgerReader();
  try {
    const db = reader.get(), project = db && getTask(db, job.taskId)?.project;
    if (!project) return true;
    return machineLockEnabled(project);
  } finally { reader.close(); }
}

export function machineLockEnabled(project: string, path = RECOVERY_POLICY_PATH): boolean {
  const policy = recoveryPolicy(project, "deployMachineLock", path);
  if (policy.source === "error") return false;
  const r = readJsonStateSync(path);
  const cfg = r.status === "ok" ? (r.data as { projects?: Record<string, { mode?: string; keys?: Record<string, string> }> }).projects?.[project] : undefined;
  return cfg?.mode === undefined && cfg?.keys?.deployMachineLock === undefined || policy.mode === "on";
}

export function machineResult(r: { status?: unknown }): { status?: "deferred" } {
  return r.status === "deferred" ? { status: "deferred" } : {};
}

export async function schedulerMachineLock(job: DeployJob, request: string, deps: MachineLockDeps = {}) {
  const path = deps.path ?? deployLockPath(), active = deps.enabled ?? enabledFor(job);
  const result = active ? await (deps.acquireMachine ?? acquireDeployLock)({ label: "scheduler-deploy", waitMs: 0, path }) : null;
  const record = (status: "acquired" | "deferred", label?: string) => {
    if (!active) return;
    const file = `${dirname(request)}.machine-events.json`, old = readJsonStateSync(file);
    const events = old.status === "ok" && Array.isArray(old.data) ? old.data : [];
    writeJsonAtomicSync(file, [...events, { status, label: label ?? "scheduler-deploy", at: Date.now() }], { mode: 0o600 });
  };
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
      if (!active || Date.now() >= job.createdAt + job.timeoutMs) return null;
      const held = readDeployLock(path), waiting = (deps.waiting ?? (() => waitingDeployLabels(path)))().find((l) => l !== "scheduler-deploy");
      const label = held.status === "ok" && held.record.label !== "scheduler-deploy" ? held.record.label : waiting;
      if (!label) return null;
      try { record("deferred", label); } catch { console.error("整机部署锁 SIGTERM 样本无法落盘"); }
      return deferredOutcome(label);
    },
  };
}
export { runCenterDeployJob, centerWorkerAuthorized } from "./center-deploy-worker.js";
