import { placeAgentPool } from "./scheduler-agent-pool.js";
/** Local writing capacity is separate from file leases, review sessions and remote writing capacity. */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { peerRefusal, type PlacementFacts } from "./scheduler-placement.js";

const WRITING_STAGES = ["spec", "restate", "build", "fix"];
const LIVE_ORDERS = ["pooled", "claimed", "unknown"];
/** Three machines currently contribute writing capacity. TODO(C8): derive this from eligible lend peers. */
const IN_FLIGHT_MACHINES = 3;

export interface WriteSlotOwner {
  stage: string;
  writeLease: { state: string } | null;
  orders: readonly { step: string; status: string }[];
}

/** Waiting for a local worker to claim still holds its slot; an offered/claimed peer write never does. */
export function shouldHoldWriteSlot(f: WriteSlotOwner): boolean {
  return WRITING_STAGES.includes(f.stage) && f.writeLease?.state !== "held" &&
    !f.orders.some((o) => (o.step === "write" || o.step === "fix") && LIVE_ORDERS.includes(o.status));
}

/** Only review/merge returns may borrow the single extra slot; a blocked fix resuming keeps that provenance. */
export function returnedFix(task: Pick<LedgerTask, "stage" | "specRev">, events: readonly LedgerEvent[]): boolean {
  if (task.stage !== "fix") return false;
  const entry = events.findLast((e) => e.kind === "stage" && e.data.to === "fix" && e.data.from !== "blocked");
  return !!entry && (entry.data.specRev === undefined || entry.data.specRev === task.specRev) &&
    (entry.data.from === "review" || entry.data.from === "merge");
}

/** Existing owners reuse their slot in the planner; this gate is only for a writer acquiring one. */
export function availableWriteSlot(s: Pick<PlannerSnapshot, "task" | "events" | "workerCount" | "maxWorkers" | "freeWorkerSlot" | "heldResources">): string | null {
  if (s.workerCount < s.maxWorkers) return s.freeWorkerSlot;
  if (s.maxWorkers <= 0 || s.workerCount >= s.maxWorkers + 1 || !returnedFix(s.task, s.events)) return null;
  if (s.freeWorkerSlot) return s.freeWorkerSlot;
  const extra = `slot:${s.task.project}:${s.maxWorkers}`;
  return s.heldResources.some((h) => h.resource === extra) ? null : extra;
}

/** A ready local repair takes the next normal vacancy before another new card does. */
export const newLocalWriteRoom = (writers: number, maxWorkers: number, waitingFix: boolean): boolean => writers < maxWorkers && !waitingFix;

/** Shared by the autostart preview and its claim transaction; the in-flight bound applies even with free peers. */
export function newCardCapacity(f: { writers: number; maxWorkers: number; waitingFix: boolean; inFlight: number; placement: PlacementFacts }): string | null {
  if (f.placement.remote?.agents) {
    if (f.waitingFix) return "空位优先留给修复";
    const placed = placeAgentPool(f.placement, "write", "claude");
    return placed.kind === "wait" ? placed.reason : null;
  }
  const limit = f.maxWorkers * IN_FLIGHT_MACHINES;
  if (f.inFlight >= limit) return `自动卡总在途已到上限 maxActiveWorkers × ${IN_FLIGHT_MACHINES}（${limit}，三台机器）`;
  if (f.placement.remote?.localPriority !== "off" && newLocalWriteRoom(f.writers, f.maxWorkers, f.waitingFix)) return null;
  if (f.placement.peers.some((p) => !peerRefusal(f.placement, p, "write", "claude"))) return null;
  if (f.placement.remote?.localPriority === "off") return "本机不写代码（localPriority=off），peer 写单名额已满或不可用";
  return f.waitingFix ? "本机空槽优先留给退回的 fix，且没有当前可接写单的 peer" : `本机写槽已满（maxActiveWorkers ${f.maxWorkers}），且没有当前可接写单的 peer`;
}
