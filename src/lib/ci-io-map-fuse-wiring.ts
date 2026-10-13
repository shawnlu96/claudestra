/**
 * The read map fuse's production wiring (merge-arch-SELECT4): scheduler-merge-train-tick.ts hands it the pass's ledger handle,
 * the train's guarded gh port and its PM notice; the policy and the project's repository are read every time they are asked.
 * A gh port without the fuse's calls (a test fake of the train) gets no hook at all.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { projectRepoFor } from "./scheduler-foreign-repo.js";
import type { CiIoMapFuseGh } from "./ci-io-map-fuse.js";
import { fuseLedger } from "./ci-io-map-fuse-ledger.js";
import { ciIoMapFuseHook, type CiIoMapFuseHook } from "./ci-io-map-fuse-run.js";

const CALLS: readonly (keyof CiIoMapFuseGh)[] = ["ciRun", "headRuns", "attemptJobs", "attemptFailedLog", "jobLog", "planArtifact", "ioMapVar", "lowerIoMapVar"];

export function ciIoMapFuse(db: Database, gh: object, deps: { now(): number; notifyPm(task: LedgerTask, text: string): Promise<void> },
  policy: RecoveryPolicyPort = recoveryPolicy, repoOf: (project: string) => string | null = projectRepoFor): CiIoMapFuseHook | undefined {
  const port = gh as Partial<CiIoMapFuseGh>;
  if (CALLS.some((c) => typeof port[c] !== "function")) return undefined;
  return ciIoMapFuseHook({ gh: port as CiIoMapFuseGh, ledger: fuseLedger(db, deps.now), now: deps.now, projectRepo: repoOf,
    mode: (project) => policy(project, "ciIoMapFuse").mode,
    pm: async (project, members, text) => {
      const task = members.map((id) => getTask(db, id)).find((t) => t?.project === project);
      if (!task) throw new Error("找不到车厢成员的卡，PM 通知没法发");
      await deps.notifyPm(task, text);
    } });
}
