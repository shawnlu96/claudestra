/**
 * One rollout file's rate-limit events, reduced to what a later scan can still need: the one newest usable event
 * at or before the clock it was judged at, plus every event still ahead of that clock. Other selectors keep only
 * which settled event is their newest (a number); marks keep a small digest of theirs, never the event.
 * Answers match judging the whole event list each time (newestRateLimitEvent); tests/quota-observation-index-prune.test.ts.
 */
import { observationTime } from "./quota-observation.js";

export interface RolloutEvent { rateLimits: Record<string, any>; observedAt: number }
/** Must depend on the limits object alone: its verdict is kept, not recomputed per scan. */
export type RolloutSelector = (limits: unknown) => boolean;
/**
 * A fact digested from one event's limits, null when the event does not carry it. Must depend on the limits alone
 * and return a few scalars, not the limits: the digest of the newest carrier outlives the event it came from.
 */
export type RolloutMark = (limits: unknown) => unknown;
export interface MarkHit { observedAt: number; value: unknown }
/** What a scan asks of a file: the newest event for `selector`, or with `mark` the newest digest of that mark. */
export interface RolloutAsk { selector: RolloutSelector; mark?: RolloutMark }

/** A settled event by the order it was settled in; the event itself is gone unless it is the kept one. */
interface Settled { observedAt: number; id: number }

export interface EventLedger {
  /** The clock the events were last judged at; -Infinity until a finite clock arrives. */
  watermark: number;
  /** Newest valid event time at or before the watermark, 0 when there is none. */
  newestPast: number;
  /** Counts only: dropped events still owe their diagnostics. */
  past: number;
  invalid: number;
  /** The selector the kept event follows: the one the latest scan asked for. */
  primary: RolloutSelector;
  /** The only settled event held: the newest for `primary` since it became primary. */
  kept: RolloutEvent | null;
  keptId: number;
  newest: Map<RolloutSelector, Settled | null>;
  marks: Map<RolloutMark, MarkHit | null>;
  /** File order, every time after the watermark. */
  future: RolloutEvent[];
}

export function newLedger(now: number, primary: RolloutSelector, selectors: readonly RolloutSelector[],
  marks: readonly RolloutMark[]): EventLedger {
  return { watermark: Number.isFinite(now) ? now : -Infinity, newestPast: 0, past: 0, invalid: 0, primary, kept: null, keptId: 0,
    newest: new Map([primary, ...selectors].map((selector) => [selector, null])),
    marks: new Map(marks.map((mark) => [mark, null])), future: [] };
}

function settle(ledger: EventLedger, event: RolloutEvent): void {
  const id = ++ledger.past;
  if (event.observedAt > ledger.newestPast) ledger.newestPast = event.observedAt;
  // Same instant: the later line wins, as when the whole list is walked in file order.
  for (const [selector, best] of ledger.newest) {
    if ((best && event.observedAt < best.observedAt) || !selector(event.rateLimits)) continue;
    ledger.newest.set(selector, { observedAt: event.observedAt, id });
    if (selector === ledger.primary) { ledger.kept = event; ledger.keptId = id; }
  }
  for (const [mark, best] of ledger.marks) {
    if (best && event.observedAt < best.observedAt) continue;
    const value = mark(event.rateLimits);
    if (value !== null && value !== undefined) ledger.marks.set(mark, { observedAt: event.observedAt, value });
  }
}

/** Take the next event in file order. */
export function admitEvent(ledger: EventLedger, event: RolloutEvent): void {
  if (!observationTime(event.observedAt, event.observedAt).eligible) ledger.invalid++;
  else if (event.observedAt > ledger.watermark) ledger.future.push(event);
  else settle(ledger, event);
}

/**
 * Dropped events cannot answer this scan: the selector or mark was not tracked when they were read, the selector's
 * newest event is not the kept one, or the clock moved back before an event already folded in. The file has to be
 * read again from zero.
 */
export function ledgerStale(ledger: EventLedger, now: number, ask: RolloutAsk): boolean {
  if (!ledger.newest.has(ask.selector) || (ask.mark && !ledger.marks.has(ask.mark))) return true;
  if (Number.isFinite(now) && now < ledger.watermark && ledger.newestPast > now) return true;
  const newest = ledger.newest.get(ask.selector);
  return !!newest && newest.id !== ledger.keptId;
}

/**
 * Set the clock and the selector the kept event follows before new lines are admitted, so an appended line still
 * wins an equal instant. Call on a ledger that is not stale: the kept event is then already that selector's newest,
 * and a clock that moved back leaves every settled event in the past, so only the mark moves.
 */
export function advanceLedger(ledger: EventLedger, now: number, primary: RolloutSelector): void {
  ledger.primary = primary;
  if (!Number.isFinite(now)) return;
  const forward = now > ledger.watermark;
  ledger.watermark = now;
  if (!forward || !ledger.future.length) return;
  const ahead: RolloutEvent[] = [];
  for (const event of ledger.future) {
    if (event.observedAt > now) ahead.push(event);
    else settle(ledger, event);
  }
  ledger.future = ahead;
}

/** Diagnostics owed by every event that does not qualify at `now`; false when no event can qualify. */
function qualify(ledger: EventLedger, now: number, diagnostic: (reason: string) => void): boolean {
  if (!Number.isFinite(now)) {
    // Without a clock no event time can be qualified.
    for (let n = ledger.invalid + ledger.past + ledger.future.length; n > 0; n--) diagnostic("observation_invalid");
    return false;
  }
  for (let n = ledger.future.length; n > 0; n--) diagnostic("observation_future");
  for (let n = ledger.invalid; n > 0; n--) diagnostic("observation_invalid");
  return true;
}

/** Newest usable event at `now`; call after advanceLedger with the same selector on a ledger that is not stale. */
export function judgeLedger(ledger: EventLedger, now: number, selector: RolloutSelector,
  diagnostic: (reason: string) => void): RolloutEvent | null {
  if (!qualify(ledger, now, diagnostic)) return null;
  return ledger.newest.get(selector) ? ledger.kept : null;
}

/** Digest of the newest event at `now` that carries the mark; same preconditions as judgeLedger. */
export function judgeMark(ledger: EventLedger, now: number, mark: RolloutMark, diagnostic: (reason: string) => void): MarkHit | null {
  return qualify(ledger, now, diagnostic) ? ledger.marks.get(mark) ?? null : null;
}

/** Settled events held (0 or 1), events still ahead of the clock, and the mark digests held in place of events. */
export function ledgerResidue(ledger: EventLedger): { kept: number; future: number; marks: number } {
  return { kept: ledger.kept ? 1 : 0, future: ledger.future.length, marks: [...ledger.marks.values()].filter(Boolean).length };
}
