/**
 * `ledger merge-queue`（i28-MQ2）：只读列出项目合并队列，顺序就是自动 tick 挑卡的顺序（同一个 mergeFirst）。
 * 不写库、不调 gh：被挡的原因只复述计划器 / planIntent 已有的文字，不另做判定。
 */
import type { Database } from "bun:sqlite";
import { resourcesOverlap, type SchedulerIntent } from "../lib/ledger-scheduler.js";
import { getTask } from "../lib/ledger-store.js";
import { autoSnapshot } from "../lib/scheduler-auto-snapshot.js";
import { getMergeRun } from "../lib/scheduler-merge.js";
import { mergeEntry, mergeFirst } from "../lib/scheduler-merge-order.js";
import { planScheduler } from "../lib/scheduler-plan.js";
import { paceCards } from "../lib/scheduler-yield.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

interface MergeQueueRow { task: string; enteredAt: number | null; waitedMin: number | null; phase: string; blocked: string | null }

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

function mergeQueue(db: Database, project: string, now: number): MergeQueueRow[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return [];
  return mergeFirst(db, paceCards(db, { [project]: null }, "auto")).filter((c) => getTask(db, c.taskId)?.stage === "merge").map(({ taskId }) => {
    const entry = mergeEntry(db, taskId), open = openIntent(db, taskId);
    const base = { task: taskId, enteredAt: entry?.ts ?? null, waitedMin: entry ? Math.floor((now - entry.ts) / 60_000) : null };
    if (open?.status === "unknown") return { ...base, phase: "unknown", blocked: `外部结果不明，等 PM 核对：${open.receipt ?? open.reason}` };
    if (open?.action === "merge") return { ...base, phase: getMergeRun(db, open.id)?.phase ?? open.status, blocked: null };
    if (open) return { ...base, phase: "排队", blocked: `任务已有未结调度意图 ${open.id}` };
    return { ...base, phase: "排队", blocked: blockedReason(db, taskId, project, now) };
  });
}

export const MERGE_QUEUE_CMDS: Record<string, CommandSpec> = {
  "merge-queue": {
    valued: ["project"], bools: [],
    usage: "merge-queue [--project <id>]（只读：当前合并队列，按自动 tick 挑卡的先后；每张卡进 merge 的时间、已等分钟、合并意图阶段、被挡原因）",
    run(c) {
      const project = c.project(), now = c.deps.now();
      const rows = mergeQueue(c.db, project, now);
      const lines = rows.map((r, i) => `${i + 1}. ${r.task}｜进 merge ${r.enteredAt === null ? "?" : new Date(r.enteredAt).toISOString()}` +
        `｜已等 ${r.waitedMin ?? "?"} 分钟｜${r.phase}${r.blocked ? `｜挡：${r.blocked}` : ""}`);
      return { ok: true, project, rows, lines };
    },
  },
};
