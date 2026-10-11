/**
 * A manually assigned author holds a local seat only on a step ticket a manager wrote for the card's current round
 * (ledger step-assign → task_steps). A registry name, an idle manual agent or an arbitrary extra field never does.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";

/** SQL over a `tasks t` row: the card's named agent holds an open writing ticket this round. */
export const MANUAL_TICKET = `EXISTS (SELECT 1 FROM task_steps st WHERE st.taskId=t.id AND st.executor=t.agent
  AND st.executorKind='agent' AND st.state='assigned' AND st.round=t.round AND st.step IN ('restate','write','fix'))`;

export const hasStepsTable = (db: Database): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_steps'").get();

export function manualAuthorTicket(db: Database, task: Pick<LedgerTask, "id">): boolean {
  if (!hasStepsTable(db)) return false;
  return !!db.query(`SELECT 1 FROM tasks t WHERE t.id=? AND t.agent IS NOT NULL AND t.agent!=''
    AND (t.assigneeKind IS NULL OR t.assigneeKind='agent') AND ${MANUAL_TICKET}`).get(task.id);
}
