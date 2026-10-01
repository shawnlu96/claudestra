/**
 * PM's screenshot verdict on a UI card, as read back from the ledger, and the fix order it makes. It stays out of
 * scheduler-ui-gate.ts so take_order (order-take.ts) reads it without importing the scheduler service (an import cycle the
 * guard rejects). Writes: ledger-ui-approve.ts. tests/scheduler-ui-pm-gate.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { wireFindings } from "./order-findings.js";
import { sanitizeForeign } from "./order-wire-render.js";
import type { ReviewFinding } from "./scheduler-review.js";

export const UI_APPROVED = "ui_approved", UI_REJECTED = "ui_rejected";
export interface PmUiGate { state: "none" | "approved" | "rejected"; head?: string; specRev?: number; round?: number; screenshotsDigest?: string; seq?: number; note?: string }

/** PM's newest screenshot verdict on this card, from a manager; the planner checks its binding against the card. */
export function projectPmUiGate(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): PmUiGate {
  const e = events.findLast((x) => x.kind === "decision" && (x.data.op === UI_APPROVED || x.data.op === UI_REJECTED) &&
    actorMayConfigure(db, x.actor, task.project));
  if (!e) return { state: "none" };
  const d = e.data;
  return { state: d.op === UI_APPROVED ? "approved" : "rejected", seq: e.seq,
    ...(typeof d.head === "string" ? { head: d.head } : {}), ...(typeof d.specRev === "number" ? { specRev: d.specRev } : {}),
    ...(typeof d.round === "number" ? { round: d.round } : {}),
    ...(typeof d.screenshotsDigest === "string" ? { screenshotsDigest: d.screenshotsDigest } : {}),
    ...(typeof d.note === "string" ? { note: d.note } : {}) };
}

export type UiFix = { reportPath: string; findings: ReviewFinding[]; fallbackWarning: null };

/**
 * The fix order after PM's ui-reject: PM's words are the one P1 finding. Only the rejection that sent this round to fix counts
 * (same round, recorded before the review→fix move); the executor may already be re-shooting, so head / digest are not compared.
 * The planner's full-text order (scheduler-ui-gate.ts) and take_order (order-take.ts) both read it here.
 */
export function rejectFix(task: LedgerTask, template: string | undefined, events: readonly LedgerEvent[], g: PmUiGate | undefined): UiFix | null {
  if (template !== "ui" || task.stage !== "fix" || g?.state !== "rejected" || g.round !== task.round || g.seq === undefined) return null;
  const entered = events.findLast((e) => e.kind === "stage" && e.data.to === "fix");
  if (!entered || entered.data.from !== "review" || entered.seq < g.seq) return null;
  return { reportPath: `台账事件 #${g.seq}（PM 截图验收意见：${task.id}）`, fallbackWarning: null,
    findings: [{ findingId: `ui-screenshot-${g.seq}`, family: "ui_screenshot", severity: "P1", probe: g.note ?? "PM 未通过前后截图" }] };
}

export function uiRejectFixFor(db: Database, task: LedgerTask, events: readonly LedgerEvent[], template: string | undefined): UiFix | null {
  return rejectFix(task, template, events, projectPmUiGate(db, task, events));
}

/**
 * ui-reject's cap on a note as the peer exit measures it (folded + masked, sanitizeForeign). The note goes whole into a lent
 * fix order's report input, one line; 8000 bytes keeps that line far below the input's split room (WIRE_LIMITS.input − headroom,
 * order-wire-chunks.ts), which a 2000-character note of NFKC-expanding characters would otherwise pass and get the order refused.
 */
export const UI_NOTE_MAX_BYTES = 8000;
export const uiNoteBytes = (note: string): number => Buffer.byteLength(sanitizeForeign(note));

/**
 * The same rejection as a lend fix order's material (ledger-lend.ts findings, lend-write-materials.ts report): the peer cannot read
 * this machine's ledger, so PM's words go inline as the report text, whole. The probe goes through wireFindings' byte cap on the
 * form the peer exit measures (order-wire-render.ts), else a long Chinese note (6000 bytes) refuses the pooled order.
 * Null = no PM rejection sent this round to fix.
 */
export function uiRejectLend(db: Database, task: LedgerTask): { findings: ReviewFinding[]; report: string } | null {
  const fix = uiRejectFixFor(db, task, listEvents(db, { project: task.project, target: task.id }), getWorkflow(db, task.id)?.template);
  if (!fix) return null;
  return { findings: wireFindings(fix.findings.map((f) => ({ ...f, probe: sanitizeForeign(f.probe) }))),
    report: `# PM 截图验收未通过\n\n来源：${fix.reportPath}\n\n${fix.findings[0].probe}` };
}
