/**
 * PM's screenshot verdict on a UI card and the ownerVisual switch. Only a manager other than the team dispatcher writes them,
 * and the gate (scheduler-ui-gate.ts) re-checks that on read. A verdict binds the card's current head / specRev / round /
 * digest, so a new head or new screenshots need a new verdict. tests/scheduler-ui-pm-gate.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { appendEvent } from "./ledger-write.js";
import { DIGEST_RE, ownerVisualOf, UI_APPROVED, UI_OWNER_VISUAL, UI_REJECTED } from "./scheduler-ui-gate.js";

const NOTE_MAX = 2000;

export interface UiVerdictInput {
  taskId: string;
  verdict: "approve" | "reject";
  /** approve: required, must equal the card's head / digest (PM saw these). reject: optional precondition. */
  head?: string;
  digest?: string;
  text?: string;
}

function uiCard(db: Database, ctx: WriteCtx, taskId: string, what: string): LedgerTask {
  const task = mustTask(db, taskId);
  if (!actorMayConfigure(db, ctx.actor, task.project)) {
    throw new LedgerError("forbidden", `${what}只有项目 ${task.project} 的 PM（调度助理除外）/ master / owner 能做（你是 ${ctx.actor}）`);
  }
  if (getWorkflow(db, task.id)?.template !== "ui") throw new LedgerError("invalid", `${task.id} 不是 ui 模板的卡`);
  return task;
}

export function recordUiVerdict(db: Database, ctx: WriteCtx, input: UiVerdictInput): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const what = input.verdict === "approve" ? "截图验收" : "退回截图";
    const task = uiCard(db, ctx, input.taskId, what);
    if (task.stage !== "review") throw new LedgerError("conflict", `${task.id} 当前在 ${task.stage}，${what}只在 review 阶段记`);
    const digest = task.extra.screenshotsDigest;
    if (typeof digest !== "string" || !DIGEST_RE.test(digest) || !task.headSHA) throw new LedgerError("conflict", `${task.id} 还没有 head 或截图摘要`);
    if (input.verdict === "approve" && (!input.head || !input.digest)) throw new LedgerError("invalid", "ui-approve 要带 --head 和 --digest（你看的那一版）");
    if (input.head !== undefined && input.head !== task.headSHA) throw new LedgerError("conflict", `卡上的 head 已是 ${task.headSHA}，不是 ${input.head}`);
    if (input.digest !== undefined && input.digest.toLowerCase() !== digest.toLowerCase()) {
      throw new LedgerError("conflict", `卡上的截图摘要已是 ${digest}，不是 ${input.digest}`);
    }
    if (input.verdict === "approve" && ownerVisualOf(db, task, listEvents(db, { project: task.project, target: task.id }))) {
      throw new LedgerError("conflict", `${task.id} 标了 owner 看截图（改整体观感），要 owner 在截图 ask 上批；改口径用 ui-owner-visual ${task.id} off`);
    }
    const note = input.text?.trim() ?? "";
    if (input.verdict === "reject" && !note) throw new LedgerError("invalid", "ui-reject 要带 --text <意见>：它会进下一轮的修复单");
    if (note.length > NOTE_MAX) throw new LedgerError("invalid", `意见不超过 ${NOTE_MAX} 字`);
    const data = { op: input.verdict === "approve" ? UI_APPROVED : UI_REJECTED, head: task.headSHA, specRev: task.specRev, round: task.round,
      screenshotsDigest: digest, ...(note ? { note } : {}) };
    const text = input.verdict === "approve" ? "PM 通过前后截图" : "PM 未通过前后截图，退回修复";
    return appendEvent(db, ctx, { project: task.project, target: task.id, kind: "decision", text, data });
  });
}

/** Turn the owner gate on (global look) or off for one UI card; the planner reads it from the ledger on the next pass. */
export function setOwnerVisual(db: Database, ctx: WriteCtx, input: { taskId: string; on: boolean }): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const task = uiCard(db, ctx, input.taskId, "改 owner 看截图的开关");
    if (task.stage === "done" || task.stage === "cancelled") throw new LedgerError("conflict", `${task.id} 已经结束（${task.stage}）`);
    return appendEvent(db, ctx, { project: task.project, target: task.id, kind: "decision",
      text: input.on ? "这张卡改整体观感：合并前 owner 看截图" : "这张卡的截图由 PM 验收", data: { op: UI_OWNER_VISUAL, on: input.on } });
  });
}
