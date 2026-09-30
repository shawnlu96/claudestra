/** Scheduler-only ledger writes: every decision and resource claim is one compare-and-swap transaction. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { blockedBy, depViews } from "./ledger-deps.js";
import {
  activationSeq, AUTHOR_FAMILIES, getIntent, getWorkflow, INTENT_ACTIONS, resourceKey, resourcesOverlap, taskCreationSeq,
  WORKFLOW_MODES, WORKFLOW_TEMPLATES, type AuthorFamily, type IntentAction, type SchedulerIntent,
  type TaskWorkflow, type WorkflowMode, type WorkflowTemplate,
} from "./ledger-scheduler.js";
import { getEventByDedup, getMeta, LedgerError, listDeps, listEvents, listTasks } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { closePoolOrders } from "./ledger-scheduler-pool.js";
import { actorMayConfigure, actorMaySchedule, textOneLine } from "./ledger-scheduler-settle.js";
import { cardWorkerSlots } from "./scheduler-worker-slot.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { poolAckSeq } from "./scheduler-pool-facts.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { bindHash, checkAsk } from "./ask-bind.js";
import { getAsk, ownerAnswered } from "./ledger-asks.js";

const projectSeq = (db: Database, project: string): number =>
  (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(project) as { seq: number }).seq;
const cardResource = (action: IntentAction, resource: string): boolean => action === "dispatch" && !resource.startsWith("task:");

function requireReviewedMerge(db: Database, task: ReturnType<typeof mustTask>, workflow: TaskWorkflow, node: string, now: number): void {
  if (task.stage !== "merge" || node !== "merge_deploy") throw new LedgerError("invalid", "merge 意图只许在 merge_deploy 节点");
  const read = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }));
  if (read.kind !== "facts" || read.facts.verdict === "block" ||
    read.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1") ||
    (read.facts.verdict === "changes" && !read.facts.findings.some((f) => f.severity === "P2"))) {
    throw new LedgerError("conflict", "合并前缺本轮同 head 的通过审查");
  }
  if (read.facts.reviewerFamily === workflow.authorFamily) throw new LedgerError("conflict", "合并前缺跨模型审查");
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
  if (workflow.template === "ui") {
    const digest = task.extra.screenshotsDigest;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) throw new LedgerError("conflict", "UI 前后截图摘要缺失");
    const params = { task: task.id, specRev: task.specRev, head: task.headSHA, screenshotsDigest: digest };
    const rows = db.query(`SELECT id FROM asks WHERE taskId = ? AND kind = 'authorize' AND state = 'answered'
      ORDER BY updatedAt DESC LIMIT 20`).all(task.id) as { id: string }[];
    const approved = rows.some(({ id }) => {
      const ask = getAsk(db, id);
      if (!ask || ask.fromAgent !== "scheduler" || ask.bind?.action !== "scheduler_ui_screenshot" || !ownerAnswered(ask.answer)) return false;
      return checkAsk(ask, bindHash({ ...ask.bind, params }, "scheduler"), "scheduler", now).ok;
    });
    if (!approved) throw new LedgerError("conflict", "缺同 head/specRev/摘要的 owner 截图授权");
  }
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
}

/** Historical cards are excluded by the migration watermark, even when still sitting in spec. */
export function setWorkflow(db: Database, ctx: WriteCtx, input: WorkflowInput): { workflow: TaskWorkflow; duplicate: boolean } {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (!actorMayConfigure(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能配置自动任务");
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
    if (input.templateVersion !== 2) throw new LedgerError("invalid", "当前只认模板版本 2");
    const fallback = textOneLine(input.fallback, "退路方案", 600);
    const data = { template: input.template, templateVersion: input.templateVersion, mode: input.mode, authorFamily: input.authorFamily, fallback };
    const unchanged = existing && existing.specRev === task.specRev && Object.entries(data).every(([k, v]) => existing[k as keyof TaskWorkflow] === v);
    if (unchanged) return { workflow: existing, duplicate: true };
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
        ...(pool && (pool.withdrawn.length || pool.stray.length) ? { poolOrders: pool } : {}), ...(takeover ? { takeover: textOneLine(input.reason as string, "接管原因", 600), manual: true } : {}) },
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
    if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("conflict", "项目合并队列已冻结");
    const blocked = blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project)));
    if (blocked.length) throw new LedgerError("conflict", `任务被前置挡住：${blocked.map((d) => d.from).join("、")}`);
    if (!INTENT_ACTIONS.includes(input.action)) throw new LedgerError("invalid", "调度动作不认识");
    if (input.action === "merge") {
      const entered = db.query(`SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE target = ? AND kind = 'stage'
        AND json_extract(data, '$.to') = 'merge'`).get(task.id) as { seq: number };
      const cancelled = db.query(`SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'merge'
        AND status = 'cancelled' AND causalSeq >= ? LIMIT 1`).get(task.id, entered.seq);
      if (cancelled) throw new LedgerError("conflict", "本轮已取消合并意图，自动重试禁用；请 PM 手动核对并接管");
      requireReviewedMerge(db, task, workflow, node, ctx.now ?? Date.now());
    }
    const live = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1")
      .get(task.id) as { id: string } | null;
    if (live) throw new LedgerError("conflict", `任务已有未结调度意图 ${live.id}`);
    const held = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(task.project) as { resource: string; taskId: string }[];
    const slots = new Set([...cardWorkerSlots(held, task.id), ...resources.filter((r) => r?.startsWith("slot:"))]);
    if (slots.size > 1) throw new LedgerError("conflict", "一张卡最多持有一个 worker 槽；后续派单须沿用已持有的槽");
    for (const resource of resources) {
      const used = held.find((row) => row.taskId !== task.id && resourcesOverlap(resource as string, row.resource));
      if (used) throw new LedgerError("conflict", `资源 ${resource} 与 ${used.resource} 重叠（${used.taskId} 占用）`);
    }
    const now = ctx.now ?? Date.now();
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
        ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    db.prepare("UPDATE scheduler_intents SET eventSeq = ? WHERE id = ?").run(event.seq, id);
    return { intent: getIntent(db, id) as SchedulerIntent, duplicate: false };
  });
}
