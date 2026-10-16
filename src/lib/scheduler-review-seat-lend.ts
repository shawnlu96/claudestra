/**
 * REVSEAT1 · a review held on this machine only by its bound local reviewer's continuity (keepsReviewer) is lent to a peer after
 * a 30-minute wait. The window is the card, head, specRev, round and reviewer session; its start is a durable recovery-observe
 * note the tick writes (trackSeatLend), so a restart keeps it and a changed window never matches an old one. The planner reads
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
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import type { Placement } from "./scheduler-placement.js";
import { POOL_RECIPIENT, poolRefusalEpoch } from "./scheduler-pool-plan.js";
import { independentReviewer, keepsReviewer, openRefusal, refusalEpoch } from "./scheduler-review-swap.js";
import { securityReviewLocalOnly } from "./security-pool.js";

export const SEAT_LEND_KEY = "reviewSeatLend";
/** The wait before a pinned review may be lent; the threshold lives here, not in scheduler-config.ts. */
const SEAT_LEND_WAIT_MS = 30 * 60_000;
/** local_full: the pinned local placement waits (plan wait "placement"); reviewer_gone: the bound session row is no longer active. */
type SeatEvidence = "local_full" | "reviewer_gone";

interface SeatWindow { digest: string; head: string; specRev: number; round: number; reviewer: string; reviewerSessionId: string }

/**
 * The window when this review is pinned locally by continuity alone: auto, review stage, an independent local reviewer that
 * keepsReviewer holds, and none of the rules that keep it here for other reasons (security local-only, a private repo's own path,
 * a model safety hold / refusal epoch / pool refusal epoch). null = nothing to relax.
 */
export function seatWindow(s: PlannerSnapshot): SeatWindow | null {
  const r = s.reviewer, head = s.task.headSHA;
  if (s.workflow?.mode !== "auto" || s.task.stage !== "review" || !head || r?.source !== "local" || r.taskId !== s.task.id) return null;
  if (!independentReviewer(s) || !keepsReviewer(s) || securityReviewLocalOnly(s.workflow, s.securityPool) || privateRepoOf(s)) return null;
  if (openRefusal(s.events) || refusalEpoch(s.events, s.task) || poolRefusalEpoch(s)) return null;
  const digest = createHash("sha256").update(JSON.stringify([s.task.id, head, s.task.specRev, s.task.round, r.agent, r.sessionId])).digest("hex").slice(0, 16);
  return { digest, head, specRev: s.task.specRev, round: s.task.round, reviewer: r.agent, reviewerSessionId: r.sessionId };
}

/** This window's notes, written only by the scheduler identity through recordObserved (dedup per key). */
const windowNotes = (events: readonly LedgerEvent[], w: SeatWindow): LedgerEvent[] => events.filter((e) => e.kind === "note" &&
  e.actor === "scheduler" && e.data.op === "recovery_observe" && e.data.mechanism === SEAT_LEND_KEY && e.data.window === w.digest);

/** gen = how many times this window's wait ended (each end restarts the clock); start = the running wait's start note. */
function seatWait(events: readonly LedgerEvent[], w: SeatWindow): { gen: number; start: LedgerEvent | null } {
  const notes = windowNotes(events, w), ends = notes.filter((e) => e.data.seat === "end");
  const after = ends.at(-1)?.seq ?? 0;
  return { gen: ends.length, start: notes.find((e) => e.data.seat === "start" && e.seq > after) ?? null };
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
  placePeers: () => Placement | { peer: string; reason: string } | null): { peer: string; reason: string } | null {
  const due = dueStart(s);
  if (!due || (due.start.data.evidence !== "reviewer_gone" && !localFull())) return null;
  if (recoveryPolicy(s.task.project, SEAT_LEND_KEY).mode !== "on") return null;
  const placed = placePeers();
  if (!placed || ("kind" in placed && placed.kind !== "peer") || !("peer" in placed)) return null;
  const why = due.start.data.evidence === "reviewer_gone" ? "原审查会话已不在" : "本机审查名额满";
  return { peer: placed.peer, reason: `挂池：本机审查员 ${due.w.reviewer} 久等 ${Math.floor(SEAT_LEND_WAIT_MS / 60_000)} 分钟（${why}），` +
    `本轮借审给 ${placed.peer} 的 ${family} worker（${placed.reason}）` };
}

