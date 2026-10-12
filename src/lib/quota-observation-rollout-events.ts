/**
 * One rollout file's rate-limit events, reduced to what a later scan can still need: per selector the
 * newest usable event at or before the clock it was judged at, plus every event still ahead of that clock.
 * Answers match judging the whole event list each time (newestRateLimitEvent); tests/quota-observation-index-prune.test.ts.
 */
import { observationTime } from "./quota-observation.js";

export interface RolloutEvent { rateLimits: Record<string, any>; observedAt: number }
/** Must depend on the limits object alone: its verdict is kept, not recomputed per scan. */
export type RolloutSelector = (limits: unknown) => boolean;

export interface EventLedger {
  /** The clock the events were last judged at; -Infinity until a finite clock arrives. */
  watermark: number;
  /** Newest valid event time at or before the watermark, 0 when there is none. */
  newestPast: number;
  /** Counts only: dropped events still owe their diagnostics. */
  past: number;
  invalid: number;
  best: Map<RolloutSelector, RolloutEvent | null>;
  /** File order, every time after the watermark. */
  future: RolloutEvent[];
}

export function newLedger(now: number, selectors: readonly RolloutSelector[]): EventLedger {
  return { watermark: Number.isFinite(now) ? now : -Infinity, newestPast: 0, past: 0, invalid: 0,
    best: new Map(selectors.map((selector) => [selector, null])), future: [] };
}

function settle(ledger: EventLedger, event: RolloutEvent): void {
  ledger.past++;
  if (event.observedAt > ledger.newestPast) ledger.newestPast = event.observedAt;
  for (const [selector, best] of ledger.best) {
    // Same instant: the later line wins, as when the whole list is walked in file order.
    if ((!best || event.observedAt >= best.observedAt) && selector(event.rateLimits)) ledger.best.set(selector, event);
  }
}

/** Take the next event in file order. */
export function admitEvent(ledger: EventLedger, event: RolloutEvent): void {
  if (!observationTime(event.observedAt, event.observedAt).eligible) ledger.invalid++;
  else if (event.observedAt > ledger.watermark) ledger.future.push(event);
  else settle(ledger, event);
}

/**
 * Dropped events cannot answer this scan: the selector was not tracked when they were read, or the clock
 * moved back before an event already folded into the kept ones. The file has to be read again from zero.
 */
export function ledgerStale(ledger: EventLedger, now: number, selector: RolloutSelector): boolean {
  return !ledger.best.has(selector) || (Number.isFinite(now) && now < ledger.watermark && ledger.newestPast > now);
}

/**
 * Set the clock before new lines are admitted, so an appended line still wins an equal instant. A clock that
 * moved back on a ledger that is not stale leaves every settled event in the past, so only the mark moves.
 */
export function advanceLedger(ledger: EventLedger, now: number): void {
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

/** Newest usable event at `now`; call after advanceLedger on a ledger that is not stale. */
export function judgeLedger(ledger: EventLedger, now: number, selector: RolloutSelector,
  diagnostic: (reason: string) => void): RolloutEvent | null {
  if (!Number.isFinite(now)) {
    // Without a clock no event time can be qualified.
    for (let n = ledger.invalid + ledger.past + ledger.future.length; n > 0; n--) diagnostic("observation_invalid");
    return null;
  }
  for (let n = ledger.future.length; n > 0; n--) diagnostic("observation_future");
  for (let n = ledger.invalid; n > 0; n--) diagnostic("observation_invalid");
  return ledger.best.get(selector) ?? null;
}

/** Distinct events held for the selectors, how many selectors that is, and events still ahead of the clock. */
export function ledgerResidue(ledger: EventLedger): { kept: number; selectors: number; future: number } {
  const kept = new Set([...ledger.best.values()].filter((event) => event !== null));
  return { kept: kept.size, selectors: ledger.best.size, future: ledger.future.length };
}
