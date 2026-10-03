/**
 * The merge-time half of the screenshot gate (docs/architecture/scheduler-ui-gate.md): what the merge intent's write and the merge
 * run (scheduler-merge.ts) re-read inside their own transactions. A leaf on purpose: scheduler-merge.ts imports it, and the rest of
 * scheduler-ui-gate.ts reaches the maintenance lease, which reaches the merge journal.
 */
import type { Database } from "bun:sqlite";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, ownerAnswered } from "./ledger-asks.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { projectPmUiGate } from "./ledger-ui-approve-verdict.js";

export const UI_ASK_ACTION = "scheduler_ui_screenshot";
export const DIGEST_RE = /^[a-f0-9]{64}$/i;

/**
 * Whether the card needs the owner. The one persistent place is `extra.ownerVisual` (autostart claim, task-new / task-set,
 * `ui-owner-visual`), read from the task writes that name the key: an extra rewritten for other fields (new screenshots) leaves
 * it as it was. The scheduler and managers set it either way; anyone else (an executor's task-set) can raise it, never clear it.
 */
export function ownerVisualOf(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): boolean {
  let on = false;
  for (const e of events) {
    if (e.kind !== "task" || (e.data.op !== "new" && e.data.op !== "set")) continue;
    const extra = (e.data.patch as { extra?: unknown } | undefined)?.extra;
    if (!extra || typeof extra !== "object" || !("ownerVisual" in extra)) continue;
    const value = (extra as Record<string, unknown>).ownerVisual === true;
    on = e.actor === "scheduler" || actorMayConfigure(db, e.actor, task.project) ? value : on || value;
  }
  return on;
}

/** The merge write's own check, inside its transaction: re-read from the ledger, never from the plan. Null = may merge. */
export function uiMergeRefusal(db: Database, task: LedgerTask, now: number): string | null {
  const digest = task.extra.screenshotsDigest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return "UI 前后截图摘要缺失";
  const params = { task: task.id, specRev: task.specRev, head: task.headSHA, screenshotsDigest: digest };
  const rows = db.query(`SELECT id FROM asks WHERE taskId = ? AND kind = 'authorize' AND state = 'answered'
    ORDER BY updatedAt DESC LIMIT 20`).all(task.id) as { id: string }[];
  const owner = rows.some(({ id }) => {
    const ask = getAsk(db, id);
    if (!ask || ask.fromAgent !== "scheduler" || ask.bind?.action !== UI_ASK_ACTION || !ownerAnswered(ask.answer)) return false;
    return checkAsk(ask, bindHash({ ...ask.bind, params }, "scheduler"), "scheduler", now).ok;
  });
  if (owner) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  if (ownerVisualOf(db, task, events)) return "缺同 head/specRev/摘要的 owner 截图授权（本卡要 owner 看截图）";
  const pm = projectPmUiGate(db, task, events);
  return pm.state === "approved" && pm.head === task.headSHA && pm.specRev === task.specRev && pm.round === task.round &&
    pm.screenshotsDigest === digest ? null : "缺同 head/specRev/轮次/摘要的 PM 截图验收或 owner 截图授权";
}