/** The pool_offer event's record of a seat lend (reason, original binding, window start); {} for any other pool offer. */
export function seatLendOffer(s: PlannerSnapshot, recipient: string | null): Record<string, unknown> {
  const due = recipient?.startsWith(POOL_RECIPIENT) ? dueStart(s) : null;
  return due ? { seatLend: { evidence: due.start.data.evidence, reviewer: due.w.reviewer, reviewerSessionId: due.w.reviewerSessionId,
    head: due.w.head, specRev: due.w.specRev, round: due.w.round, startSeq: due.start.seq, since: due.start.ts } } : {};
}

export interface SeatNote { actionKey: string; action: string; data: Record<string, unknown> }

function reviewInFlight(db: Database, taskId: string): boolean {
  return !!db.query(`SELECT 1 FROM scheduler_intents WHERE taskId=? AND action='review' AND status IN ('pending','submitted','unknown')`).get(taskId);
}

/** Verifiable at the tick: the bound reviewer's session row no longer active (whatever the plan), or the plan's own capacity wait. */
function evidenceOf(db: Database, task: LedgerTask, w: SeatWindow, plan: PlannerDecision): SeatEvidence | null {
  const row = db.query(`SELECT state FROM scheduler_sessions WHERE taskId=? AND role='reviewer' AND sessionId=? AND agent=?
    ORDER BY rowid DESC LIMIT 1`).get(task.id, w.reviewerSessionId, w.reviewer) as { state: string } | null;
  if (row?.state !== "active") return "reviewer_gone";
  return plan.kind === "wait" && plan.code === "placement" ? "local_full" : null;
}

/**
 * The tick's side, read-only: the note to record now, if any (scheduler-review-seat-wait.ts writes it through its recovery-observe
 * writer, so this file holds no effect site). It starts the window's clock (one note per window and generation), ends it when its
 * evidence is gone with no review in flight (the next start is a new generation), and once due with no peer taken gives one reason
 * note. Never a PM notice, never a mode change. off = nothing; observe = the same notes plus one would-lend note, and the planner never lends.
 */
export function seatLendNote(db: Database, task: LedgerTask, s: PlannerSnapshot, plan: PlannerDecision,
  ports: { now(): number; recoveryPolicy?: RecoveryPolicyPort }): SeatNote | null {
  const w = seatWindow(s);
  if (!w || reviewInFlight(db, task.id)) return null;
  const mode = (ports.recoveryPolicy ?? recoveryPolicy)(task.project, SEAT_LEND_KEY).mode;
  if (mode === "off" || (plan.kind === "intent" && plan.recipient?.startsWith(POOL_RECIPIENT))) return null; // the lend itself is being planned
  const { gen, start } = seatWait(s.events, w), evidence = evidenceOf(db, task, w, plan);
  const fresh = (actionKey: string) => !getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: SEAT_LEND_KEY, target: task.id, actionKey }));
  const out = (actionKey: string, action: string, data: Record<string, unknown>): SeatNote | null => fresh(actionKey) ? { actionKey, action,
    data: { ...data, window: w.digest, head: w.head, specRev: w.specRev, round: w.round, reviewer: w.reviewer, reviewerSessionId: w.reviewerSessionId } } : null;
  if (!evidence) return start ? out(`seat-end:${w.digest}:g${gen}`, "借审等待结束：本机已能接或等待原因已变，重新计时", { seat: "end" }) : null;
  if (!start) {
    return out(`seat-start:${w.digest}:g${gen}`, `借审等待开始（${evidence}）：满 ${SEAT_LEND_WAIT_MS / 60_000} 分钟后借给合格 peer`, { seat: "start", evidence });
  }
  if (ports.now() - start.ts < SEAT_LEND_WAIT_MS) return null;
  // The code, not the reason: placement reasons name peers, which stay out of the durable note (as reviewSeatIdle's codes).
  const code = plan.kind === "intent" ? plan.action : plan.code, seat = mode === "on" ? "nopeer" : "would";
  return out(`seat-${seat}:${w.digest}:g${gen}`, mode === "on" ? `借审到点但没有合格 peer，保持自动等待（${code}）` : "借审到点（observe：不借）",
    { seat, evidence, code });
}
