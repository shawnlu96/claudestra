import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getIntent, getWorkflow, resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import { frozenBlocks, type PlanIntentInput } from "./ledger-scheduler-write.js";
import { textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getMeta, LedgerError, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { cardWorkerSlots } from "./scheduler-worker-slot.js";
import { writeSlotFacts } from "./scheduler-slot-hold-facts.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { poolAckSeq } from "./scheduler-pool-facts.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { exemptVerdict } from "./scheduler-review-swap.js";
import { poolReviewRefusal } from "./pool-review-proof.js";
import { uiMergeRefusal } from "./scheduler-ui-gate.js";
import { mergeRetryReleased } from "./scheduler-merge-retry.js";
import { schedulerV2LedgerFlags } from "./scheduler-v2-ledger-cmds-args.js";

export const schedulerV2PlanFlags = ["id", "rev", "workflow-rev", "seq", "node", "action", "recipient", "reason", "resources"];
type PlanFlags = ReturnType<typeof schedulerV2LedgerFlags>;

export function schedulerV2PlanProposal(taskId: string, p: PlanFlags): PlanIntentInput & { resources: string[] } {
  const id = textOneLine(p.need("id"), "intent key", 160);
  if (!/^[\w:.-]+$/.test(id)) throw new LedgerError("invalid", "intent key 不合法");
  const resources = [...new Set((p.flags.resources?.split(",").map(value => resourceKey(value.trim())) ?? []))].sort();
  if (resources.length > 32 || resources.includes(null)) throw new LedgerError("invalid", "资源名不合法或一次超过 32 个");
  return { id, taskId, workflowRev: p.integer("workflow-rev"), resources: resources as string[], node: textOneLine(p.need("node"), "节点", 80),
    action: p.need("action") as PlanIntentInput["action"], recipient: p.flags.recipient ? textOneLine(p.flags.recipient, "收件人", 200) : undefined,
    reason: textOneLine(p.need("reason"), "决定理由", 600), taskRev: p.integer("rev"), causalSeq: p.integer("seq") };
}

/** Replays are compared against the original decision, before current CAS versions or locks are checked. */
export function schedulerV2PlanReplay(db: Database, task: LedgerTask, p: PlanFlags): Record<string, unknown> | null | undefined {
  const input = schedulerV2PlanProposal(task.id, p), previous = getIntent(db, input.id);
  if (!previous) return undefined;
  const data = getEventByDedup(db, `scheduler:${input.id}`)?.data;
  // Center causalSeq/reason can differ from the legacy CLI's. S2F retains the original proposal during committed sync.
  const original = data?.plan;
  if (original != null && (typeof original !== "object" || Array.isArray(original))) return null;
  const record = original == null ? previous : original as Record<string, unknown>;
  if (previous.taskId !== task.id || record.taskId !== task.id || record.node !== input.node || record.action !== input.action
    || (record.recipient ?? null) !== (input.recipient ?? null) || record.reason !== input.reason
    || record.causalSeq !== input.causalSeq || record.taskRev !== input.taskRev) {
    throw new LedgerError("dedup_mismatch", "intent key 已用于另一项调度决定");
  }
  const was = original == null ? data?.resources : (original as Record<string, unknown>).resources;
  // The projection must retain original resources even after terminal settlement has released the locks.
  if (!Array.isArray(was)) return null;
  if (JSON.stringify(was) !== JSON.stringify(input.resources)) throw new LedgerError("dedup_mismatch", "intent key 的资源决定不同");
  return { ok: true, intent: previous, duplicate: true };
}

/** Read-only counterpart of planIntent's merge gates; every proof is from the local ledger projection. */
function mergePlanGuard(db: Database, task: LedgerTask, node: string): void {
  if (task.stage !== "merge" || node !== "merge_deploy") throw new LedgerError("invalid", "merge 意图只许在 merge_deploy 节点");
  const workflow = getWorkflow(db, task.id)!, events = listEvents(db, { project: task.project, target: task.id });
  const entry = db.query(`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE target=? AND kind='stage'
    AND json_extract(data,'$.to')='merge'`).get(task.id) as { seq: number };
  const cancelled = db.query(`SELECT id FROM scheduler_intents WHERE taskId=? AND action='merge' AND status='cancelled'
    AND causalSeq>=? ORDER BY eventSeq DESC LIMIT 1`).get(task.id, entry.seq) as { id: string } | null;
  if (cancelled && !mergeRetryReleased(task, events, getIntent(db, cancelled.id)!)) {
    throw new LedgerError("conflict", "本轮已取消合并意图，自动重试禁用");
  }
  const read = currentReviewFacts(task, events);
  if (read.kind !== "facts" || read.facts.verdict === "block" || read.facts.findings.some(f => f.severity !== "P2")
    || (read.facts.verdict === "changes" && !read.facts.findings.length)) throw new LedgerError("conflict", "合并前缺本轮通过审查");
  const review = read.facts;
  if (review.reviewerFamily === (remoteHeadFamily(db, task) ?? workflow.authorFamily) && !exemptVerdict(db, task, review)) {
    throw new LedgerError("conflict", "合并前缺跨模型审查");
  }
  const pool = poolReviewRefusal(db, task, workflow, review);
  if (pool) throw new LedgerError("conflict", pool);
  const reviewEntry = db.query(`SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE target=? AND kind='stage'
    AND json_extract(data,'$.to')='review' AND json_extract(data,'$.round')=?`).get(task.id, task.round) as { seq: number };
  if (!reviewEntry.seq) throw new LedgerError("conflict", "缺本轮 review 阶段进入事件");
  const sent = db.query(`SELECT id FROM scheduler_intents WHERE taskId=? AND action='review' AND recipient=?
    AND head=? AND eventSeq>? AND eventSeq<? AND status IN ('submitted','done')`)
    .all(task.id, review.reviewer, review.head, reviewEntry.seq, review.eventSeq) as { id: string }[];
  if (!sent.some(({ id }) => {
    const intent = getIntent(db, id)!;
    const ack = isPoolIntent(intent) ? poolAckSeq(db, id) : getEventByDedup(db, `scheduler:${id}:submitted`)?.seq;
    return ack != null && ack > intent.eventSeq && ack < review.eventSeq;
  })) throw new LedgerError("conflict", "合并前缺本轮审查派单回执");
  const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, Date.now()) : null;
  if (ui) throw new LedgerError("conflict", ui);
}

