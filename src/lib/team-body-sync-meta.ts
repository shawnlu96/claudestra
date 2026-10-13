/**
 * Record meta for the body upload (team-project-TEAMVIS10): which ledger event an event / review record came from, when,
 * and for a stage event the stage it moved to, so members can replay the stages. No capability key announces it (old
 * homes parse the capability as a closed object): meta goes by default, and a center that refuses such a batch with 400
 * gets the same batch once more without meta and none for META_REFUSED_MS (team-body-sync.json metaRefused, per origin).
 * - Selection: with meta, stage events without text go up too (a replay misses every stage it is not given); without
 *   meta they stay home, so a center that refused meta gets exactly the records it got before.
 * - Backfill: metaSeq (per feature) is how far events went up with meta. With meta the event cursor is metaSeq, so what
 *   went up without it is sent again under the same sourceKey and the center updates the meta (TEAMVIS9). It rides the
 *   pass's record cap and backoff; eventSeq never moves back.
 * tests/team-body-sync-meta.test.ts.
 */
import { EVENT_KINDS, STAGES, type EventKind, type Stage } from "./ledger-stages.js";
import type { TeamBodyEventMeta, TeamBodyKind, TeamBodyRecord } from "./shared-ledger-contract-team-body.js";

const META_REFUSED_MS = 24 * 3_600_000;

/** Per-feature state the meta path owns; absent in files written before it, read as 0. */
export interface TeamBodyMetaState { eventSeq: number; metaSeq?: number }

/** False while this center origin refused meta lately; a mark further off than META_REFUSED_MS (clock moved back) is spent. */
export function takesMeta(file: { metaRefused?: Record<string, number> }, origin: string, now: number): boolean {
  const until = file.metaRefused?.[origin] ?? 0;
  return !(until > now && until - now <= META_REFUSED_MS);
}
export function refuseMeta(file: { metaRefused?: Record<string, number> }, origin: string, now: number): void {
  file.metaRefused = { ...file.metaRefused, [origin]: now + META_REFUSED_MS };
}

/** The event cursor and the extra selection for one pass. */
export function eventSelection(st: TeamBodyMetaState, withMeta: boolean): { after: number; stageClause: string } {
  return withMeta ? { after: st.metaSeq ?? 0, stageClause: " OR kind = 'stage'" } : { after: st.eventSeq, stageClause: "" };
}

/** Advances the watermarks past `seq`; true when the event had not been handled before (not a backfill resend). */
export function passEvent(st: TeamBodyMetaState, seq: number, withMeta: boolean): boolean {
  const firstTime = seq > st.eventSeq;
  st.eventSeq = Math.max(st.eventSeq, seq);
  if (withMeta) st.metaSeq = Math.max(st.metaSeq ?? 0, seq);
  return firstTime;
}

/**
 * The record as it goes out: as prepared, or without meta when `strip`. Stripped, an event without text (a stage taken
 * only for its meta) does not go at all, as it never did before meta.
 */
export function outgoing(p: { pending: { kind: TeamBodyKind; raw: string }; record: TeamBodyRecord | null }, strip: boolean): TeamBodyRecord | null {
  if (!p.record || !strip) return p.record;
  if (p.pending.kind === "event" && p.pending.raw === "") return null;
  const { meta: _meta, ...plain } = p.record;
  return plain;
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
