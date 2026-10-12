/**
 * `ledger merge-queue`（i28-MQ2）的只读队列：顺序就是自动 tick 挑卡的顺序（同一个 mergeFirst）。不写库、不调 gh：被挡的原因只复述计划器 /
 * planIntent 已有的文字，不另做判定。命令（manager/ledger-merge-queue-cmds.ts）与 WIP 闸（scheduler-wip-gate.ts）共用这一份：
 * 闸的深度就是 mergeQueueCards 的张数 = 命令 rows 的行数（rows 由它逐张映射），不另写 SQL 计数。
 */
import type { Database } from "bun:sqlite";
import { resourcesOverlap, type SchedulerIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { mergeQueueFacts, type QueueEntry } from "./merge-queue-facts.js";
import { getMergeRun } from "./scheduler-merge.js";
import { mergeEntry, mergeFirst } from "./scheduler-merge-order.js";
import { planScheduler } from "./scheduler-plan.js";
import { paceCards } from "./scheduler-yield.js";

export interface MergeQueueRow { task: string; enteredAt: number | null; waitedMin: number | null; phase: string; blocked: string | null }

function openIntent(db: Database, taskId: string): SchedulerIntent | null {
  return db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')
    ORDER BY eventSeq DESC LIMIT 1`).get(taskId) as SchedulerIntent | null;
}

/** Why a card with no open intent would not get the merge lock this round: the planner's reason, else planIntent's overlap text. */
function blockedReason(db: Database, taskId: string, project: string, now: number): string | null {
  const task = getTask(db, taskId)!;
  const plan = planScheduler(autoSnapshot(db, task, { registry: [], maxWorkers: 0, now }));
  if (plan.kind !== "intent") return plan.reason;
  const held = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(project) as { resource: string; taskId: string }[];
  for (const resource of plan.resources) {
    const used = held.find((row) => row.taskId !== taskId && resourcesOverlap(resource, row.resource));
    if (used) return `资源 ${resource} 与 ${used.resource} 重叠（${used.taskId} 占用）`;
  }
  return null;
}

/** 项目合并队列里的 auto 卡（占车、排队、unknown、被挡都在），按自动 tick 挑卡的先后；人工合并请求不在这里 */
export function mergeQueueCards(db: Database, project: string): { taskId: string }[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return [];
  return mergeFirst(db, paceCards(db, { [project]: null }, "auto")).filter((c) => getTask(db, c.taskId)?.stage === "merge");
}

export function mergeQueue(db: Database, project: string, now: number): MergeQueueRow[] {
  return mergeQueueCards(db, project).map(({ taskId }) => {
    const entry = mergeEntry(db, taskId), open = openIntent(db, taskId);
    const base = { task: taskId, enteredAt: entry?.ts ?? null, waitedMin: entry ? Math.floor((now - entry.ts) / 60_000) : null };
    if (open?.status === "unknown") return { ...base, phase: "unknown", blocked: `外部结果不明，等 PM 核对：${open.receipt ?? open.reason}` };
    if (open?.action === "merge") return { ...base, phase: getMergeRun(db, open.id)?.phase ?? open.status, blocked: null };
    if (open) return { ...base, phase: "排队", blocked: `任务已有未结调度意图 ${open.id}` };
    return { ...base, phase: "排队", blocked: blockedReason(db, taskId, project, now) };
  });
}

/** merge-arch-QUEUE1：auto + 人工的统一只读队列（merge-queue-facts.ts）；上面的 rows 与 WIP 闸深度原样不变，这里不接入任何路由 */
export const unifiedMergeQueue = (db: Database, project: string, now: number): QueueEntry[] => mergeQueueFacts(db, project, now);
