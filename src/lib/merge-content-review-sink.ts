/**
 * merge-arch-REVIEW1 · the merge driver's one hook: after carryOf it hands the carry result here, and the sink the scheduler
 * service injected records it (merge-content-review.ts recordContentCarry through the ledger writer). No sink = nothing recorded.
 * A sink failure is logged and never changes the driver's own carry / refuse path. tests/merge-content-review*.test.ts.
 */
import { mergeContentReviewMode } from "./merge-content-review.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { ReviewCarry } from "./scheduler-merge-driver.js";
export { unsentAware } from "./merge-content-review-read.js"; // the service wraps its merge recheck with it (one import there)

/** What the driver proved for one head move (ReviewCarry plus the run's card and both heads). */
export type ContentCarry = Omit<ReviewCarry, "chain"> & { project: string; taskId: string; oldHead: string; newHead: string;
  chain?: { head: string; previousHead: string; mainParent: string }[] };
type Sink = (carry: ContentCarry) => Promise<void>;
let sink: Sink | null = null;

/** Set by the process that owns the ledger writer; null clears it. */
export function setContentCarrySink(next: Sink | null): void { sink = next; }
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
/** The scheduler service's sink: `ledger scheduler-content-review` under its identity and lease; off never starts the child. */
export const managerContentSink = (manager: Manager, assertActive: () => void = () => {}): Sink => async (carry) => {
  if (mergeContentReviewMode(carry.project) === "off") return;
  assertActive(); // a lost lease stops here, before any ledger child (SchedulerStopped escapes noteContentCarry)
  const r = await manager("ledger", "scheduler-content-review", carry.taskId, "--carry", JSON.stringify({ ...carry, project: undefined, taskId: undefined }));
  if (r.ok !== true) throw new Error(String(r.error ?? "ledger scheduler-content-review 失败"));
};
/** One merge tick's sink (`using` in mergeTick): cleared when the tick ends, so a later driver never writes through a stale manager. */
export function bindContentCarrySink(manager: Manager, assertActive: () => void): Disposable {
  const mine = managerContentSink(manager, assertActive);
  sink = mine;
  return { [Symbol.dispose]: () => { if (sink === mine) sink = null; } };
}

export async function noteContentCarry(run: { project: string; taskId: string; reviewedHead: string }, head: string, carry: ReviewCarry): Promise<void> {
  if (!sink) return;
  try {
    await sink({ ...carry, chain: carry.chain?.map((h) => ({ ...h })), project: run.project, taskId: run.taskId, oldHead: run.reviewedHead, newHead: head });
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // a lost lease / stop still ends the pass
    console.error(`⚠️ 内容身份沿用记录失败（${run.taskId}，不影响合并驱动原路径）：${(e as Error).message.slice(0, 200)}`);
  }
}
