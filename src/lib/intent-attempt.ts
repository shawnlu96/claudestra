/**
 * Convergence intent keys (fix-swap / review-swap / arbiter) carry no attempt of their own, so a cancelled plan would pin every
 * later round to its spent key and planIntent's dedup (ledger-scheduler-write.ts) refuses the new causalSeq. Only cancelled
 * attempts count: done ones are kept from repeating by their own events, and live ones by the planner's in-flight guard.
 * n = 0 leaves the key byte-for-byte unchanged; n ≥ 1 appends `:a<n>`. See tests/intent-attempt.test.ts.
 */
import type { SchedulerIntent } from "./ledger-scheduler.js";

export function attemptKey(base: string, taskId: string, intents: readonly Pick<SchedulerIntent, "id" | "taskId" | "status">[]): string {
  const n = intents.filter((i) => i.taskId === taskId && i.status === "cancelled" &&
    (i.id === base || i.id.startsWith(`${base}:a`))).length;
  return n ? `${base}:a${n}` : base;
}

/** The dispute seq of `arbiter:s<born>:d<seq>` with or without its `:a<n>` attempt; any other shape is null (not the pending dispute). */
export function disputeSeqOf(id: string): number | null {
  const m = /^arbiter:s\d+:d(\d+)(?::a\d+)?$/.exec(id);
  return m ? Number(m[1]) : null;
}
