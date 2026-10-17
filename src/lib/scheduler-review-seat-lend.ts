/**
 * REVSEAT1 · a review held on this machine only by its bound local reviewer's continuity (keepsReviewer) is lent to a peer after
 * a 30-minute wait. The window is the card, head, specRev, round and reviewer session; its start is a durable recovery-observe
 * note the tick writes (trackSeatLend), so a restart keeps it and a changed window never matches an old one. A start runs only
 * while it is the task's latest seat-lend note's window: another window's note or an end interrupts it for good (A→B→A restarts).
 * A retired reviewer (no longer in the snapshot) is recovered from the binding history (goneWindow) and waits the same threshold. The planner reads
 * that note against the snapshot clock (pool.now) and, for this window only, adds a peers-only placement in front of the pinned
 * local one (seatLendAway; both placement paths call it). No eligible peer = the pinned result exactly as before.
 * The lend is the usual pool review intent: scheduler-pool's offer re-plans it inside its transaction, and its verdict is judged
 * by the existing pool proof (currentPooledReviewer / reviewDispatchProof / poolReviewRefusal). Switch: recovery key reviewSeatLend.
 * tests/scheduler-review-seat-lend.test.ts, tests/scheduler-review-seat-lend-proof.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { privateRepoOf } from "./scheduler-foreign-repo.js";
import type { PlannerDecision, PlannerSnapshot, WorkerRef } from "./scheduler-plan.js";
import type { Placement } from "./scheduler-placement.js";
import { POOL_RECIPIENT, poolRefusalEpoch } from "./scheduler-pool-plan.js";
import { independentReviewer, keepsReviewer, latestReviewerSwap, openRefusal, refusalEpoch } from "./scheduler-review-swap.js";
import { securityReviewLocalOnly } from "./security-pool.js";

export const SEAT_LEND_KEY = "reviewSeatLend";
/** The wait before a pinned review may be lent; the threshold lives here, not in scheduler-config.ts. */
const SEAT_LEND_WAIT_MS = 30 * 60_000;
/** local_full: the pinned local placement waits (plan wait "placement"); reviewer_gone: the bound session row is no longer active. */
type SeatEvidence = "local_full" | "reviewer_gone";

/** gone = recovered from the binding history after the bound reviewer left the snapshot (a retired session). */
interface SeatWindow { digest: string; head: string; specRev: number; round: number; reviewer: string; reviewerSessionId: string; gone?: true }

const windowDigest = (taskId: string, head: string, specRev: number, round: number, agent: string, sessionId: string): string =>
  createHash("sha256").update(JSON.stringify([taskId, head, specRev, round, agent, sessionId])).digest("hex").slice(0, 16);

/** The task's seat-lend notes, written only by the scheduler identity through recordObserved (dedup per key). */
const seatNotes = (events: readonly LedgerEvent[]): LedgerEvent[] => events.filter((e) => e.kind === "note" && e.actor === "scheduler" &&
  e.data.op === "recovery_observe" && e.data.mechanism === SEAT_LEND_KEY && typeof e.data.window === "string");

/** The window whose wait is running: the latest seat-lend note's, unless that note is an end. */
function runningNote(events: readonly LedgerEvent[]): LedgerEvent | null {
  const last = seatNotes(events).at(-1);
  return last && last.data.seat !== "end" ? last : null;
}

/** The rules that keep a review here for reasons other than continuity (security local-only, private repo, refusals). */
const heldOtherwise = (s: PlannerSnapshot): boolean => !!(securityReviewLocalOnly(s.workflow, s.securityPool) || privateRepoOf(s) ||
  openRefusal(s.events) || refusalEpoch(s.events, s.task) || poolRefusalEpoch(s));

/**
 * The window when this review is pinned locally by continuity alone: auto, review stage, an independent local reviewer that
 * keepsReviewer holds, and none of the rules that keep it here for other reasons (security local-only, a private repo's own path,
 * a model safety hold / refusal epoch / pool refusal epoch). null = nothing to relax.
 */
export function seatWindow(s: PlannerSnapshot): SeatWindow | null {
  const r = s.reviewer, head = s.task.headSHA;
  if (s.workflow?.mode !== "auto" || s.task.stage !== "review" || !head || heldOtherwise(s)) return null;
  if (!r) return goneWindow(s, head);
  if (r.source !== "local" || r.taskId !== s.task.id || !independentReviewer(s) || !keepsReviewer(s)) return null;
  const digest = windowDigest(s.task.id, head, s.task.specRev, s.task.round, r.agent, r.sessionId);
  return { digest, head, specRev: s.task.specRev, round: s.task.round, reviewer: r.agent, reviewerSessionId: r.sessionId };
}

