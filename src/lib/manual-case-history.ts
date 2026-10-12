/**
 * History of manual episodes (merge-arch-VIEW1, `ledger manual-queue --history-hours N`). Each card's whole event history is replayed
 * through manualEntry (the same entry rule as the live view, so episodeId = entry seq on both sides) and an episode is counted when it
 * was entered inside the window. Ends are kept apart: replaced by a new hold, handed back by workflow_resume (the scheduler's own
 * resume is the only automatic recovery), the card reaching verified / done / cancelled while still manual (a person finished it, not
 * a recovery), and right-truncated (still open now; never in the duration quantiles). Read only. tests/manual-case-history*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { endStages, type LedgerEvent, type TaskKind } from "./ledger-stages.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { manualEntry, type ManualReasonCode } from "./manual-reason.js";

/** The ops manualEntry reads; anything else cannot move an episode. */
const MODE_OPS = new Set(["workflow", "fallback_manual", "workflow_resume", "merge_resolve", "deploy_resolve"]);

type EpisodeEnd = "hold_replaced" | "resumed" | "manual_done" | "truncated";

interface ManualEpisode {
  taskId: string; episodeId: number; code: ManualReasonCode | null; since: number;
  end: EpisodeEnd; endSeq: number | null; endAt: number | null;
  /** resumed by the scheduler identity (automatic recovery); false for a person's resume or any other end */
  auto: boolean;
  durationMin: number | null;
}

/** Nearest-rank percentile; null on an empty sample. */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1];
}

function close(open: ManualEpisode, end: EpisodeEnd, e: LedgerEvent, auto = false): ManualEpisode {
  return { ...open, end, endSeq: e.seq, endAt: e.ts, auto, durationMin: Math.max(0, Math.round((e.ts - open.since) / 60_000)) };
}

/** Every episode of one card, in order; the last one still open is returned truncated. */
function cardEpisodes(taskId: string, kind: TaskKind, events: readonly LedgerEvent[]): ManualEpisode[] {
  const ends = new Set<string>(endStages(kind));
  const out: ManualEpisode[] = [], prefix: LedgerEvent[] = [], finished = new Set<number>();
  let open: ManualEpisode | null = null, stage: string | null = null;
  for (const e of events) {
    if (e.kind === "stage" && typeof e.data.to === "string") {
      stage = e.data.to;
      if (open && ends.has(stage)) { out.push(close(open, "manual_done", e)); finished.add(open.episodeId); open = null; }
      continue;
    }
    if (e.kind !== "scheduler" || !MODE_OPS.has(String(e.data.op))) continue;
    prefix.push(e);
    const cur = manualEntry(prefix), id = cur?.event.seq ?? null;
    if (open && id !== open.episodeId) {
      out.push(id !== null ? close(open, "hold_replaced", e) : close(open, "resumed", e, e.actor === "scheduler"));
      open = null;
    }
    if (cur && !open && !finished.has(cur.event.seq)) {
      open = { taskId, episodeId: cur.event.seq, code: cur.code, since: cur.event.ts, end: "truncated", endSeq: null, endAt: null, auto: false, durationMin: null };
      // entered on a card already at its endpoint: nothing left to handle, closed by a person at entry
      if (stage && ends.has(stage)) { out.push(close(open, "manual_done", e)); finished.add(open.episodeId); open = null; }
    }
  }
  if (open) out.push(open);
  return out;
}

export interface ManualHistory {
  hours: number; from: number; to: number;
  entered: number;
  ended: { total: number; holdReplaced: number; resumed: number; autoResumed: number; manualDone: number };
  truncated: number;
  /** ended episodes only (truncated excluded), minutes, nearest-rank */
  durationMin: { n: number; p50: number | null; p90: number | null };
  byCode: Record<string, number>;
  episodes: ManualEpisode[];
}

/** Episodes entered in (now - hours, now], from the project's full event history. */
export function manualHistory(db: Database, project: string, hours: number, now: number): ManualHistory {
  const from = now - hours * 3_600_000;
  const byTarget = new Map<string, LedgerEvent[]>();
  for (const e of listEvents(db, { project })) if (e.ts <= now) byTarget.set(e.target, [...(byTarget.get(e.target) ?? []), e]);
  const episodes = listTasks(db, project).flatMap((t) => cardEpisodes(t.id, t.kind, byTarget.get(t.id) ?? []))
    .filter((ep) => ep.since > from && ep.since <= now);
  const ended = episodes.filter((ep) => ep.end !== "truncated");
  const count = (end: EpisodeEnd) => episodes.filter((ep) => ep.end === end).length;
  const durations = ended.map((ep) => ep.durationMin!).sort((a, b) => a - b);
  const byCode: Record<string, number> = {};
  for (const ep of episodes) byCode[ep.code ?? "unknown"] = (byCode[ep.code ?? "unknown"] ?? 0) + 1;
  return {
    hours, from, to: now, entered: episodes.length,
    ended: { total: ended.length, holdReplaced: count("hold_replaced"), resumed: count("resumed"), autoResumed: ended.filter((ep) => ep.auto).length,
      manualDone: count("manual_done") },
    truncated: count("truncated"),
    durationMin: { n: durations.length, p50: nearestRank(durations, 50), p90: nearestRank(durations, 90) },
    byCode, episodes,
  };
}
