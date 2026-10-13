/**
 * Record meta for the body upload (team-project-TEAMVIS10): which ledger event an event / review record came from, when,
 * and for a stage event the stage it moved to, so members can replay the stages. Sent only to a center whose capability
 * says eventMeta; any other center gets exactly the records it got before.
 * - Selection: with meta, stage events without text go up too (a replay misses every stage it is not given).
 * - Backfill: metaSeq (team-body-sync.json, per feature) is how far events went up with meta. With meta the event cursor
 *   is metaSeq, so what went up earlier without it is sent again under the same sourceKey and the center updates the
 *   meta (TEAMVIS9). It rides the pass's record cap and backoff; eventSeq never moves back.
 * tests/team-body-sync-meta.test.ts.
 */
import { EVENT_KINDS, STAGES, type EventKind, type Stage } from "./ledger-stages.js";
import type { TeamBodyEventMeta } from "./shared-ledger-contract-team-body.js";

/** Per-feature state the meta path owns; absent in files written before it, read as 0. */
export interface TeamBodyMetaState { eventSeq: number; metaSeq?: number }

/** The event cursor and the extra selection for one pass. */
export function eventSelection(st: TeamBodyMetaState, withMeta: boolean): { after: number; stageClause: string } {
  return withMeta ? { after: st.metaSeq ?? 0, stageClause: " OR kind = 'stage'" } : { after: st.eventSeq, stageClause: "" };
}

/** Events went up without meta that a center taking meta has not had again. */
export const metaLags = (st: TeamBodyMetaState): boolean => (st.metaSeq ?? 0) < st.eventSeq;

/** Advances the watermarks past `seq`; true when the event had not been handled before (not a backfill resend). */
export function passEvent(st: TeamBodyMetaState, seq: number, withMeta: boolean): boolean {
  const fresh = seq > st.eventSeq;
  st.eventSeq = Math.max(st.eventSeq, seq);
  if (withMeta) st.metaSeq = Math.max(st.metaSeq ?? 0, seq);
  return fresh;
}

const stageOf = (data: string): Stage | undefined => {
  try {
    const to = (JSON.parse(data) as { to?: unknown } | null)?.to;
    return STAGES.includes(to as Stage) ? to as Stage : undefined;
  } catch { return undefined; } // Unreadable data: the stage is unknown and goes without stageTo, never a guess.
};

/** Meta of one ledger event row; undefined when the row's kind or time is outside what the contract carries. */
export function eventMetaOf(row: { kind: string; ts: number; data: string }): TeamBodyEventMeta | undefined {
  if (!EVENT_KINDS.includes(row.kind as EventKind) || !Number.isSafeInteger(row.ts) || row.ts <= 0) return undefined;
  const stageTo = row.kind === "stage" ? stageOf(row.data) : undefined;
  return { kind: row.kind as EventKind, ts: row.ts, ...(stageTo ? { stageTo } : {}) };
}
