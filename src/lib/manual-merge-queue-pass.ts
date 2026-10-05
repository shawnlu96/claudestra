/**
 * The pass side of the manual merge queue (manual-merge-queue.ts): the policy is read through CFG's RecoveryPolicyPort right
 * before each use (a throw = off), the train file through the pass's store. `blocks` feeds trainProjects at the top of the pass
 * (on only: observe never holds a train back); `formFence` is the train tick's save of a new train: the queue is decided again in
 * the same ledger snapshot, synchronously followed by the save (no await between), so a request committed before that snapshot
 * stops the formation and one committed after it queues behind a train that already exists; `claim` runs between reclaimLentSlots
 * and the auto tick and goes through the scheduler's guarded ledger child (`manual-merge-claim`), so the claim is one more write
 * under the pass's maintenance lease.
 */
import type { Database } from "bun:sqlite";
import { blocksTrain, listOpenRequests, manualTurn, trainSignal } from "./manual-merge-queue.js";
import { manualQueueMode } from "./manual-merge-queue-facts.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/** Thrown by formFence: the train is not saved (nothing external was done for it yet), the queue head goes first. */
class TrainFormFenced extends Error {}

export function manualMergeGate(db: Database, store: TrainStore | null | undefined, policy: RecoveryPolicyPort = recoveryPolicy) {
  const trains = store === undefined ? defaultTrainStore() : store;
  return {
    /** Whether the queue head (due) or its run (active) keeps a new train from forming in this project this pass. */
    blocks(project: string): boolean {
      if (manualQueueMode(project, policy) !== "on") return false;
      // one read transaction: manualTurn's several reads see one ledger state
      return db.transaction(() => blocksTrain(manualTurn(db, project, trainSignal(trains, project, Date.now()), Date.now())))();
    },
    /**
     * Saves a newly formed train only if the queue still lets it form, decided in one ledger snapshot right before the save.
     * The pass's connection is query_only (it cannot take the write lock), so the order is the ledger's commit order: requests
     * write under BEGIN IMMEDIATE, and this snapshot either contains a request (no train) or precedes it (the train is formed
     * first and the request waits for it, at most this one train). A refusal throws TrainFormFenced and saves nothing.
     */
    formFence(project: string, save: () => void): void {
      db.transaction(() => {
        if (manualQueueMode(project, policy) === "on" && blocksTrain(manualTurn(db, project, "none", Date.now()))) {
          throw new TrainFormFenced(`${project} 人工合并队首已到期，本轮不组新车`);
        }
        save();
      })();
    },
    /** At most one claim per project; a lost race (conflict / busy) waits for the next pass, anything else is reported. */
    async claim(manager: Manager, config: SchedulerConfig): Promise<{ claimed: string[]; failed: { taskId: string; error: string }[] }> {
      const out = { claimed: [] as string[], failed: [] as { taskId: string; error: string }[] };
      for (const [project, cfg] of Object.entries(config.projects)) {
        if (!listOpenRequests(db, project).length) continue;
        const mode = manualQueueMode(project, policy);
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
