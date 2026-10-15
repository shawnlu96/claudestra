/**
 * PRIO2: one ordering for every queue where candidates compete for the same slot (author / review dispatch, local or lent
 * seats, autostart, manual vs auto merge, the next train's boarding). The owner's work band (now → next → later) leads; inside a
 * band the owner's explicit order, then the caller's existing order (finish-first, merge-first, rotation, fairness) stays as is.
 *
 * The switch is `prioritySort` per project (ledger-priority-*): off = the caller's order, nothing read or written beyond the mode;
 * observe = the caller's order is what runs, the new order is only recorded (scheduler-priority-order-record.ts); on = the new order
 * runs. Machine placement (localPriority / lend priority) is not this module's concern. Callers never compare bands themselves.
 */
import type { Database } from "bun:sqlite";
import { readPriority, readPriorityModes } from "./ledger-priority-read.js";
import { PRIORITY_BANDS, type PriorityBand, type PriorityMode } from "./ledger-priority-types.js";
import { recordPrioritySort } from "./scheduler-priority-order-record.js";

/** The competing entries; each records under its own name so PM can check that all of them are covered. */
export type PrioritySortEntry = "author" | "review" | "local_slot" | "lend_slot" | "autostart" | "manual_merge" | "merge_contest"
  | "train_boarding";

/** What the module needs to know about one candidate. taskId null = no work identity: system default `next`, never registered. */
export interface PriorityKey { project: string; taskId: string | null }

/** A band as read right now. `order` is the owner's explicit place inside the band (null = not listed). */
interface PriorityRank { band: PriorityBand; source: string; rev: number; order: number | null }

/** Reads stay injectable for tests; the default reads the ledger fresh on every call (no snapshot outlives one sort). */
export interface PriorityReader {
  mode(project: string): PriorityMode;
  rank(project: string, taskId: string | null, queue: string): PriorityRank;
}

const SYSTEM: PriorityRank = { band: "next", source: "system", rev: 0, order: null };

function ledgerPriorityReader(db: Database): PriorityReader {
  return {
    mode(project) {
      try {
        const m = readPriorityModes(db, project).prioritySort as { mode: string } | undefined;
        return m?.mode === "on" || m?.mode === "off" ? m.mode : "observe";
      } catch { return "off"; } // an unreadable switch is no switch: the old order runs
    },
    rank(project, taskId, queue) {
      if (!taskId) return SYSTEM;
      try {
        const v = readPriority(db, project, { kind: "task", id: taskId }, queue);
        return { band: v.effective, source: v.source, rev: v.rev, order: v.order };
      } catch { return { ...SYSTEM, source: "unreadable" }; } // unknown card: system default, never a promotion
    },
  };
}

const bandRank = (b: PriorityBand): number => PRIORITY_BANDS.indexOf(b);

export interface Ranked<T> { item: T; key: PriorityKey; index: number; mode: PriorityMode; rank: PriorityRank | null; pinned: boolean }

/** Band, then the owner's explicit order (listed first). 0 = the owner's ranking cannot tell them apart: the old rules decide. */
function ownerAhead(ra: PriorityRank, rb: PriorityRank): number {
  return bandRank(ra.band) - bandRank(rb.band) || (ra.order ?? Number.MAX_SAFE_INTEGER) - (rb.order ?? Number.MAX_SAFE_INTEGER);
}

/** Pure: the owner's ranking, then the caller's position. Stable by construction. */
function compareRanked<T>(a: Ranked<T>, b: Ranked<T>): number {
  return ownerAhead(a.rank ?? SYSTEM, b.rank ?? SYSTEM) || a.index - b.index;
}

/**
 * Re-fill only the positions held by movable items with those items in priority order; every other item (off project, pinned
 * in-flight work) keeps its exact position. With one project and nothing pinned this is a plain stable sort.
 */
function refill<T>(ranked: readonly Ranked<T>[], movable: (r: Ranked<T>) => boolean): Ranked<T>[] {
  const slots: number[] = [], moving: Ranked<T>[] = [];
  ranked.forEach((r, i) => { if (movable(r)) { slots.push(i); moving.push(r); } });
  moving.sort(compareRanked);
  const out = [...ranked];
  slots.forEach((slot, i) => { out[slot] = moving[i]!; });
  return out;
}

