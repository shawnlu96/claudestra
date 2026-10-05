/**
 * The pass side of the manual merge queue (manual-merge-queue.ts): the policy is read through CFG's RecoveryPolicyPort right
 * before each use (a throw = off), the train file through the pass's store. `blocks` feeds trainProjects at the top of the pass
 * (on only: observe never holds a train back); `claim` runs between reclaimLentSlots and the auto tick and goes through the
 * scheduler's guarded ledger child (`manual-merge-claim`), so the claim is one more write under the pass's maintenance lease.
 */
import type { Database } from "bun:sqlite";
import { blocksTrain, listOpenRequests, manualTurn, trainSignal } from "./manual-merge-queue.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

function modeOf(policy: RecoveryPolicyPort, project: string): "on" | "observe" | "off" {
  try {
    const m = policy(project, "manualMergeQueue").mode;
    return m === "on" || m === "observe" ? m : "off";
  } catch (e) {
    console.error(`⚠️ [manual-merge] ${project} 读恢复策略失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

export function manualMergeGate(db: Database, store: TrainStore | null | undefined, policy: RecoveryPolicyPort = recoveryPolicy) {
  const trains = store === undefined ? defaultTrainStore() : store;
  return {
    /** Whether the queue head (due) or its run (active) keeps a new train from forming in this project this pass. */
    blocks(project: string): boolean {
      if (modeOf(policy, project) !== "on") return false;
      return blocksTrain(manualTurn(db, project, trainSignal(trains, project, Date.now()), Date.now()));
    },
    /** At most one claim per project; a lost race (conflict / busy) waits for the next pass, anything else is reported. */
    async claim(manager: Manager, config: SchedulerConfig): Promise<{ claimed: string[]; failed: { taskId: string; error: string }[] }> {
      const out = { claimed: [] as string[], failed: [] as { taskId: string; error: string }[] };
      for (const [project, cfg] of Object.entries(config.projects)) {
        if (!listOpenRequests(db, project).length) continue;
        const mode = modeOf(policy, project);
        if (mode === "off") continue;
        const r = await manager("ledger", "manual-merge-claim", project, "--mode", mode, "--train", trainSignal(trains, project, Date.now()),
          "--required-checks", cfg.requiredChecks.join(","));
        if (r.ok === true && r.claimed === true) out.claimed.push(String(r.taskId));
        else if (r.ok !== true && r.code !== "conflict" && r.code !== "busy") {
          out.failed.push({ taskId: `manual-merge ${project}`, error: `人工合并占槽：${String(r.error ?? "manager failed")}` });
        }
      }
      return out;
    },
  };
}
