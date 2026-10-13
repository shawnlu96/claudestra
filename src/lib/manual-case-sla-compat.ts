/**
 * merge-arch-SLA1 episode criterion, shared by the batched overdue reminder (manual-case-sla-tick.ts / -write.ts) and the two older
 * per-card stall notices (recovery-manual.ts manualStallTick, ledger-audit-stall.ts manual_stalled). An episode is "taken into a batch"
 * once the leased writer put a claim note on its card for the current entry seq; while manualCaseSla is explicitly on, the older notices
 * skip exactly those episodes. off / observe (the default; a project-wide on does not turn it on) hands every episode back to them, also
 * the ones already claimed / sent / unknown: the claim notes stay, so switching on again never re-sends. Pure over the card's own events
 * plus one policy read, and that read only happens for a card that carries a claim. A claim given back at the send boundary (release
 * note) is no claim. The other direction is legacyStallNotice: an episode an older notice already told the PM about, or is telling
 * right now, is never taken into a batch; the batched reminder asks it at its read, in its claim and again at the send boundary.
 * tests/manual-case-sla*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent } from "./ledger-stages.js";
import { filePolicyPort, type ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { manualEntry } from "./manual-reason.js";
import type { RecoveryKey } from "./recovery-policy.js";

export const MANUAL_CASE_SLA_KEY: RecoveryKey = "manualCaseSla";
/** note on the card: this episode was claimed into batch `batchId` (attempt n) */
export const SLA_CLAIM_OP = "manual_case_sla";
/** project-level note: what became of batch `batchId` (sent / unknown / unsent) */
export const SLA_BATCH_OP = "manual_case_sla_batch";
/** note on the card: the claim of batch `batchId` (attempt n) was given back before anything was sent */
export const SLA_RELEASE_OP = "manual_case_sla_release";
/** An older notice claimed / opened but not yet recorded as delivered counts as on its way for this long (its own first retry delay). */
const LEGACY_IN_FLIGHT_MS = 5 * 60_000;

export type ManualCaseSlaMode = { mode: "on" | "observe" | "off" | "error"; why: string };

/** Only `keys.manualCaseSla: on` is on; off stays off; an unreadable policy is an error (callers do nothing); the rest observes. */
export function manualCaseSlaMode(project: string, port: ExplicitPolicyPort = filePolicyPort()): ManualCaseSlaMode {
  let got: ReturnType<ReturnType<ExplicitPolicyPort>>;
  try { got = port(project)(MANUAL_CASE_SLA_KEY); } catch (e) { return { mode: "error", why: `读恢复策略失败：${(e as Error).message}` }; }
  const { policy, explicit } = got;
  if (policy.source === "error") return { mode: "error", why: policy.diagnostic ?? "恢复策略不可用" };
  if (policy.mode === "off") return { mode: "off", why: `${MANUAL_CASE_SLA_KEY} 是 off` };
  if (explicit === "on") return { mode: "on", why: `${MANUAL_CASE_SLA_KEY} 显式 on` };
  return { mode: "observe", why: policy.mode === "on" ? `${MANUAL_CASE_SLA_KEY} 未显式 on（项目总档 on 不开），按 observe` : `${MANUAL_CASE_SLA_KEY} 是 observe` };
}

export interface SlaClaim { seq: number; ts: number; entrySeq: number; batchId: string; attempt: number; pm: string; dueAt: number; responsible: string; role: string }

function asClaim(e: LedgerEvent): SlaClaim | null {
  const d = e.data;
  if (e.kind !== "note" || e.actor !== "scheduler" || d.op !== SLA_CLAIM_OP || typeof d.entrySeq !== "number" || typeof d.batchId !== "string") return null;
  return { seq: e.seq, ts: e.ts, entrySeq: d.entrySeq, batchId: d.batchId, attempt: typeof d.attempt === "number" ? d.attempt : 1, pm: String(d.pm ?? ""),
    dueAt: typeof d.dueAt === "number" ? d.dueAt : 0, responsible: String(d.responsible ?? ""), role: String(d.role ?? "") };
}

/** The claims on one card's events for one episode, oldest first (attempt n ≥ 2 only follows a batch that definitely was not sent). */
export const slaClaims = (events: readonly LedgerEvent[], entrySeq: number): SlaClaim[] =>
  events.map(asClaim).filter((c): c is SlaClaim => c !== null && c.entrySeq === entrySeq);

