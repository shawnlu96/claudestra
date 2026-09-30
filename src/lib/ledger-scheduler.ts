/** Read-side scheduler facts. The DAG keeps using task_deps and never infers edges from dispatch messages. */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { currentHandler } from "./ledger-handler.js";
import { getMeta, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";

export const WORKFLOW_TEMPLATES = ["code", "ui", "security"] as const;
export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number];
export const WORKFLOW_MODES = ["manual", "observe", "auto"] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
export const AUTHOR_FAMILIES = ["claude", "codex"] as const;
export type AuthorFamily = (typeof AUTHOR_FAMILIES)[number];
export const INTENT_ACTIONS = ["dispatch", "stage", "review", "ask", "merge", "verify", "escalate", "ensure_session", "retire"] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];
export const INTENT_STATUSES = ["pending", "submitted", "done", "unknown", "cancelled"] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Resources are names, not filesystem paths to open; reject aliases before the lock comparison. */
export function resourceKey(raw: string): string | null {
  const key = raw.toLowerCase();
  if (raw !== raw.trim() || !/^[\w./:*@-]{1,200}$/.test(raw) || key.includes("//") || /(^|\/)\.{1,2}(\/|$)/.test(key)) return null;
  return key;
}

/** Prefixes before '*' are necessary for any two supported globs to match the same path. */
export function resourcesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.includes("*") && !b.includes("*")) return false;
  const prefix = (s: string) => s.slice(0, s.indexOf("*") < 0 ? s.length : s.indexOf("*"));
  return prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a));
}

export interface TaskWorkflow {
  taskId: string;
  project: string;
  template: WorkflowTemplate;
  templateVersion: number;
  mode: WorkflowMode;
  authorFamily: AuthorFamily;
  fallback: string;
  specRev: number;
  rev: number;
  createdAt: number;
  updatedAt: number;
}

export interface SchedulerIntent {
  id: string;
  taskId: string;
  project: string;
  node: string;
  action: IntentAction;
  recipient: string | null;
  causalSeq: number;
  eventSeq: number;
  taskRev: number;
  specRev: number;
  head: string | null;
  templateVersion: number;
  status: IntentStatus;
  attempts: number;
  receipt: string | null;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

const hasTable = (db: Database, table: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

export function activationSeq(db: Database): number {
  if (!hasTable(db, "scheduler_meta")) return Number.MAX_SAFE_INTEGER;
  const row = db.query("SELECT value FROM scheduler_meta WHERE key = 'activationSeq'").get() as { value: string } | null;
  return row ? Number(row.value) : Number.MAX_SAFE_INTEGER;
}

export function taskCreationSeq(db: Database, taskId: string): number | null {
  const row = db.query("SELECT MIN(seq) AS seq FROM events WHERE target = ? AND kind = 'task' AND json_extract(data, '$.op') = 'new'")
    .get(taskId) as { seq: number | null };
  return row.seq;
}

export function getWorkflow(db: Database, taskId: string): TaskWorkflow | null {
  if (!hasTable(db, "task_workflows")) return null;
  return db.query("SELECT * FROM task_workflows WHERE taskId = ?").get(taskId) as TaskWorkflow | null;
}

export function getIntent(db: Database, id: string): SchedulerIntent | null {
  if (!hasTable(db, "scheduler_intents")) return null;
  return db.query("SELECT * FROM scheduler_intents WHERE id = ?").get(id) as SchedulerIntent | null;
}

function taskIntents(db: Database, taskId: string): SchedulerIntent[] {
  if (!hasTable(db, "scheduler_intents")) return [];
  return db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(taskId) as SchedulerIntent[];
}

export interface SchedulerTaskView {
  taskId: string;
  stage: LedgerTask["stage"];
  round: number;
  workflow: TaskWorkflow | null;
  latestIntent: SchedulerIntent | null;
  resources: string[];
  blockedBy: string[];
  handler: ReturnType<typeof currentHandler>;
  waitReason: string | null;
}

/** One read transaction produces edges, stage, handler and scheduler reason for a consistent v4 DAG snapshot. */
export function schedulerProjectView(db: Database, project: string): { asOfSeq: number; tasks: SchedulerTaskView[] } {
  return db.transaction(() => schedulerProjectSnapshot(db, project)).deferred();
}

function schedulerProjectSnapshot(db: Database, project: string): { asOfSeq: number; tasks: SchedulerTaskView[] } {
  const tasks = listTasks(db, project);
  const edges = depViews(listDeps(db, project), tasks);
  const meta = getMeta(db, project);
  const seq = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
  const resources = hasTable(db, "scheduler_resources")
    ? db.query("SELECT taskId, resource FROM scheduler_resources WHERE project = ? ORDER BY resource").all(project) as { taskId: string; resource: string }[]
    : [];
  return {
    asOfSeq: seq.seq,
    tasks: tasks.map((task) => {
      const workflow = getWorkflow(db, task.id);
      const intent = taskIntents(db, task.id).at(-1) ?? null;
      const blocked = blockedBy(task.id, edges).map((edge) => edge.from);
      const events = listEvents(db, { project, target: task.id });
      const baseHandler = currentHandler(task, events, { pms: meta.pms, dispatcher: meta.team?.dispatcher ?? null });
      const assigned = intent?.status === "submitted" && intent.recipient &&
        (intent.action === "review" ? task.stage === "review" : intent.action === "dispatch" && ["restate", "build", "fix"].includes(task.stage));
      const handler: ReturnType<typeof currentHandler> = assigned
        ? { role: intent.action === "review" ? "reviewer" : "executor", agent: intent.recipient, since: intent.createdAt, seq: intent.causalSeq }
        : baseHandler;
      const waitReason = meta.queueFrozen.frozen ? meta.queueFrozen.reason || "项目队列冻结"
        : blocked.length ? `等待前置任务：${blocked.join("、")}`
          : intent?.status === "unknown" ? `外部结果不明：${intent.reason}`
            : intent?.status === "pending" ? `等待投递：${intent.reason}` : null;
      return {
        taskId: task.id, stage: task.stage, round: task.round, workflow, latestIntent: intent,
        resources: resources.filter((r) => r.taskId === task.id).map((r) => r.resource), blockedBy: blocked, handler, waitReason,
      };
    }),
  };
}