/**
 * No reviewer in the snapshot (taskWorkerRefs drops a retired session): the original local reviewer comes from the card's own
 * binding history, independent of any clock — the latest reviewer session_bind (bindSession writes one beside every row), else the
 * latest scheduler seat-lend note whose digest matches its own fields. A reviewer_swap after it released that reviewer on purpose:
 * no window, the unbound route as before. The window is this head / specRev / round's; with no start yet the unbound route waits
 * (seatLendAway) while the tick writes one, so a reviewer gone before the first tick or across a head change still waits 30 minutes.
 */
function goneWindow(s: PlannerSnapshot, head: string): SeatWindow | null {
  const swap = latestReviewerSwap(s.events)?.seq ?? 0, after = s.events.filter((e) => e.seq > swap);
  const bind = after.findLast((e) => e.kind === "scheduler" && e.data.op === "session_bind" && e.data.role === "reviewer")?.data;
  const note = seatNotes(after).findLast((e) => typeof e.data.reviewer === "string" && typeof e.data.reviewerSessionId === "string" &&
    e.data.window === windowDigest(s.task.id, String(e.data.head), Number(e.data.specRev), Number(e.data.round), String(e.data.reviewer),
      String(e.data.reviewerSessionId)))?.data;
  const other: AuthorFamily = s.workflow?.authorFamily === "claude" ? "codex" : "claude";
  const ref = bind ? (bind.transport === "peer" ? null : { agent: bind.agent, sessionId: bind.sessionId, family: bind.family })
    : note ? { agent: note.reviewer, sessionId: note.reviewerSessionId, family: other } : null;
  if (!ref || typeof ref.agent !== "string" || typeof ref.sessionId !== "string") return null;
  const reviewer: WorkerRef = { agent: ref.agent, sessionId: ref.sessionId, taskId: s.task.id, family: ref.family as AuthorFamily, source: "local" };
  if (!independentReviewer({ ...s, reviewer })) return null;
  const digest = windowDigest(s.task.id, head, s.task.specRev, s.task.round, reviewer.agent, reviewer.sessionId);
  return { digest, head, specRev: s.task.specRev, round: s.task.round, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, gone: true };
}

/** gen = how many starts this window has had (each start is a new generation); start = the running wait's start note, if any. */
function seatWait(events: readonly LedgerEvent[], w: SeatWindow): { gen: number; start: LedgerEvent | null } {
  const run = runningNote(events), starts = seatNotes(events).filter((e) => e.data.window === w.digest && e.data.seat === "start");
  const start = run?.data.window === w.digest ? starts.findLast((e) => e.seq <= run.seq) ?? null : null;
  return { gen: starts.length, start };
}

/** The running wait when it has reached the threshold at the snapshot clock; no clock (no pool facts) = never. */
function dueStart(s: PlannerSnapshot): { w: SeatWindow; start: LedgerEvent } | null {
  const w = seatWindow(s), now = s.pool?.now;
  if (!w || now === undefined) return null;
  const { start } = seatWait(s.events, w);
  return start && now - start.ts >= SEAT_LEND_WAIT_MS ? { w, start } : null;
}

/**
 * Both placement paths, in front of their pinned local placement: a peer away for this window, or null to go on exactly as before.
 * localFull = that path's own "the pinned local placement waits" (re-checked here, so a freed seat keeps the review local);
 * placePeers = that path's placement with this machine taken out (family, remote mode, repo grant, capacity, retries all kept).
 */
export function seatLendAway(s: PlannerSnapshot, family: AuthorFamily, localFull: () => boolean,
  placePeers: () => Placement | { peer: string; reason: string } | null): { peer: string; reason: string } | { wait: string; code: string } | null {
  const w = seatWindow(s), due = dueStart(s);
  if ((!due && !w?.gone) || recoveryPolicy(s.task.project, SEAT_LEND_KEY).mode !== "on") return null;
  // A retired reviewer's window not yet due: the unbound route would pool it at once, so it waits unless this machine takes it.
  if (!due) {
    return w?.gone && localFull() ? { wait: `借审等待中：原审查会话 ${w.reviewer} 已不在，满 ${SEAT_LEND_WAIT_MS / 60_000} 分钟后借给合格 peer`,
      code: "placement" } : null;
  }
  if (!w?.gone && due.start.data.evidence !== "reviewer_gone" && !localFull()) return null;
  const placed = placePeers();
  if (!placed || ("kind" in placed && placed.kind !== "peer") || !("peer" in placed)) return null;
  const why = w?.gone || due.start.data.evidence === "reviewer_gone" ? "原审查会话已不在" : "本机审查名额满";
  return { peer: placed.peer, reason: `挂池：本机审查员 ${due.w.reviewer} 久等 ${Math.floor(SEAT_LEND_WAIT_MS / 60_000)} 分钟（${why}），` +
    `本轮借审给 ${placed.peer} 的 ${family} worker（${placed.reason}）` };
}