/** The claim was given back at the send boundary (definitely nothing sent for it): the episode is open again. */
export const slaReleased = (events: readonly LedgerEvent[], c: Pick<SlaClaim, "entrySeq" | "batchId" | "attempt">): boolean =>
  events.some((e) => e.kind === "note" && e.actor === "scheduler" && e.data.op === SLA_RELEASE_OP && e.data.entrySeq === c.entrySeq
    && e.data.batchId === c.batchId && e.data.attempt === c.attempt);

/**
 * The one test both older notices ask before they speak about a card: its current manual episode is in an SLA batch and the SLA
 * mechanism is on. `events` are the card's own events. Head / note / responsible / deadline changes inside the episode change nothing here.
 */
export function manualCaseSlaCovers(project: string, events: readonly LedgerEvent[], port?: ExplicitPolicyPort): boolean {
  if (!events.some((e) => e.data.op === SLA_CLAIM_OP)) return false; // the common case: no claim, no parse, no policy read
  const entry = manualEntry(events);
  const claim = entry ? slaClaims(events, entry.event.seq).at(-1) : undefined;
  return !!claim && !slaReleased(events, claim) && manualCaseSlaMode(project, port).mode === "on";
}

export type LegacyNotice = { state: "told" | "in_flight"; by: string };
const LEGACY_AUDIT_RULES = ["manual_stalled", "recovery_manual_stalled"] as const;

/**
 * The same question the other way round: did an older per-card stall notice already reach the PM for this episode, or is one on its
 * way? Read from where those notices keep their own delivery facts: recovery-manual's claim / sent notes (project level, after the
 * entry event) and the audit's finding rows of the two manual stall rules opened since the entry (pushed or queued = told; a finding
 * opened in the round the rule first ran, firstSeen = its baseline, was marked told without a push and does not count). told is final for the episode. in_flight (claimed / opened,
 * still being pushed) only waits: once it is LEGACY_IN_FLIGHT_MS old without a delivery record the older path itself reads it as not delivered.
 */
export function legacyStallNotice(db: Database, project: string, taskId: string, entrySeq: number, now: number): LegacyNotice | null {
  let flying: LegacyNotice | null = null;
  const cards = db.query(`SELECT ts, json_extract(data, '$.recovery.op') AS op FROM events WHERE project = ? AND target = '' AND kind = 'note' AND seq > ?
    AND json_extract(data, '$.recovery.taskId') = ? AND json_extract(data, '$.recovery.op') IN ('manualStall', 'manualStallSent')`)
    .all(project, entrySeq, taskId) as { ts: number; op: string }[];
  if (cards.some((c) => c.op === "manualStallSent")) return { state: "told", by: "manual 停滞行动卡" };
  if (cards.some((c) => now - c.ts < LEGACY_IN_FLIGHT_MS)) flying = { state: "in_flight", by: "manual 停滞行动卡" };
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audit_findings'").get()) return flying;
  const entry = db.query("SELECT ts FROM events WHERE seq = ?").get(entrySeq) as { ts: number } | null;
  const rows = db.query(`SELECT f.rule, f.notify, f.notifiedAt, f.queuedAs, f.resolvedAt, f.firstSeen, f.lastSeen, b.since AS base FROM audit_findings f
    LEFT JOIN audit_baseline b ON b.project = f.project AND b.rule = f.rule
    WHERE f.project = ? AND f.taskId = ? AND f.rule IN (${LEGACY_AUDIT_RULES.map(() => "?").join(", ")}) AND f.firstSeen >= ?`)
    .all(project, taskId, ...LEGACY_AUDIT_RULES, entry?.ts ?? 0) as
    { rule: string; notify: string | null; notifiedAt: number | null; queuedAs: string | null; resolvedAt: number | null; firstSeen: number; lastSeen: number; base: number | null }[];
  for (const r of rows) {
    if (r.queuedAs !== null || (r.notifiedAt !== null && r.firstSeen !== r.base)) return { state: "told", by: `巡检 ${r.rule}` };
    if (r.notifiedAt === null && r.resolvedAt === null && r.notify !== null && now - r.lastSeen < LEGACY_IN_FLIGHT_MS) flying = { state: "in_flight", by: `巡检 ${r.rule}` };
  }
  return flying;
}
