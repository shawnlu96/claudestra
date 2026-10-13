/**
 * merge-arch-SLA1 episode criterion, shared by the batched overdue reminder (manual-case-sla-tick.ts / -write.ts) and the two older
 * per-card stall notices (recovery-manual.ts manualStallTick, ledger-audit-stall.ts manual_stalled). An episode is "taken into a batch"
 * once the leased writer put a claim note on its card for the current entry seq; while manualCaseSla is explicitly on, the older notices
 * skip exactly those episodes. off / observe (the default; a project-wide on does not turn it on) hands every episode back to them, also
 * the ones already claimed / sent / unknown: the claim notes stay, so switching on again never re-sends. Pure over the card's own events
 * plus one policy read, and that read only happens for a card that carries a claim. tests/manual-case-sla*.test.ts.
 */
import type { LedgerEvent } from "./ledger-stages.js";
import { filePolicyPort, type ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { manualEntry } from "./manual-reason.js";
import type { RecoveryKey } from "./recovery-policy.js";

export const MANUAL_CASE_SLA_KEY: RecoveryKey = "manualCaseSla";
/** note on the card: this episode was claimed into batch `batchId` (attempt n) */
export const SLA_CLAIM_OP = "manual_case_sla";
/** project-level note: what became of batch `batchId` (sent / unknown / unsent) */
export const SLA_BATCH_OP = "manual_case_sla_batch";

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

/**
 * The one test both older notices ask before they speak about a card: its current manual episode is in an SLA batch and the SLA
 * mechanism is on. `events` are the card's own events. Head / note / responsible / deadline changes inside the episode change nothing here.
 */
export function manualCaseSlaCovers(project: string, events: readonly LedgerEvent[], port?: ExplicitPolicyPort): boolean {
  if (!events.some((e) => e.data.op === SLA_CLAIM_OP)) return false; // the common case: no claim, no parse, no policy read
  const entry = manualEntry(events);
  return !!entry && slaClaims(events, entry.event.seq).length > 0 && manualCaseSlaMode(project, port).mode === "on";
}
