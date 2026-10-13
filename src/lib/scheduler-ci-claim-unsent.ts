/**
 * CLAIMSPENT1: a CI recovery claim (CIF2 update-branch `merge_ci_behind`, CIF1 / CIF8 rerun `merge_ci_rerun`) that the main CI gate
 * refused right before its send (scheduler-main-ci-wiring-driver.ts sendEffect) gets a formal "not sent" settlement, written in the
 * same transaction as the main_ci_pause cancellation (scheduler-merge-unsent.ts unsentEnd). Under ciClaimUnsent=on the budget queries
 * (behindOf, ciRerunSpent) skip exactly that claim, so a later run on the same head may claim and send once more. The claim itself
 * is never touched; train and manual reruns always count. off: nothing; observe: one note per claim, budgets unchanged.
 * tests/scheduler-ci-claim-unsent.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { observeDedupKey, recoveryPolicy } from "./recovery-policy.js";
import type { MergeRun } from "./scheduler-merge.js";
import { MAIN_CI_PAUSE, MAIN_CI_UPDATE_NOT_SENT } from "./scheduler-merge-unsent-receipts.js";

export type CiClaimAction = "update" | "rerun";
export const CI_CLAIM_UNSENT_OP = "merge_ci_claim_unsent";
const CLAIM_OP: Record<CiClaimAction, string> = { update: "merge_ci_behind", rerun: "merge_ci_rerun" };
const ACTION_OF: Record<string, CiClaimAction> = { merge_ci_behind: "update", merge_ci_rerun: "rerun" };
const proofKey = (intentId: string, claimSeq: number) => `scheduler:${intentId}:merge:ci_claim_unsent:${claimSeq}`;
const sameSha = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const TAG = "；CI 恢复认领未发出（";
const MARK = /；CI 恢复认领未发出（(update|rerun) ([a-f0-9]{40})(?: run (\d{1,20}))?）$/;
/** Only sendEffect's CI recovery wrappers append this, and only when the gate refused before the call started. */
export const ciClaimUnsentMark = (action: CiClaimAction, prHead: string, runId?: string): string =>
  `${TAG}${action} ${prHead.toLowerCase()}${action === "rerun" && runId ? ` run ${runId}` : ""}）`;
/** The cancel receipt with the mark kept whole at its end (unsentEnd refuses receipts past 600). */
export const withCiClaimUnsent = (receipt: string, mark: string): string => receipt.slice(0, 600 - mark.length) + mark;
function parseMark(receipt: string): { action: CiClaimAction; prHead: string; runId: string | null } | null {
  const m = MARK.exec(receipt);
  if (!m || (m[1] === "rerun") !== !!m[3]) return null;
  return { action: m[1] as CiClaimAction, prHead: m[2]!, runId: m[3] ?? null };
}

/**
 * Pure: whether `claim` has a formal unsent settlement in `events`. The proof names the claim (seq, intent, action, head, run) and sits
 * right after the main_ci_pause cancellation marker of the same intent, written by the same actor at the same instant.
 * Observations (recovery_observe notes) never match.
 */
export function claimSettledUnsent(events: readonly LedgerEvent[], claim: LedgerEvent): boolean {
  const action = ACTION_OF[String(claim.data.op)];
  if (!action || claim.kind !== "scheduler" || claim.data.imported === true || typeof claim.data.intentId !== "string") return false;
  const intentId = claim.data.intentId;
  return events.some((p) => {
    const d = p.data;
    if (p.kind !== "scheduler" || d.op !== CI_CLAIM_UNSENT_OP || d.imported === true || p.dedupKey !== proofKey(intentId, claim.seq) ||
      d.claimSeq !== claim.seq || d.intentId !== intentId || d.action !== action || !sameSha(d.prHead, claim.data.prHead) ||
      d.run !== claim.data.run || p.project !== claim.project || p.target !== claim.target || p.actor !== claim.actor || p.seq <= claim.seq) return false;
    const marker = events.find((e) => e.seq === d.cancelSeq);
    return !!marker && marker.seq === p.seq - 1 && marker.seq > claim.seq && marker.kind === "scheduler" && marker.actor === p.actor &&
      marker.ts === p.ts && marker.project === p.project && marker.target === p.target && marker.data.imported !== true &&
      marker.data.op === "merge_unsent_cancel" && marker.data.intentId === intentId && marker.data.cause === MAIN_CI_PAUSE &&
      marker.data.counted === false && marker.dedupKey === `scheduler:${intentId}:merge:unsent` && sameSha(marker.data.head, claim.data.prHead);
  });
}

/**
 * The claim seqs of this card the budget queries skip: empty unless ciClaimUnsent is on (a policy read error is off), so off and
 * observe keep the old budgets. A card without any proof never reads the policy.
 */
