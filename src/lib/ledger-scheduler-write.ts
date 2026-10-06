/** Scheduler-only ledger writes: every decision and resource claim is one compare-and-swap transaction. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { blockedBy, depViews } from "./ledger-deps.js";
import {
  activationSeq, AUTHOR_FAMILIES, getIntent, getWorkflow, INTENT_ACTIONS, resourceKey, resourcesOverlap, taskCreationSeq,
  WORKFLOW_MODES, WORKFLOW_TEMPLATES, type AuthorFamily, type IntentAction, type SchedulerIntent,
  type TaskWorkflow, type WorkflowMode, type WorkflowTemplate,
} from "./ledger-scheduler.js";
import { getEventByDedup, getMeta, LedgerError, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { closePoolOrders } from "./ledger-scheduler-pool.js";
import { actorMayConfigure, actorMaySchedule, textOneLine } from "./ledger-scheduler-settle.js";
import { cardWorkerSlots } from "./scheduler-worker-slot.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { poolAckSeq } from "./scheduler-pool-facts.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { templateFor } from "./scheduler-template.js";
import { uiMergeRefusal } from "./scheduler-ui-gate.js";
import { autostartGrant } from "./ledger-autostart-grant.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { releaseIdleWriteSlots } from "./ledger-scheduler-lease.js";
import { mergeRetryReleased } from "./scheduler-merge-retry.js";
import { poolReviewRefusal } from "./pool-review-proof.js";
import { isManualReasonCode, manualReasonRecord, MANUAL_REASON_CODES } from "./manual-reason.js";

const projectSeq = (db: Database, project: string): number =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(project) as { seq: number }).seq;
const cardResource = (action: IntentAction, resource: string): boolean => action === "dispatch" && !resource.startsWith("task:");

/**
 * What a frozen merge queue refuses: new work (every intent of a spec / build / fix card), merging and deploying (the merge stage and
 * any merge intent). Reviews and the stage moves their verdicts drive keep running. Must equal the planner's own freeze wait
 * (scheduler-plan.ts `queue_frozen`), or a review plan is refused every tick: tests/scheduler-freeze-align.test.ts.
 */
const FROZEN_STAGES: readonly string[] = ["spec", "build", "fix", "merge"];
export const frozenBlocks = (stage: string, action: IntentAction): boolean => FROZEN_STAGES.includes(stage) || action === "merge";