/** The pool_offer event's record of a seat lend (reason, original binding, window start); {} for any other pool offer. */
export function seatLendOffer(s: PlannerSnapshot, recipient: string | null): Record<string, unknown> {
  const due = recipient?.startsWith(POOL_RECIPIENT) ? dueStart(s) : null;
  return due ? { seatLend: { evidence: due.w.gone ? "reviewer_gone" : due.start.data.evidence, reviewer: due.w.reviewer, reviewerSessionId: due.w.reviewerSessionId,
    head: due.w.head, specRev: due.w.specRev, round: due.w.round, startSeq: due.start.seq, since: due.start.ts } } : {};
}

export interface SeatNote { actionKey: string; action: string; data: Record<string, unknown> }

function reviewInFlight(db: Database, taskId: string): boolean {
  return !!db.query(`SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='review' AND status IN ('pending','submitted','unknown')`).get(taskId);
}

/** Verifiable at the tick: the bound reviewer's session row no longer active (whatever the plan, a retired one too), or the plan's own capacity wait. */
function evidenceOf(db: Database, task: LedgerTask, w: SeatWindow, plan: PlannerDecision): SeatEvidence | null {
  const row = db.query(`SELECT state FROM scheduler_sessions WHERE taskId=? AND role='reviewer' AND sessionId=? AND agent=?
    ORDER BY rowid DESC LIMIT 1`).get(task.id, w.reviewerSessionId, w.reviewer) as { state: string } | null;
  if (row?.state !== "active") return "reviewer_gone";
  return plan.kind === "wait" && plan.code === "placement" ? "local_full" : null;
}

/**
 * The tick's side, read-only: the note to record now, if any (scheduler-review-seat-wait.ts writes it through its recovery-observe
 * writer, so this file holds no effect site). It starts the window's clock (one note per window and generation; a start also
 * interrupts any other window's), ends it when its evidence is gone with no review in flight or when no window applies any more
 * (the next start is a new generation), and once due with no peer taken gives one reason note. Never a PM notice, never a mode
 * change. off = nothing; observe = the same notes plus one would-lend note, and the planner never lends.
 */
export function seatLendNote(db: Database, task: LedgerTask, s: PlannerSnapshot, plan: PlannerDecision,
  ports: { now(): number; recoveryPolicy?: RecoveryPolicyPort }): SeatNote | null {
  const w = seatWindow(s);
  if ((!w && !runningNote(s.events)) || reviewInFlight(db, task.id)) return null;
  const mode = (ports.recoveryPolicy ?? recoveryPolicy)(task.project, SEAT_LEND_KEY).mode;
  if (mode === "off" || (plan.kind === "intent" && plan.recipient?.startsWith(POOL_RECIPIENT))) return null; // the lend itself is being planned
  const fresh = (actionKey: string) => !getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: SEAT_LEND_KEY, target: task.id, actionKey }));
  const binding = (b: SeatWindow | Record<string, unknown>) => ({ window: "digest" in b ? b.digest : b.window, head: b.head, specRev: b.specRev,
    round: b.round, reviewer: b.reviewer, reviewerSessionId: b.reviewerSessionId });
  if (!w) { // no window applies any more (head moved off, stage left, reviewer rebound elsewhere): the running one ends here
    const run = runningNote(s.events);
    const starts = run ? seatNotes(s.events).filter((e) => e.data.window === run.data.window && e.data.seat === "start").length : 0;
    const key = run && `seat-end:${String(run.data.window)}:g${starts - 1}`;
    return run && key && fresh(key) ? { actionKey: key, action: "借审等待结束：窗口已不适用，重新计时", data: { seat: "end", ...binding(run.data) } } : null;
  }
  const { gen, start } = seatWait(s.events, w), evidence = evidenceOf(db, task, w, plan);
  const out = (actionKey: string, action: string, data: Record<string, unknown>): SeatNote | null => fresh(actionKey) ? { actionKey, action,
    data: { ...data, ...binding(w) } } : null;
  if (!evidence) return start ? out(`seat-end:${w.digest}:g${gen - 1}`, "借审等待结束：本机已能接或等待原因已变，重新计时", { seat: "end" }) : null;
  if (!start) {
    return out(`seat-start:${w.digest}:g${gen}`, `借审等待开始（${evidence}）：满 ${SEAT_LEND_WAIT_MS / 60_000} 分钟后借给合格 peer`, { seat: "start", evidence });
  }
  if (ports.now() - start.ts < SEAT_LEND_WAIT_MS) return null;
  // The code, not the reason: placement reasons name peers, which stay out of the durable note (as reviewSeatIdle's codes).
  const code = plan.kind === "intent" ? plan.action : plan.code, seat = mode === "on" ? "nopeer" : "would";
  return out(`seat-${seat}:${w.digest}:g${gen - 1}`, mode === "on" ? `借审到点但没有合格 peer，保持自动等待（${code}）` : "借审到点（observe：不借）",
    { seat, evidence, code });
}
