/**
 * dispatch-recovery-REVLOCAL1: a review goes to this machine whenever its family has a free seat here, instead of comparing the
 * local running count with the least loaded peer (placeAgentPool's "fewest first, ties to the peer"). Switch: recovery key
 * reviewLocalFirst. on = place here; observe = the placement is unchanged and one would-be record per card and review round is
 * queued; off = unchanged, nothing queued. Writing and fixing, a pinned card, the cross-family choice, a bound reviewer, quota
 * lines and file locks are not read here: placeAgentPool only asks once it has decided "a peer wins although this machine has room".
 * The planner is a read: the would-be record waits in this process's outbox until a caller with a ledger write drains it
 * (drainReviewLocalObserved; recordObserved dedups, so a replayed plan or a restart never records twice).
 * tests/scheduler-agent-pool-review-local*.test.ts.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { ObservedAction, RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import type { PlaceRole, Placement, PlacementFacts } from "./scheduler-placement.js";

const REVIEW_LOCAL_KEY = "reviewLocalFirst";

interface ReviewLocalCard { project: string; task: string; round: number }
interface ReviewLocalPort {
  /** Read only when the switch would change the placement; throwing or an unknown value = off. */
  mode(): RecoveryMode;
  /** The card being placed; absent = nothing is recorded under observe (reserveFinishing's seat simulation). */
  card?: ReviewLocalCard;
}
/** The switch rides on the placement facts, so every path that copies them (retries, peer filters) keeps it. */
export type ReviewLocalFacts = PlacementFacts & { reviewLocal?: ReviewLocalPort };

const OUTBOX_MAX = 500;
const outbox = new Map<string, ObservedAction>();
/** Records already queued or written by this process; the ledger's dedup key is what makes a restart safe. */
const seen = new Set<string>();

function readMode(port: ReviewLocalPort): RecoveryMode {
  try {
    const mode = port.mode();
    return mode === "on" || mode === "observe" ? mode : "off";
  } catch { return "off"; /* A failed policy read never turns the new placement on. */ }
}

/**
 * The facts with the project's switch attached, and the card when task and round are given (no card = a simulation that never
 * records); the policy is read at most once, and only if it matters.
 * The reader is injected: ledger-write reaches placeAgentPool, so a runtime import of recovery-policy.ts here would cycle.
 */
export function reviewLocalFacts<T extends PlacementFacts>(f: T, at: { project: string; task?: string; round?: number },
  policy: RecoveryPolicyPort): T & ReviewLocalFacts {
  let mode: RecoveryMode | undefined;
  const card = at.task !== undefined && at.round !== undefined ? { card: { project: at.project, task: at.task, round: at.round } } : {};
  return { ...f, reviewLocal: { ...card, mode: () => mode ??= policy(at.project, REVIEW_LOCAL_KEY).mode } };
}

function queue(card: ReviewLocalCard, family: AuthorFamily, running: number, total: number, peer: string): void {
  const a: ObservedAction = { project: card.project, mechanism: REVIEW_LOCAL_KEY, target: card.task, actionKey: `review-local:r${card.round}`,
    action: `派本机：${family} 本机在跑 ${running} / 名额 ${total}`, data: { family, running, total, peer, round: card.round } };
  const key = JSON.stringify([a.project, a.target, a.actionKey]);
  if (seen.has(key)) return;
  if (seen.size >= OUTBOX_MAX * 10) seen.clear();
  if (outbox.size >= OUTBOX_MAX) return; // Nobody is draining: drop new records and keep memory constant.
  seen.add(key);
  outbox.set(key, a);
}

/**
 * Called by placeAgentPool at the one point where a peer is about to win although this machine has a free seat of `family`
 * (`running` of its seats taken). A placement = on, send it here; null = keep the peer (off, observe, another role, a pinned card).
 */
export function reviewLocalFirst(f: ReviewLocalFacts, role: PlaceRole, family: AuthorFamily, running: number, peer: string): Placement | null {
  if (role !== "review" || f.pin || !f.reviewLocal) return null;
  const mode = readMode(f.reviewLocal);
  if (mode === "off") return null;
  const total = f.local.pool?.totals[family] ?? f.remote?.agents?.[family] ?? 0;
  if (mode === "on") return { kind: "local", family, reason: `${family} 本机在跑 ${running} / 名额 ${total}，审查本机有空位先派本机` };
  if (f.reviewLocal.card) queue(f.reviewLocal.card, family, running, total, peer);
  return null;
}

/** Would-be records waiting for a writer, oldest first. */
export const reviewLocalPending = (): ObservedAction[] => [...outbox.values()];

/**
 * Hand every waiting record to `observe` (recordObserved, or the scheduler identity's `ledger scheduler-recovery-observe`).
 * A record whose write throws goes back in the queue for the next drain; the rest are still tried. Returns how many were handed over.
 */
export async function drainReviewLocalObserved(observe: (a: ObservedAction) => void | Promise<void>): Promise<number> {
  let done = 0;
  for (const [key, a] of [...outbox]) {
    outbox.delete(key);
    try { await observe(a); done++; }
    catch { if (outbox.size < OUTBOX_MAX) outbox.set(key, a); }
  }
  return done;
}

/** Tests only: forget this process's queue and its already-queued keys. */
export function resetReviewLocalObserved(): void { outbox.clear(); seen.clear(); }