function requireReviewedMerge(db: Database, task: ReturnType<typeof mustTask>, workflow: TaskWorkflow, node: string, now: number): void {
  if (task.stage !== "merge" || node !== "merge_deploy") throw new LedgerError("invalid", "merge 意图只许在 merge_deploy 节点");
  const read = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }));
  if (read.kind !== "facts" || read.facts.verdict === "block" ||
    read.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1") ||
    (read.facts.verdict === "changes" && !read.facts.findings.some((f) => f.severity === "P2"))) {
    throw new LedgerError("conflict", "合并前缺本轮同 head 的通过审查");
  }
  if (read.facts.reviewerFamily === (remoteHeadFamily(db, task) ?? workflow.authorFamily)) throw new LedgerError("conflict", "合并前缺跨模型审查");
  const pool = poolReviewRefusal(db, task, workflow, read.facts);
  if (pool) throw new LedgerError("conflict", pool);
  const reviewEntry = db.query(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE target = ? AND kind = 'stage'
    AND json_extract(data, '$.to') = 'review' AND json_extract(data, '$.round') = ?`).get(task.id, task.round) as { seq: number };
  if (!reviewEntry.seq) throw new LedgerError("conflict", "缺本轮 review 阶段进入事件");
  const sent = db.query(`SELECT * FROM scheduler_intents AS i WHERE i.taskId = ? AND i.action = 'review' AND i.recipient = ? AND i.head = ?
    AND i.eventSeq > ? AND i.eventSeq < ? AND i.status IN ('submitted','done')`).all(
    task.id, read.facts.reviewer, read.facts.head, reviewEntry.seq, read.facts.eventSeq,
  ) as SchedulerIntent[];
  // Receipt: the `submitted` settle for a local order; for a pool order the peer's claim note (the settle may trail the verdict).
  const prior = sent.some((i) => {
    const ack = isPoolIntent(i) ? poolAckSeq(db, i.id) : getEventByDedup(db, `scheduler:${i.id}:submitted`)?.seq ?? null;
    return ack !== null && ack > i.eventSeq && ack < read.facts.eventSeq;
  });
  if (!prior) throw new LedgerError("conflict", "合并前缺本轮审查派单回执");
  const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
  if (ui) throw new LedgerError("conflict", ui);
}

export interface WorkflowInput {
  taskId: string;
  taskRev: number;
  workflowRev?: number;
  template: WorkflowTemplate;
  templateVersion: number;
  mode: WorkflowMode;
  authorFamily: AuthorFamily;
  fallback: string;
  /** Required when PM takes an auto card back to manual; recorded on the workflow event. */
  reason?: string;
  /** manual-reason code (manual-reason.ts) for `reason`; same as writing `<code>: <reason>` */
  reasonCode?: string;
}

/**
 * Historical cards are excluded by the migration watermark, even when still sitting in spec. `intake` is passed only by the peer PR
 * intake transaction (peer-pr-ledger.ts, which re-read peer-prs.json and created this card): it skips the PM check for that card alone.
 */
export function setWorkflow(db: Database, ctx: WriteCtx, input: WorkflowInput, intake = false): { workflow: TaskWorkflow; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (intake) { if (input.template !== "security" || input.mode !== "auto" || !task.extra.peerPr) throw new LedgerError("forbidden", "收 peer PR 只能给新建的 peer 卡开 security 自动流程"); }
    else if (!actorMayConfigure(db, ctx.actor, task.project) && !autostartGrant(ctx, task.id)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能配置自动任务");
    if (task.kind !== "code") throw new LedgerError("invalid", "自动流程只接 code 任务");
    const existing = getWorkflow(db, task.id);
    if (!existing) {
      const born = taskCreationSeq(db, task.id);
      if (task.stage !== "spec" || born === null || born <= activationSeq(db)) {
        throw new LedgerError("invalid", `${task.id} 是在途卡（${task.stage}${born !== null && born <= activationSeq(db) ? "，调度迁移前建的" : ""}）：自动流程只收迁移后新建、尚未开写的 spec 卡，在途卡继续人工推进`);
      }
    } else if (task.stage !== "spec" && input.mode !== "manual") {
      throw new LedgerError("invalid", `${task.id} 已开工（${task.stage}）：只能暂停为 manual（带 --reason）；重新自动接管须先核对并另走恢复入口`);
    }
    const takeover = existing?.mode === "auto" && input.mode === "manual";
    if (takeover && !input.reason?.trim()) throw new LedgerError("invalid", "从 auto 退回人工要带 --reason（为什么接管），记进台账");
    if (!WORKFLOW_TEMPLATES.includes(input.template) || !WORKFLOW_MODES.includes(input.mode)) throw new LedgerError("invalid", "流程模板或模式不认识");
    if (!AUTHOR_FAMILIES.includes(input.authorFamily)) throw new LedgerError("invalid", "作者模型家族只认 claude / codex");
    if (!templateFor(input.template, input.templateVersion)) throw new LedgerError("invalid", `模板 ${input.template} 没有版本 ${input.templateVersion}（code 有 2 / 3，ui、security 只有 2）`);
    const fallback = textOneLine(input.fallback, "退路方案", 600);
    const data = { template: input.template, templateVersion: input.templateVersion, mode: input.mode, authorFamily: input.authorFamily, fallback };
    // PM hold：已是 manual 的卡带 --reason 再设 manual = 「留在人工」，照样记一条带 hold 的事件，自动交回见到它就不碰（scheduler-autostart-resume.ts）
    const hold = existing?.mode === "manual" && input.mode === "manual" && !!input.reason?.trim();
    const unchanged = !hold && existing && existing.specRev === task.specRev && Object.entries(data).every(([k, v]) => existing[k as keyof TaskWorkflow] === v);
    if (unchanged) return { workflow: existing, duplicate: true };
    // Entering manual (first configuration, from auto / observe, or a hold) needs a recognised reason; checked before any intent / pool / workflow write.
    if (input.reasonCode !== undefined && !isManualReasonCode(input.reasonCode)) throw new LedgerError("invalid", `理由码不认识：${input.reasonCode}（${MANUAL_REASON_CODES.join(" / ")}）`);
    const reasonText = input.reasonCode && input.reason?.trim() ? `${input.reasonCode}: ${input.reason}` : input.reasonCode ? "" : input.reason;
    // a first configuration straight into manual is a new manual write too: it needs the same recognised reason
    const entering = input.mode === "manual" && (!existing || existing.mode !== "manual" || hold);
    const manualReason = entering || (input.mode === "manual" && (input.reason?.trim() || input.reasonCode)) ? manualReasonRecord(db, task, reasonText) : null;
    if (task.rev !== input.taskRev || (existing?.rev ?? 0) !== (input.workflowRev ?? 0)) {
      throw new LedgerError("conflict", "任务或流程已被改过，先重读再设置", { taskRev: task.rev, workflowRev: existing?.rev ?? 0 });
    }
    const now = ctx.now ?? Date.now();
    const pool = existing && input.mode === "manual" ? closePoolOrders(db, { ...ctx, now }, task.id, `转人工：${input.reason?.replace(/\s+/g, " ").trim() || "流程设为 manual"}`) : null;
    const pending = existing && input.mode === "manual"
      ? db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status = 'pending'").all(task.id) as { id: string }[] : [];
    if (pending.length) {
      db.query("UPDATE scheduler_intents SET status = 'cancelled', updatedAt = ? WHERE taskId = ? AND status = 'pending'").run(now, task.id);
      for (const row of pending) db.query("DELETE FROM scheduler_resources WHERE intentId = ? AND scope = 'intent'").run(row.id);
    }
    db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (taskId) DO UPDATE SET template=excluded.template, templateVersion=excluded.templateVersion,
      mode=excluded.mode, authorFamily=excluded.authorFamily, fallback=excluded.fallback, specRev=excluded.specRev,
      rev=task_workflows.rev+1, updatedAt=excluded.updatedAt`).run(
      task.id, task.project, input.template, input.templateVersion, input.mode, input.authorFamily, fallback, task.specRev, now, now,
    );
    const workflow = getWorkflow(db, task.id) as TaskWorkflow;
    insertEvent(db, { actor: ctx.actor, now }, {
      project: task.project, target: task.id, kind: "scheduler", text: `流程设为 ${input.mode}`,
      data: { op: "workflow", ...data, workflowRev: workflow.rev, specRev: task.specRev, cancelledIntents: pending.map((p) => p.id),
        ...(pool && (pool.withdrawn.length || pool.stray.length) ? { poolOrders: pool } : {}), ...(takeover ? { takeover: textOneLine(input.reason as string, "接管原因", 600), manual: true } : {}),
        ...(hold ? { hold: textOneLine(input.reason as string, "留人工原因", 600), manual: true } : {}), ...(manualReason ? { manualReason } : {}) },
    }, false);
    return { workflow, duplicate: false };
  });
}

