/** Pass policy/config injection; no decision is cached across a write. */
import type { Database } from "bun:sqlite";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { projectRepo, projectRepoFor } from "./scheduler-foreign-repo.js";
import type { TrainStore } from "./scheduler-merge-train.js";

const MERGE_QUEUE_OWNER_KEY = "mergeQueueOwner";
interface Ports { db?: Database; config: SchedulerConfig; policy: RecoveryPolicyPort; trains: TrainStore | null }
const passes = new Map<string, Ports>();
/** Connections in a test pass share ports; production ledger children read the same config and train files afresh. */
export function openMergeQueueOwner(db: Database, config: SchedulerConfig, policy = recoveryPolicy, trains: TrainStore | null = null): void {
  if (passes.size > 50) passes.clear();
  passes.set(db.filename, { db, config, policy, trains });
}
function ownerMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { return policy(project, MERGE_QUEUE_OWNER_KEY).mode; }
  catch (e) { console.error(`[merge-owner] ${project} 策略不可读，按 off：${String(e)}`); return "off"; }
}
export function ownerPorts(db: Database): Ports {
  return passes.get(db.filename) ?? { config: readSchedulerConfig(), policy: recoveryPolicy, trains: null };
}
export const ownerReadConnection = (db: Database): Database => passes.get(db.filename)?.db ?? db;
export const configuredOwnerMode = (db: Database, project: string): RecoveryMode => ownerMode(project, passes.get(db.filename)?.policy);

/** Missing local ownership mapping retains the legacy path; the pass records this fallback separately. */
export const ownerRepository = (db: Database, project: string): string | null =>
  projectRepo(ownerPorts(db).config.projects[project], { fresh: true }) ?? projectRepoFor(project);
export function queueOwnerMode(db: Database, project: string): RecoveryMode {
  const mode = configuredOwnerMode(db, project);
  return mode === "on" && !ownerRepository(db, project) ? "off" : mode;
}
