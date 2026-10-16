/**
 * IDLINK1: an existing author whose identity is a proven conflict (bound to another session, or existingAuthorIdentity says
 * conflict) ends ensure_session as unknown, which never retries by itself; PM hears about it once, with the way back.
 * One notice per ensure_session intent: ensure only runs right after the tick claimed the intent pending → submitted (a ledger
 * compare-and-set that happens once per intent), and a claimed / unknown intent is never ensured again, after a restart neither;
 * the in-memory set below only covers a second ensure of the same claim within one process. No claimed intent = no notice.
 * An unreadable registry (身份失读) is not a proven conflict and is not reported here.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { registryTaskLabel } from "./registry-task-label.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";

export type IdentityNotify = (task: LedgerTask, text: string, level: PmNoticeLevel) => Promise<void>;

const told = new WeakMap<Database, Set<string>>();
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 400);

/** The card's author ensure_session the tick has claimed and is running ensure for right now. */
function claimedEnsureIntent(db: Database, taskId: string): string | null {
  const row = db.query(`SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'ensure_session' AND status = 'submitted'
    AND node <> 'adversarial_review' ORDER BY updatedAt DESC LIMIT 1`).get(taskId) as { id: string } | null;
  return row?.id ?? null;
}

export function identityNoticeText(task: Pick<LedgerTask, "id" | "title">, agent: string, intentId: string, reason: string): string {
  return `[调度引擎] ${task.id} 建作者会话落 unknown（身份冲突，不自动重试）。执行者 ${agent}；原因：${oneLine(reason)}。` +
    `建议：核对 registry 后用 team-link ${agent} --task "${registryTaskLabel(task.id, task.title)}" 改回，再 ledger scheduler-settle ${intentId} --from unknown --to cancelled`;
}

/** Tell PM once about this card's identity conflict; a failed send is logged, a stop still ends the pass. */
export async function noticeIdentityConflict(db: Database, task: LedgerTask, agent: string, reason: string, notify: IdentityNotify): Promise<void> {
  const intentId = claimedEnsureIntent(db, task.id);
  if (!intentId) return;
  const seen = told.get(db) ?? told.set(db, new Set()).get(db)!;
  if (seen.has(intentId)) return;
  seen.add(intentId);
  try { await notify(task, identityNoticeText(task, agent, intentId, reason), "action"); } // 身份冲突：PM 要核对
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] 身份冲突通知没发出去（意图 ${intentId} 已落 unknown，台账可查）：${(e as Error).message}`);
  }
}
