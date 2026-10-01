/**
 * The ledger half of card retirement (docs/architecture/scheduler-retire.md): one `retire` intent per card, opened already
 * claimed. Unlike planIntent it does not require an auto workflow — most finished cards were taken to manual on the way, and
 * their scheduler-created sessions still need collecting. What it does require is a finished card (verified / done /
 * cancelled) with no other open intent, so a card still being built, reviewed or merged can never be retired.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMaySchedule } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { RETIRE_STAGES } from "./scheduler-sessions.js";

/** One key per card: a finished card never goes back to work, so a second retirement would only repeat the first. */
export const retireIntentId = (taskId: string): string => `retire:${taskId}`;

const projectSeq = (db: Database, project: string): number =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(project) as { seq: number }).seq;

/** Open (or return) the card's retire intent in status submitted; a replay returns the stored row with duplicate: true. */
export function beginRetire(db: Database, ctx: WriteCtx, taskId: string): { intent: SchedulerIntent; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, taskId);
    if (!actorMaySchedule(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有调度服务或项目 PM / master / owner 能开退役意图");
    const id = retireIntentId(task.id);
    const prior = getIntent(db, id);
    if (prior) return { intent: prior, duplicate: true };
    if (!RETIRE_STAGES.includes(task.stage)) throw new LedgerError("conflict", `${task.id} 在 ${task.stage}，没收尾的卡不退役`);
    const open = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1")
      .get(task.id) as { id: string } | null;
    if (open) throw new LedgerError("conflict", `${task.id} 还有未结调度意图 ${open.id}，先结清再退役`);
    const now = ctx.now ?? Date.now(), causalSeq = projectSeq(db, task.project);
    const workflow = getWorkflow(db, task.id), reason = `${task.stage} 卡收尾：归档并结束 session、清 worktree`;
    db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head,
      templateVersion, status, attempts, receipt, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'retire', 'retire', NULL, ?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?, ?)`)
      .run(id, task.id, task.project, causalSeq, task.rev, task.specRev, task.headSHA, workflow?.templateVersion ?? 0, "claimed; retire", reason, now, now);
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${id}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: reason,
      data: { op: "plan", id, node: "retire", action: "retire", recipient: null, resources: [], causalSeq, taskRev: task.rev,
        specRev: task.specRev, head: task.headSHA, template: workflow?.template ?? null, version: workflow?.templateVersion ?? 0,
        claimed: true, ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    db.prepare("UPDATE scheduler_intents SET eventSeq = ? WHERE id = ?").run(event.seq, id);
    return { intent: getIntent(db, id) as SchedulerIntent, duplicate: false };
  });
}
