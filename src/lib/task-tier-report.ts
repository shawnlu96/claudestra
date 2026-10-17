/**
 * Read-only, rolling-window tier report. Launch facts supply historical types and actual values; current settings never backfill them.
 * Usage belongs to a unique session, not to every card that references it. Shared sessions stay in their own bucket.
 */
import type { Database } from "bun:sqlite";
import { taskTierLaunchHistory, type LaunchFact } from "./task-tier-launch-events.js";
import { taskTierMode } from "./task-tier-models.js";
import { isAskEvent, type LedgerEvent } from "./ledger-stages.js";
import { listEvents, listTasks } from "./ledger-store.js";

export interface TierUsage { calls: number; input: number; cacheCreation: number; cacheRead: number; output: number; reasoning: number }
export interface TierReportRow {
  tier: string; role: string; family: string; model: string; effort: string;
  cards: string[]; cardCount: number; reviewedCards: number; passedCards: number; passRate: number | null; reworkRounds: number;
  launches: number; failedLaunches: number; pendingLaunches: number; missingUsageSessions: number; unboundLaunches: number;
  sessions: string[]; usage: TierUsage | null;
}
interface SessionUse { sessionId: string; groups: string[]; usage: TierUsage | null }
export interface TierReportOptions {
  now?: number; days?: number; mode?: "on" | "observe" | "off";
  readUsage?: (sessionId: string, start: number, end: number) => TierUsage | null;
  sessionsForCard?: (card: string, start: number, end: number) => string[];
}
const DAY = 86_400_000;
const unknown = "unknown";
const zero = (): TierUsage => ({ calls: 0, input: 0, cacheCreation: 0, cacheRead: 0, output: 0, reasoning: 0 });
const add = (a: TierUsage, b: TierUsage) => { for (const k of Object.keys(a) as (keyof TierUsage)[]) a[k] += b[k]; };
const keyOf = (r: Pick<TierReportRow, "tier" | "role" | "family" | "model" | "effort">) => JSON.stringify([r.tier, r.role, r.family, r.model, r.effort]);

function rowOf(f?: LaunchFact): TierReportRow {
  const actual = f?.actual.source !== "unknown" ? f?.actual : undefined;
  return { tier: f?.plan.tier || unknown, role: f?.plan.role || unknown, family: f?.plan.family || unknown,
    model: actual?.model ?? unknown, effort: actual?.effort ?? unknown,
    cards: [], cardCount: 0, reviewedCards: 0, passedCards: 0, passRate: null, reworkRounds: 0, launches: 0, failedLaunches: 0, pendingLaunches: 0,
    missingUsageSessions: 0, unboundLaunches: 0, sessions: [], usage: null };
}

/** Filter terminal facts by event timestamp too: a binding received after the requested end cannot prove an earlier actual value. */
function factsAt(db: Database, project: string, card: string, events: LedgerEvent[], end: number): LaunchFact[] {
  const seen = new Set<string>();
  return taskTierLaunchHistory(db, project, card).filter(f => {
    if (f.createdAt >= end || seen.has(f.plan.launchId)) return false;
    seen.add(f.plan.launchId); return true;
  }).map(f => {
    const terminal = events.some(e => e.data.launchId === f.plan.launchId && ["bound", "failed"].includes(String(e.data.phase)) && e.ts < end);
    return terminal ? f : { ...f, status: "attempted", sessionId: null, reason: null, actual: { model: null, effort: null, source: "unknown" } };
  });
}

function outcomes(row: TierReportRow, events: LedgerEvent[]): void {
  row.cardCount = row.cards.length;
  for (const card of row.cards) {
    const own = events.filter(e => e.target === card);
    const review = own.findLast(e => e.kind === "review" && ["pass", "changes", "block"].includes(String(e.data.verdict)));
    if (review) { row.reviewedCards++; if (review.data.verdict === "pass") row.passedCards++; }
    row.reworkRounds += own.filter(e => e.kind === "stage" && e.data.to === "fix" && e.data.from !== "blocked").length;
  }
  row.passRate = row.reviewedCards ? row.passedCards / row.reviewedCards : null;
}

function attachSession(row: TierReportRow, key: string, id: string, sessions: Map<string, SessionUse>, usageOf: (id: string) => TierUsage | null): void {
  if (!row.sessions.includes(id)) row.sessions.push(id);
  const s = sessions.get(id) ?? { sessionId: id, groups: [], usage: usageOf(id) };
  if (!s.groups.includes(key)) s.groups.push(key);
  sessions.set(id, s);
}

