/**
 * dispatch-recovery-RVWT1 · the one rule for a reviewer's own worktree, shared by the side that creates it and the side that pins
 * it before each dispatch. A per-card reviewer lives in `rv-<task>`; a formal replacement keeps its own directory apart from the
 * retired session it replaces (which may still be running): `-ex` under a model-refusal epoch, `-re` after a legacy retirement,
 * none after a plain family swap. Which one is read from the ledger — the current reviewer binding, the ensure_session that created
 * it and the latest reviewer_swap it followed — never from the agent's name, its registry cwd or which directories exist.
 * Authorization (approval, materials, epoch lapse) stays with refusalEpochLapse and the tick's own re-checks.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { getIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { latestReviewerSwap, refusalEpoch } from "./scheduler-review-swap.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import type { SessionRef } from "./worker-session.js";

export type ReplacementTag = "" | "-ex" | "-re";

/** The replacement's tag, from the reviewer_swap event it follows: refusal epoch → -ex, legacy retirement → -re, family swap → none. */
export const replacementTag = (swap: LedgerEvent): ReplacementTag => swap.data.refusal ? "-ex" : swap.data.legacy === true ? "-re" : "";

export const reviewCheckoutDir = (root: string, taskId: string, tag: ReplacementTag = ""): string => join(root, `rv-${taskId.toLowerCase()}${tag}`);

/**
 * The directory the bound reviewer `ref` must already live in. A ref other than the card's active reviewer binding gets no path;
 * with no active binding at all, or one not created by an ensure_session after the latest reviewer_swap, it is the ordinary
 * `rv-<task>` (unchanged rule). A replacement binding gets its swap's directory; a refusal one only while that epoch still rules
 * the card's head / spec / round — otherwise no path at all (never a fallback to another directory).
 */
export function boundReviewCheckout(db: Database, task: LedgerTask, ref: SessionRef, root: string): { dir: string } | { manual: string } {
  const ordinary = { dir: reviewCheckoutDir(root, task.id) };
  const b = getSchedulerSession(db, task.id, "reviewer");
  if (!b || b.state !== "active") return ordinary; // no current binding (direct callers): the ordinary rule alone, never a replacement's
  if (b.taskId !== task.id || ref.taskId !== task.id || ref.role !== "reviewer" || b.agent !== ref.agent || b.sessionId !== ref.sessionId ||
    b.family !== ref.family) return { manual: `${ref.agent}（${ref.sessionId}）不是本卡当前正式审查绑定 ${b.agent}（${b.sessionId}），不派审` };
  const events = listEvents(db, { project: task.project, target: task.id }), swap = latestReviewerSwap(events);
  const created = getIntent(db, b.createIntentId);
  if (!swap || !created || created.taskId !== task.id || created.action !== "ensure_session" || created.node !== "adversarial_review" ||
    created.eventSeq <= swap.seq) return ordinary;
  const tag = replacementTag(swap);
  if (tag === "-ex" && refusalEpoch(events, task)?.seq !== swap.seq) {
    return { manual: `${ref.agent} 的拒审替代来源已不是本卡当前 head/规格/轮次的，不派审` };
  }
  return { dir: reviewCheckoutDir(root, task.id, tag) };
}
