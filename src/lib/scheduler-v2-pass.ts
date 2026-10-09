import type { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { LedgerReader } from "./ledger-read.js";
import { getTask } from "./ledger-store.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { readSharedLedgerMode, type SharedLedgerMode } from "./shared-ledger-mode.js";
import type { passPace, TickPace } from "./scheduler-yield.js";

export type SchedulerV2Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export type SchedulerV2Route = "local" | "skip" | "central";
export type SchedulerV2Switch = "off" | "observe" | "on";
export type SchedulerV2FeatureMode = SharedLedgerMode & { migrating?: { batchId: string; kind: "execute" | "revert" | "home" } };

export interface SchedulerV2PassPort {
  /** S2F supplies S2S's effective switch, including release expiry / revocation. */
  mode(project: string): SchedulerV2Switch;
  wrapManager(manager: SchedulerV2Manager): SchedulerV2Manager;
}

let port: SchedulerV2PassPort | null = null;
const reader = new LedgerReader();
const logged = new Set<string>();

export function configureSchedulerV2Pass(next: SchedulerV2PassPort | null): void {
  port = next;
  reader.close();
  logged.clear();
}

function report(id: string, reason: string, level: "info" | "error"): void {
  const key = `${id}:${reason}`;
  if (logged.has(key)) return;
  logged.add(key);
  console[level](`[scheduler-v2 ${reason}] ${id}: skip`);
}

function routeFeature(featureId: string, project: string, db: Database, id: string): SchedulerV2Route {
  try {
    const feature = readSharedLedgerMode(featureId, dirname(db.filename)) as SchedulerV2FeatureMode;
    if (feature.migrating) return "skip";
    if (feature.authorityMode !== "execution") return "local";
    const mode = port?.mode(project) ?? "off";
    if (mode === "on") return "central";
    if (mode === "observe") report(id, "observe", "info");
    else if (!port) report(id, "unavailable", "info");
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    // A broken mode/switch holds only feature-bound candidates; unrelated local cards can still run this pass.
    report(id, "mode/switch unreadable", "error");
  }
  return "skip";
}

/** The feature freeze outranks every switch; execution never falls back to local writes. */
export function schedulerV2Route(taskId: string, db: Database | null = reader.get()): SchedulerV2Route {
  const task = db && getTask(db, taskId);
  const featureId = task?.featureId ?? task?.extra.sharedFeatureId;
  return task && typeof featureId === "string" ? routeFeature(featureId, task.project, db!, taskId) : "local";
}

/** Keep the maintenance guard outside this wrapper and leaseAware inside it. */
export function schedulerV2PassManager(manager: SchedulerV2Manager): SchedulerV2Manager {
  return port ? port.wrapManager(manager) : manager;
}

/** Candidate loops share the pass's pacing port, so eligibility can be checked before any per-card effect. */
export function schedulerV2PassPace(db: Database | null, pace: ReturnType<typeof passPace>): ReturnType<typeof passPace> {
  logged.clear(); // Deduplicate diagnostics within the pass, never route decisions: revocation must be seen on the next check.
  return { phase: (): TickPace => ({ ...pace.phase(), skipTask: (taskId) => schedulerV2Route(taskId, db) === "skip" }) };
}
