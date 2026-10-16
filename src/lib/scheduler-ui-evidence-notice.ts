/**
 * UIEVID2: before the scheduler asks PM to look at a UI card's before / after screenshots, the formally registered evidence behind
 * the card's digest is re-checked (ledger-ui-evidence-recheck.ts, the same check ui-approve runs). A known evidence conflict (a later
 * delivery without a manifest, head / round drift, moved or changed files) would only make PM's ui-approve refuse, so PM is not woken:
 * the scheduler records a note「截图证据需补交：<原因>」and a rejection under its own identity (data.by = scheduler, never PM's), which
 * the PM gate reads like ui-reject: the card goes back to fix with the fixed re-shoot text as the fix order's one P1. A digest with no
 * formal registration (legacy / manual screenshots: recheck returns false) and valid evidence notify PM as before; any other error is
 * thrown. Service side (uiEvidenceNotice) reads only; the write (recordUiEvidenceRedo) re-checks inside its own transaction.
 * tests/scheduler-ui-evidence-notice.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { busyAsLedgerError, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { UI_REJECTED } from "./ledger-ui-approve-verdict.js";
import { recheckUiEvidence } from "./ledger-ui-evidence-recheck.js";
import { appendEvent } from "./ledger-write.js";

/** The fix order's one P1 after an automatic return: the code passed review, only the screenshots are re-taken. */
export const UI_EVIDENCE_REDO_TEXT = "代码不用改，在当前 head 重拍同一组前后截图随交付带上";
/** data.by of the scheduler's own rejection: the only non-manager rejection the PM gate reads (ledger-ui-approve-verdict.ts). */
export const UI_EVIDENCE_REDO_BY = "scheduler";

export interface UiEvidenceDrift { code: string; why: string }

/** A known evidence conflict, or null when the evidence is valid or was never formally registered (legacy: notify as before). */
export function uiEvidenceDrift(task: LedgerTask, events: readonly LedgerEvent[]): UiEvidenceDrift | null {
  try {
    recheckUiEvidence(task, events);
    return null;
  } catch (e) {
    const code = e instanceof LedgerError && e.code === "conflict" ? e.current?.ui : undefined;
    if (typeof code !== "string") throw e;
    const message = (e as LedgerError).message;
    return { code, why: message.match(/（[a-z_]+）：(.*?)(；没记批准)?$/)?.[1] ?? message };
  }
}

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Settle = (id: string, from: "pending", to: "cancelled", receipt: string) => Promise<boolean>;

/**
 * Called right before the PM screenshot notice. null = notify as before; otherwise the card's outcome: the notice is not sent and the
 * ask intent is cancelled (no pm_notice receipt), so the next pass plans the return to fix from the scheduler's rejection.
 */
export async function uiEvidenceNotice(card: { db: Database; task: LedgerTask; deps: { manager: Manager }; settle: Settle },
  intent: SchedulerIntent): Promise<[string, string] | null> {
  const task = getTask(card.db, card.task.id) ?? card.task; // re-read: the plan was made on the pass's snapshot
  const drift = uiEvidenceDrift(task, listEvents(card.db, { project: task.project, target: task.id }));
  if (!drift) return null;
  const r = await card.deps.manager("ledger", "scheduler-ui-evidence-redo", task.id, "--head", task.headSHA ?? "",
    "--digest", String(task.extra.screenshotsDigest ?? ""));
  if (r.ok !== true) return ["held", `截图证据需补交（${drift.code}），退回重拍没记上：${String(r.error)}`];
  await card.settle(intent.id, "pending", "cancelled", `未通知 PM：截图证据需补交（${drift.code}）`);
  return ["replan", `截图证据需补交：${drift.why}；退回 fix 重拍，不请 PM 看图`];
}

/**
 * The scheduler's write (`ledger scheduler-ui-evidence-redo`): only the scheduler identity, only a ui card in review on the head /
 * digest it saw, and only when the re-check under the write lock still finds a known conflict. Writes the note and the rejection
 * bound to the card's head / specRev / round / digest; a replay of the same binding returns the recorded pair.
 */
export function recordUiEvidenceRedo(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; digest: string }):
  { event: LedgerEvent; duplicate: boolean; code: string } {
  if (ctx.actor !== UI_EVIDENCE_REDO_BY) throw new LedgerError("forbidden", "截图证据退回重拍只给调度服务身份");
  return busyAsLedgerError("写入", () => db.transaction(() => {
    const task = mustTask(db, input.taskId);
    if (getWorkflow(db, task.id)?.template !== "ui") throw new LedgerError("invalid", `${task.id} 不是 ui 模板的卡`);
    if (task.stage !== "review") throw new LedgerError("conflict", `${task.id} 当前在 ${task.stage}，截图证据退回只在 review 阶段记`);
    const digest = task.extra.screenshotsDigest;
    if (!task.headSHA || task.headSHA !== input.head || typeof digest !== "string" || digest !== input.digest) {
      throw new LedgerError("conflict", `${task.id} 的 head / 截图摘要已变，不按旧的退回`);
    }
    const drift = uiEvidenceDrift(task, listEvents(db, { project: task.project, target: task.id }));
    if (!drift) throw new LedgerError("conflict", `${task.id} 截图证据重核通过或没有正规登记，不退回`);
    const key = `ui-evidence-redo:${task.id}:${task.headSHA}:s${task.specRev}:r${task.round}:${digest}`;
    appendEvent(db, { ...ctx, dedupKey: `${key}:note` }, { project: task.project, target: task.id, kind: "note",
      text: `截图证据需补交：${drift.why}` });
    const r = appendEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind: "decision",
      text: "调度器重核截图证据不过，退回重拍（未请 PM 验收）",
      data: { op: UI_REJECTED, by: UI_EVIDENCE_REDO_BY, head: task.headSHA, specRev: task.specRev, round: task.round,
        screenshotsDigest: digest, note: UI_EVIDENCE_REDO_TEXT, code: drift.code } });
    return { ...r, code: drift.code };
  }).immediate());
}