/** No migrations, ingestion, attribution refresh, observations or ledger writes run on this path. */
export function taskTierReport(db: Database, project: string, options: TierReportOptions = {}) {
  const end = options.now ?? Date.now(), days = options.days ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("days must be an integer from 1 to 365");
  const start = end - days * DAY;
  const all = listEvents(db, { project });
  const inside = all.filter(e => e.ts >= start && e.ts < end && !isAskEvent(e));
  const rows = new Map<string, TierReportRow>(), sessions = new Map<string, SessionUse>();
  const usageCache = new Map<string, TierUsage | null>();
  const usageOf = (id: string) => {
    if (!usageCache.has(id)) usageCache.set(id, options.readUsage?.(id, start, end) ?? null);
    return usageCache.get(id)!;
  };
  const cardIds = new Set<string>();
  for (const task of listTasks(db, project)) {
    const facts = factsAt(db, project, task.id, all, end);
    const historical = options.sessionsForCard?.(task.id, start, end) ?? [];
    let selected = facts.filter(f => f.createdAt >= start || (f.sessionId && usageOf(f.sessionId) !== null));
    const active = inside.some(e => e.target === task.id || (e.data.op === "task_tier_launch" && e.data.card === task.id));
    if (!active && !selected.length && !historical.length) continue;
    // Old sessions still handling window activity retain their recorded values, without inventing a new launch.
    if (!selected.length) selected = facts.filter((f, i) => !facts.slice(i + 1).some(n => n.plan.role === f.plan.role));
    cardIds.add(task.id);
    for (const f of selected.length ? selected : [undefined]) {
      const candidate = rowOf(f), key = keyOf(candidate), row = rows.get(key) ?? candidate;
      rows.set(key, row);
      if (!row.cards.includes(task.id)) row.cards.push(task.id);
      if (f && f.createdAt >= start) {
        row.launches++;
        if (f.status === "failed") row.failedLaunches++;
        if (f.status === "attempted") row.pendingLaunches++;
        if (!f.sessionId) row.unboundLaunches++;
      }
      if (!f?.sessionId) continue;
      attachSession(row, key, f.sessionId, sessions, usageOf);
    }
    // Old usage attribution is evidence of a session link, not evidence of a historical tier, role or model.
    for (const id of historical.filter(id => !selected.some(f => f.sessionId === id))) {
      const candidate = rowOf(), key = keyOf(candidate), row = rows.get(key) ?? candidate;
      rows.set(key, row);
      if (!row.cards.includes(task.id)) row.cards.push(task.id);
      attachSession(row, key, id, sessions, usageOf);
    }
  }
  const totalUsage = zero();
  for (const s of sessions.values()) {
    if (s.usage) add(totalUsage, s.usage);
    for (const key of s.groups) {
      const row = rows.get(key)!;
      if (!s.usage) row.missingUsageSessions++;
      else if (s.groups.length === 1) { row.usage ??= zero(); add(row.usage, s.usage); }
    }
  }
  for (const row of rows.values()) { row.cards.sort(); row.sessions.sort(); outcomes(row, inside); }
  return { ok: true, project, currentMode: options.mode ?? taskTierMode(project).mode,
    window: { start, end, days, bounds: "[start,end)", timezone: "UTC epoch milliseconds; rolling 24-hour days" },
    definitions: {
      cards: "Unique card IDs with non-ask ledger activity, launch activity, or recorded-session usage in the window; each group deduplicates card ID.",
      passRate: "Cards whose last review verdict inside the window is pass / cards with pass, changes or block reviews inside the window; null for zero denominator.",
      reworkRounds: "Transitions into fix inside the window, excluding blocked→fix. Round numbers and reviews outside the window do not add counts.",
      grouping: "Recorded launch tier/role and actual model/effort only; absent historical values stay unknown. Groups overlap: do not sum group card counts or outcomes.",
      launches: "Launch ID deduplication; only attempts inside the window count. Earlier sessions can supply window usage and recorded historical grouping.",
      usage: "Existing local session call details with call timestamp in the window, deduplicated by stored call key and session ID. No ingestion or archive estimates.",
      historicalUsage: "Existing turn attribution links historical sessions; it never supplies a type, role or actual value.",
      sharedUsage: "A session referenced by multiple groups is counted once in totalUsage and sharedSessions, never apportioned in full to each group.",
      missing: "No recorded usage is null, never zero. Unbound launches and missing session usage are separate. Peer usage without session identity is not attributed.",
      interpretation: "Descriptive correlations, not evidence that a model or effort caused pass rates or rework.",
    },
    cards: cardIds.size, rows: [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
    usageSessions: sessions.size, missingUsageSessions: [...sessions.values()].filter(s => !s.usage).length,
    totalUsage: [...sessions.values()].some(s => s.usage) ? totalUsage : null,
    sharedSessions: [...sessions.values()].filter(s => s.groups.length > 1),
  };
}
