/**
 * PMHAND1 · the sample notes: one ledger note each time a PM hand-back path takes effect, deduped per card + head + type
 * (`pm-handback:<type>:<task>:<head>`, data.op pm_handback). 9补 / 9补2 are corrections with no switch: their notes mark each use
 * of the fallback. 11a / 11b are judged in pure readers (planner, merge queue facts), so their notes are found afterwards by
 * handbackSamplesDue and written from the deploy tick (pm-handback-verify.ts). Doc: docs/architecture/pm-handback.md.
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup, getTask, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { listRequests, revokeOf } from "./manual-merge-queue-facts.js";
import { HANDBACK_REVIEW_TAG, holdLiftedBy, holdOf } from "./pm-handback.js";

const HANDBACK_SAMPLE_OP = "pm_handback";
/** retired_binding 9补 · review_dir_fallback 9补2 · handback_review 11a · hold_lift 11b · resolve_verify 12 */
type HandbackSampleType = "retired_binding" | "review_dir_fallback" | "handback_review" | "hold_lift" | "resolve_verify";
export interface HandbackSample { project: string; taskId: string; head: string | null; type: HandbackSampleType; text: string; data?: Record<string, unknown> }

const handbackSampleKey = (s: Pick<HandbackSample, "type" | "taskId" | "head">): string => `pm-handback:${s.type}:${s.taskId}:${s.head ?? "-"}`;

/** Writes the note once (true = written now). A sample is evidence only: a failed write is logged, never thrown into the path. */
export function recordHandbackSample(db: Database, s: HandbackSample, now: number): boolean {
  const dedupKey = handbackSampleKey(s);
  try {
    if (getEventByDedup(db, dedupKey)) return false;
    const r = appendEvent(db, { actor: "scheduler", now, dedupKey }, { project: s.project, target: s.taskId, kind: "note",
      text: `[PMHAND1 ${s.type}] ${s.text}`.slice(0, 600), data: { ...s.data, op: HANDBACK_SAMPLE_OP, type: s.type, head: s.head } });
    return !r.duplicate;
  } catch (e) {
    console.error(`⚠️ [pm-handback] ${s.taskId} 样本 ${s.type} 没记上：${(e as Error).message}`);
    return false;
  }
}

/** The 11a / 11b samples of a project not written yet: tagged review dispatches, and manual requests a same-person hold let pass. */
export function handbackSamplesDue(db: Database, project: string): HandbackSample[] {
  const out: HandbackSample[] = [];
  const tagged = db.query(`SELECT id, taskId, head FROM scheduler_intents WHERE project = ? AND status != 'cancelled' AND instr(reason, ?) = 1
    AND taskId IN (SELECT id FROM tasks WHERE stage NOT IN ('verified','done','cancelled')) ORDER BY eventSeq, id`)
    .all(project, HANDBACK_REVIEW_TAG) as { id: string; taskId: string; head: string | null }[];
  for (const i of tagged) {
    out.push({ project, taskId: i.taskId, head: i.head ?? getTask(db, i.taskId)?.headSHA ?? null, type: "handback_review",
      text: `PM 交回前的手派审查结论不算本轮，调度器照常派审（${i.id}），没报 review_unsolicited`, data: { intentId: i.id } });
  }
  const held = db.query(`SELECT t.id FROM tasks AS t JOIN task_workflows AS w ON w.taskId = t.id
    WHERE t.project = ? AND t.stage = 'merge' AND w.mode = 'manual' ORDER BY t.id`).all(project) as { id: string }[];
  for (const { id } of held) {
    const task = getTask(db, id), hold = holdOf(listEvents(db, { project, target: id }));
    if (!task || !hold) continue;
    for (const req of listRequests(db, project, id)) {
      if (task.headSHA !== req.head || !holdLiftedBy(hold, req) || revokeOf(db, req)) continue;
      out.push({ project, taskId: id, head: req.head, type: "hold_lift",
        text: `${req.requestedBy} 的人工合并请求 #${req.seq} 解除了本人设的 hold #${hold.seq}，进人工合并队列`, data: { requestSeq: req.seq, holdSeq: hold.seq } });
    }
  }
  return out.filter((s) => !getEventByDedup(db, handbackSampleKey(s)));
}