export interface SortOptions<T> {
  /** Owner order scope (priority_orders.queue); defaults to `project`. */
  queue?: string;
  /** Already running / boarded / submitted work: never moved, never preempted. */
  pinned?: (item: T) => boolean;
  reader?: PriorityReader;
  /** Write the observe / on sample (deduplicated). Default true; dry callers (a board view) pass false. */
  record?: boolean;
  now?: number;
}

export interface SortResult<T> {
  /** What the caller must run: the new order where the project is on, the caller's order everywhere else. */
  applied: T[];
  /** The caller's order, untouched. */
  legacy: T[];
  /** The order on would run (observe and on projects sorted). */
  would: T[];
  changed: boolean;
  ranked: Ranked<T>[];
  rankOf(item: T): Ranked<T> | undefined;
}

const movable = (live: (m: PriorityMode) => boolean) => <T>(r: Ranked<T>) => !r.pinned && live(r.mode);

/** Read every project's mode once, every candidate's band fresh; off projects' bands are never read. */
function rankCandidates<T>(reader: PriorityReader, items: readonly T[], keyOf: (item: T) => PriorityKey,
  opts: Pick<SortOptions<T>, "queue" | "pinned"> = {}): Ranked<T>[] {
  const modes = new Map<string, PriorityMode>(), queue = opts.queue ?? "project";
  return items.map((item, index) => {
    const key = keyOf(item);
    if (!modes.has(key.project)) modes.set(key.project, reader.mode(key.project));
    const mode = modes.get(key.project)!;
    return { item, key, index, mode, pinned: opts.pinned?.(item) ?? false,
      rank: mode === "off" ? null : reader.rank(key.project, key.taskId, queue) };
  });
}

/**
 * The single ordering entry. Call it right where the competing list is read; the returned `applied` replaces the list. Under
 * observe `applied` is the caller's list itself (same items, same order), so budgets, cursors and slots keep the old behavior.
 */
export function sortByPriority<T>(db: Database | null, entry: PrioritySortEntry, items: readonly T[], keyOf: (item: T) => PriorityKey,
  opts: SortOptions<T> = {}): SortResult<T> {
  const reader = opts.reader ?? (db ? ledgerPriorityReader(db) : null);
  const legacy = [...items];
  if (!reader || items.length === 0) return passThrough(legacy);
  const ranked = rankCandidates(reader, items, keyOf, opts);
  if (ranked.every((r) => r.mode === "off")) return passThrough(legacy, ranked);
  const on = refill(ranked, movable((m) => m === "on")), would = refill(ranked, movable((m) => m !== "off"));
  const result = finish(legacy, on.map((r) => r.item), would.map((r) => r.item), ranked);
  if (opts.record !== false && db) recordPrioritySort(db, entry, { ranked, would, opts, now: opts.now });
  return result;
}

function passThrough<T>(legacy: T[], ranked: Ranked<T>[] = []): SortResult<T> {
  return finish(legacy, legacy, legacy, ranked);
}

function finish<T>(legacy: T[], applied: T[], would: T[], ranked: Ranked<T>[]): SortResult<T> {
  const by = new Map<T, Ranked<T>>(ranked.map((r) => [r.item, r]));
  return { applied, legacy, would, ranked, changed: would.some((x, i) => x !== legacy[i]), rankOf: (item) => by.get(item) };
}

/**
 * Existing lifts (budget compensation's owed card, a fairness head) keep working, but only where the owner's ranking ties: the
 * lifted item goes to the front of the applied list, except that it never passes an on item of a better band or listed ahead of it
 * by the owner inside the band. Off / observe items lift as before.
 */
export function liftWithinBand<T>(result: SortResult<T>, lifted: T): T[] {
  const list = result.applied.filter((x) => x !== lifted);
  if (list.length === result.applied.length) return result.applied;
  const own = result.rankOf(lifted);
  if (!own || own.mode !== "on" || own.pinned) return [lifted, ...list];
  const better = (x: T) => {
    const r = result.rankOf(x);
    return !!r && r.mode === "on" && !r.pinned && ownerAhead(r.rank ?? SYSTEM, own.rank ?? SYSTEM) < 0;
  };
  let at = 0;
  list.forEach((x, i) => { if (better(x)) at = i + 1; });
  return [...list.slice(0, at), lifted, ...list.slice(at)];
}