export interface PlanIntentInput {
  id: string;
  taskId: string;
  taskRev: number;
  workflowRev: number;
  causalSeq: number;
  node: string;
  action: IntentAction;
  recipient?: string;
  reason: string;
  resources?: string[];
}

/** The caller proposes an action; all guards and uniqueness are checked again under BEGIN IMMEDIATE. */
export function planIntent(db: Database, ctx: WriteCtx, input: PlanIntentInput): { intent: SchedulerIntent; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!actorMaySchedule(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有调度服务或项目 PM / master / owner 能提交调度意图");
    const id = textOneLine(input.id, "intent key", 160);
    if (!/^[\w:.-]+$/.test(id)) throw new LedgerError("invalid", "intent key 只能含字母数字及 _ : . -");
    const node = textOneLine(input.node, "节点", 80);
    const reason = textOneLine(input.reason, "决定理由", 600);
    const recipient = input.recipient ? textOneLine(input.recipient, "收件人", 200) : null;
    const resources = [...new Set((input.resources ?? []).map(resourceKey))].sort();
    if (resources.length > 32 || resources.includes(null)) throw new LedgerError("invalid", "资源名不合法或一次超过 32 个");
    const previous = getIntent(db, id);
    if (previous) {
      const event = getEventByDedup(db, `scheduler:${id}`);
      const was = event?.data.resources;
      if (previous.taskId !== task.id || previous.node !== node || previous.action !== input.action ||
        previous.recipient !== recipient || previous.reason !== reason ||
        previous.causalSeq !== input.causalSeq || previous.taskRev !== input.taskRev ||
        !Array.isArray(was) || JSON.stringify(was) !== JSON.stringify(resources)) {
        throw new LedgerError("dedup_mismatch", "intent key 已用于另一项调度决定");
      }
      return { intent: previous, duplicate: true };
    }
    const workflow = getWorkflow(db, task.id);
    if (!workflow || workflow.mode !== "auto") throw new LedgerError("invalid", "任务未启用自动流程");
    if (workflow.specRev !== task.specRev) throw new LedgerError("conflict", "规格版本变了，自动流程先停下重核");
    if (task.rev !== input.taskRev || workflow.rev !== input.workflowRev || projectSeq(db, task.project) !== input.causalSeq) {
      throw new LedgerError("conflict", "任务、流程或项目事件已前进，丢弃旧计划重新计算");
    }
    if (getMeta(db, task.project).queueFrozen.frozen && frozenBlocks(task.stage, input.action)) throw new LedgerError("conflict", "项目合并队列已冻结");
    const blocked = blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project)));
    if (blocked.length) throw new LedgerError("conflict", `任务被前置挡住：${blocked.map((d) => d.from).join("、")}`);
    if (!INTENT_ACTIONS.includes(input.action)) throw new LedgerError("invalid", "调度动作不认识");
    if (input.action === "merge") {
      const entered = db.query(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE target = ? AND kind = 'stage'
        AND json_extract(data, '$.to') = 'merge'`).get(task.id) as { seq: number };
      const cancelled = db.query(`SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'merge'
        AND status = 'cancelled' AND causalSeq >= ? ORDER BY eventSeq DESC LIMIT 1`).get(task.id, entered.seq) as { id: string } | null;
      const events = cancelled ? listEvents(db, { project: task.project, target: task.id }) : [];
      if (cancelled && !mergeRetryReleased(task, events, getIntent(db, cancelled.id)!)) throw new LedgerError("conflict", "本轮已取消合并意图，自动重试禁用；请 PM 手动核对并接管");
      requireReviewedMerge(db, task, workflow, node, ctx.now ?? Date.now());
    }
    const live = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1")
      .get(task.id) as { id: string } | null;
    if (live) throw new LedgerError("conflict", `任务已有未结调度意图 ${live.id}`);
    releaseIdleWriteSlots(db, task.project);
    const held = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(task.project) as { resource: string; taskId: string }[];
    const slots = new Set([...cardWorkerSlots(held, task.id), ...resources.filter((r) => r?.startsWith("slot:"))]);
    if (slots.size > 1) throw new LedgerError("conflict", "一张卡最多持有一个 worker 槽；后续派单须沿用已持有的槽");
    for (const resource of resources) {
      const used = held.find((row) => row.taskId !== task.id && resourcesOverlap(resource as string, row.resource));
      if (used) throw new LedgerError("conflict", `资源 ${resource} 与 ${used.resource} 重叠（${used.taskId} 占用）`);
    }
    const now = ctx.now ?? Date.now();
    // A peer writes the card now: the local worker slot it held since restate would count a remote writer against this
    // machine's cap. Coming back local (a fix without lease, a refused offer) takes a free slot again like any card.
    const released = isPoolIntent({ action: input.action, recipient }) && input.action === "dispatch" ? cardWorkerSlots(held, task.id) : [];
    for (const slot of released) db.query("DELETE FROM scheduler_resources WHERE taskId = ? AND resource = ?").run(task.id, slot);
    db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head,
      templateVersion, status, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
      id, task.id, task.project, node, input.action, recipient, input.causalSeq, task.rev, task.specRev, task.headSHA,
      workflow.templateVersion, reason, now, now,
    );
    for (const resource of resources) {
      if (held.some((row) => row.taskId === task.id && row.resource === resource)) continue;
      db.prepare("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES (?, ?, ?, ?, ?, ?)")
        .run(task.project, resource, task.id, id, now, cardResource(input.action, resource as string) ? "card" : "intent");
    }
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${id}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: reason,
      data: { op: "plan", id, node, action: input.action, recipient, resources, causalSeq: input.causalSeq,
        taskRev: task.rev, specRev: task.specRev, head: task.headSHA, template: workflow.template, version: workflow.templateVersion,
        ...(released.length ? { releasedSlots: released } : {}), ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    db.prepare("UPDATE scheduler_intents SET eventSeq = ? WHERE id = ?").run(event.seq, id);
    return { intent: getIntent(db, id) as SchedulerIntent, duplicate: false };
  });
}

/**
 * PM brake on a code v3 auto card (restate-hold / restate-release). One transaction with the write-order check: a planIntent that
 * lands first makes this refuse; one that lands after sees our event move the project seq and replans into the hold.
 */
export function recordRestateBrake(db: Database, ctx: WriteCtx, input: { taskId: string; op: "restate_hold" | "restate_released"; text: string }) {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const workflow = getWorkflow(db, task.id);
    if (workflow?.mode !== "auto" || workflow.templateVersion !== 3) {
      throw new LedgerError("invalid", `${task.id} 不是 code v3 自动卡：v2 本来就等 restate-approve，人工卡不经调度器`);
    }
    if (!["spec", "restate", "build"].includes(task.stage)) throw new LedgerError("conflict", `${task.id} 已在 ${task.stage}，复述闸已过；要停请用 workflow-set --mode manual`);
    // Any live write order (pending included: the tick may be sending it right now) means the brake can no longer stop it.
    const order = db.query(`SELECT id, status FROM scheduler_intents WHERE taskId = ? AND node = 'write' AND action = 'dispatch'
      AND specRev = ? AND status != 'cancelled' LIMIT 1`).get(task.id, task.specRev) as { id: string; status: string } | null;
    if (order) throw new LedgerError("conflict", `开工单 ${order.id} 已${order.status === "pending" ? "在发出中" : "发出"}，拦不住了；要停请用 workflow-set --mode manual`);
    const text = textOneLine(input.text, input.op === "restate_hold" ? "拦住原因" : "放行意见", 600);
    const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now() }, {
      project: task.project, target: task.id, kind: "decision", text, data: { op: input.op, specRev: task.specRev } }, true);
    return { event };
  });
}

/** A refused plan's reason: its whole first line; one too long to store is cut and tagged with the full line's digest, so it stays distinct. */
export const planRejectedReason = (error: string): string => {
  const line = (error.split("\n")[0] ?? "").replace(/\s+/g, " ").trim() || "（无错误文）";
  return line.length <= 560 ? line : `${line.slice(0, 540)}…#${createHash("sha256").update(line).digest("hex").slice(0, 16)}`;
};

/** Dedup key of a refused-plan alarm: card + reason (error code + first line), hashed because the reason is free text. */
const planRejectedKey = (taskId: string, code: string, text: string): string =>
  `scheduler:plan-rejected:${taskId}:${createHash("sha256").update(`${code}\n${text}`).digest("hex").slice(0, 24)}`;

/**
 * The auto tick's plan kept being refused for one reason: one scheduler event per card + reason so PM can see why the card stalls.
 * Scheduler-only; a second write for the same reason returns the first event (the notice itself is the tick's job).
 */
export function recordPlanRejected(db: Database, ctx: WriteCtx, input: { taskId: string; code: string; text: string }): { event: LedgerEvent; duplicate: boolean } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "计划拒收报警只由调度服务写");
  const code = textOneLine(input.code, "错误码", 40), text = textOneLine(input.text, "拒收原因", 600);
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const key = planRejectedKey(task.id, code, text);
    const prior = getEventByDedup(db, key);
    if (prior) return { event: prior, duplicate: true };
    const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, {
      project: task.project, target: task.id, kind: "scheduler", text: `调度计划被台账连续拒收：${text}`, data: { op: "plan_rejected", code, reason: text } }, true);
    return { event, duplicate: false };
  });
}
