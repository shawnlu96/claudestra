import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { currentReviewFacts, type ReviewRead } from "./scheduler-review.js";

/** lend-fix-start.ts FIX_START_MOVED_OP, spelled out here: importing it would close a module cycle through order-take.ts. */
const FIX_START_MOVED_OP = "fix_start_moved";

/**
 * Fix-only finding reader: fix dispatch (fixPackage), the fix strategy and its swap materials, and the local take_order keep the
 * original report across a verified start-move chain. This is never evidence for review or merge (those keep currentReviewFacts).
 */
export function fixStartReviewFacts(task: LedgerTask, events: readonly LedgerEvent[]): ReviewRead {
  const read = currentReviewFacts(task, events);
  if (read.kind === "facts" || task.stage !== "fix") return read;
  const review = events.findLast((e) => e.kind === "review" && e.data.round === task.round);
  if (!review) return read;
  const after = events.filter((e) => e.seq > review.seq);
  if (after.some((e) => e.kind === "deliver")) return read;
  const moves = after.filter((e) => e.kind === "scheduler" && e.data.op === FIX_START_MOVED_OP);
  const from = moves[0]?.data.oldHead;
  if (typeof from !== "string") return read;
  let at = from;
  for (const e of moves) {
    const d = e.data;
    if (e.actor !== "scheduler" || e.target !== task.id || e.project !== task.project || d.round !== task.round || d.specRev !== task.specRev ||
      d.oldHead !== at || typeof d.newHead !== "string" || !/^[0-9a-f]{40}$/.test(d.newHead)) return read;
    at = d.newHead;
  }
  if (at !== task.headSHA) return read;
  return currentReviewFacts({ ...task, headSHA: from }, events);
}