export interface Blocked { project: string; taskId: string | null; band: PriorityBand; why: string }
export interface ClaimResult<T> { chosen: T | null; blocked: Blocked[]; legacyChosen: T | null; wouldChosen: T | null; sort: SortResult<T> }

/**
 * Right before a real claim: re-read bands and modes, walk the applied order and hand out the slot to the first item whose
 * existing gates (deps, locks, capacity, permission, review gate) admit it. `gate` returns null to admit or the hold-up text.
 * A blocked item ahead is recorded and the next legal one gets the slot; priority never bypasses a gate.
 */
export function claimFirst<T>(db: Database | null, entry: PrioritySortEntry, items: readonly T[], keyOf: (item: T) => PriorityKey,
  gate: (item: T) => string | null, opts: SortOptions<T> = {}): ClaimResult<T> {
  const sort = sortByPriority(db, entry, items, keyOf, { ...opts, record: false });
  const verdicts = new Map<T, string | null>();
  const why = (x: T) => { if (!verdicts.has(x)) verdicts.set(x, gate(x)); return verdicts.get(x)!; };
  const walk = (list: T[]) => list.find((x) => why(x) === null) ?? null;
  const chosen = walk(sort.applied);
  const legacyChosen = sort.applied === sort.legacy ? chosen : walk(sort.legacy);
  const wouldChosen = walk(sort.would);
  const blocked: Blocked[] = [];
  for (const x of sort.would) {
    if (x === wouldChosen) break;
    const r = sort.rankOf(x), w = why(x);
    if (r?.rank && w !== null) blocked.push({ project: r.key.project, taskId: r.key.taskId, band: r.rank.band, why: w });
  }
  if (opts.record !== false && db && sort.ranked.some((r) => r.mode !== "off")) {
    recordPrioritySort(db, entry, { ranked: sort.ranked, would: refill(sort.ranked, movable((m) => m !== "off")), opts, now: opts.now,
      claim: { legacy: legacyChosen, would: wouldChosen, blocked } });
  }
  return { chosen, blocked, legacyChosen, wouldChosen, sort };
}

type ContestWinner = "manual" | "auto" | "tie";
export interface ContestResult { winner: ContestWinner; would: ContestWinner; manual: PriorityBand | null; auto: PriorityBand | null }

/**
 * Manual request head vs the auto merge candidates for the one merge slot. The owner's ranking (band, then explicit order inside
 * the band) decides; only when it cannot tell the manual head from the best auto candidate (or the project is not on) is it `tie`,
 * and the existing manual/auto fairness (owedToAuto, eventSeq order) decides exactly as before.
 */
export function mergeContest(db: Database | null, project: string, manualTaskId: string | null, autoTaskIds: readonly string[],
  opts: Pick<SortOptions<string>, "reader" | "record" | "now"> = {}): ContestResult {
  const none: ContestResult = { winner: "tie", would: "tie", manual: null, auto: null };
  const reader = opts.reader ?? (db ? ledgerPriorityReader(db) : null);
  if (!reader || !manualTaskId || !autoTaskIds.length) return none;
  const mode = reader.mode(project);
  if (mode === "off") return none;
  const manual = reader.rank(project, manualTaskId, "project");
  const auto = autoTaskIds.map((id) => reader.rank(project, id, "project")).sort(ownerAhead)[0]!;
  const cmp = ownerAhead(manual, auto), would: ContestWinner = cmp < 0 ? "manual" : cmp > 0 ? "auto" : "tie";
  if (opts.record !== false && db) {
    const items = [`manual:${manualTaskId}`, ...autoTaskIds.map((id) => `auto:${id}`)];
    const ranked = rankCandidates(reader, items, (s) => ({ project, taskId: s.slice(s.indexOf(":") + 1) }));
    recordPrioritySort(db, "merge_contest", { ranked, would: refill(ranked, () => true), opts: {}, now: opts.now, contest: would });
  }
  return { winner: mode === "on" ? would : "tie", would, manual: manual.band, auto: auto.band };
}