export function settledUnsentClaims(db: Database, project: string, taskId: string): ReadonlySet<number> {
  const any = db.query(`SELECT 1 FROM events WHERE project=? AND target=? AND kind='scheduler' AND json_extract(data,'$.op')=? LIMIT 1`)
    .get(project, taskId, CI_CLAIM_UNSENT_OP);
  if (!any || recoveryPolicy(project, "ciClaimUnsent").mode !== "on") return new Set();
  const events = listEvents(db, { project, target: taskId });
  return new Set(events.filter((e) => ACTION_OF[String(e.data.op)] && claimSettledUnsent(events, e)).map((e) => e.seq));
}

type WriteEvent = (db: Database, ctx: WriteCtx, event: {
  project: string; target: string; kind: "scheduler" | "note"; text: string; data: Record<string, unknown>;
}, primary: boolean) => LedgerEvent;

/**
 * Called by unsentEnd right after it wrote the main_ci_pause cancellation `marker`, in the same transaction: a throw here rolls the
 * cancellation back too, the driver keeps the run held and nothing is sent. Only the intent's own latest claim of the marked action,
 * on the run's head (and run), with the run still showing that claim, is settled; anything else stays spent.
 */
export function settleCiClaimUnsent(db: Database, ctx: WriteCtx & { now: number }, row: MergeRun, receipt: string, marker: LedgerEvent,
  write: WriteEvent): void {
  const mark = receipt.startsWith(`${MAIN_CI_PAUSE}：`) ? parseMark(receipt) : null;
  if (!mark || !sameSha(mark.prHead, row.reviewedHead)) return;
  const mode = recoveryPolicy(row.project, "ciClaimUnsent").mode;
  if (mode === "off") return;
  if (mark.action === "update" ? row.phase !== "updating" || !receipt.startsWith(MAIN_CI_UPDATE_NOT_SENT) : !["ready", "await_ci"].includes(row.phase)) return;
  const claim = db.query(`SELECT seq FROM events WHERE project=? AND target=? AND kind='scheduler' AND json_extract(data,'$.op')=?
    AND json_extract(data,'$.intentId')=? ORDER BY seq DESC LIMIT 1`).get(row.project, row.taskId, CLAIM_OP[mark.action], row.intentId) as { seq: number } | null;
  const events = claim ? listEvents(db, { project: row.project, target: row.taskId, afterSeq: claim.seq - 1 }) : [];
  const c = events[0];
  if (!c || c.seq !== claim!.seq || c.actor !== ctx.actor || c.data.imported === true || !sameSha(c.data.prHead, row.reviewedHead) ||
    typeof c.data.run !== "string" || !row.reason?.includes(c.data.run) || (mark.runId && !c.data.run.endsWith(`/runs/${mark.runId}`))) return;
  // nothing of this intent may have moved the run on after its claim (a send read back, another phase): only the cancellation itself
  if (events.some((e) => e.seq > c.seq && e.seq < marker.seq - 2 && e.data.intentId === row.intentId)) return;
  if (getEventByDedup(db, proofKey(row.intentId, c.seq))) return;
  const what = mark.action === "update" ? "update-branch" : "gh run rerun";
  if (mode === "observe") {
    const dedupKey = observeDedupKey({ project: row.project, mechanism: "ciClaimUnsent", target: row.taskId, actionKey: `claim:${c.seq}` });
    if (getEventByDedup(db, dedupKey)) return;
    write(db, { actor: ctx.actor, now: ctx.now, dedupKey }, { project: row.project, target: row.taskId, kind: "note",
      text: `恢复观察（ciClaimUnsent）：本会结清未发出的 CI 恢复认领（${what}，事件 #${c.seq}），同 head 可再发一次`,
      data: { op: "recovery_observe", mechanism: "ciClaimUnsent", actionKey: `claim:${c.seq}`, intentId: row.intentId, claimSeq: c.seq,
        action: mark.action, prHead: row.reviewedHead, run: c.data.run } }, true);
    return;
  }
  write(db, { actor: ctx.actor, now: ctx.now, dedupKey: proofKey(row.intentId, c.seq) }, { project: row.project, target: row.taskId, kind: "scheduler",
    text: `合并队列：主线 CI 闸在 ${what} 发出前拒绝，CI 恢复认领（事件 #${c.seq}）结清为未发出，同 head 可再认领一次`,
    data: { op: CI_CLAIM_UNSENT_OP, intentId: row.intentId, claimSeq: c.seq, action: mark.action, prHead: c.data.prHead, run: c.data.run,
      cancelSeq: marker.seq } }, true);
}