/** No cleanup/write runs here: both center locks and local executor locks participate in admission. */
export function schedulerV2PlanGuard(db: Database, task: LedgerTask, p: PlanFlags): void {
  const input = schedulerV2PlanProposal(task.id, p), workflow = getWorkflow(db, task.id);
  if (!workflow || workflow.mode !== "auto") throw new LedgerError("invalid", "任务未启用自动流程");
  const seq = (db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project=?").get(task.project) as { seq: number }).seq;
  if (workflow.specRev !== task.specRev || input.taskRev !== task.rev || input.workflowRev !== workflow.rev || input.causalSeq !== seq) {
    throw new LedgerError("conflict", "任务、流程或项目事件已前进");
  }
  if (getMeta(db, task.project).queueFrozen.frozen && frozenBlocks(task.stage, input.action)) {
    throw new LedgerError("conflict", "项目合并队列已冻结");
  }
  if (blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project))).length) {
    throw new LedgerError("conflict", "任务被前置挡住");
  }
  if (input.action === "merge") mergePlanGuard(db, task, input.node);
  if (db.query("SELECT id FROM scheduler_intents WHERE taskId=? AND status IN ('pending','submitted','unknown')").get(task.id)) {
    throw new LedgerError("conflict", "任务已有未结调度意图");
  }
  const held = writeSlotFacts(db, task.project).held;
  if (new Set([...cardWorkerSlots(held, task.id), ...input.resources.filter(key => key.startsWith("slot:"))]).size > 1) {
    throw new LedgerError("conflict", "一张卡最多持有一个 worker 槽");
  }
  if (held.some(row => row.taskId !== task.id && input.resources.some(key => resourcesOverlap(key, row.resource)))) {
    throw new LedgerError("conflict", "本机资源被其他卡占用");
  }
}
