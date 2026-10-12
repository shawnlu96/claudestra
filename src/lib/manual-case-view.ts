/**
 * Read-only projection of the manual episodes (merge-arch-VIEW1, `ledger manual-queue`): every workflow-manual card with its MAN1
 * reason (manualEntry / diagnoseManual, no second reason parser), the raw sub-reason, blocking event, release condition, default owner
 * and due date (manual-case-defaults.ts), evidence gaps and the card's manual merge request. episodeId = seq of the formal entry event.
 * A card with no entry event is still listed, its start "unknown" (updatedAt is never passed off as the entry time). A card that looks
 * recoverable is only shown as a candidate with its gaps: nothing here plans, resumes, records, repairs or notifies.
 * tests/manual-case-view*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { endStages, type LedgerEvent, type LedgerTask, type Stage } from "./ledger-stages.js";
import { getMeta, getTask, listDeps, listEvents, listTasks } from "./ledger-store.js";
import { manualCaseDefaults, type ManualCaseDefaults } from "./manual-case-defaults.js";
import { manualQueueView, type TrainSignal } from "./manual-merge-queue.js";
import { diagnoseManual, isManualReasonCode, manualEntry, type ManualEntry, type ManualReasonCode, type ManualReasonRecord } from "./manual-reason.js";

/** The three different situations that all land on merge_unknown; each has its own way out. */
type MergeUnknownVariant = "cancel_retry" | "merge_bounce" | "unknown";

const MERGE_EXIT: Readonly<Record<MergeUnknownVariant, { label: string; release: string; next: string }>> = {
  cancel_retry: { label: "合并被取消 / 失败，待重试", release: "执行者交付新 head 后自动交回，或 PM 核对被取消合并的外部结果",
    next: "PM 核对被取消合并的外部结果后 ledger workflow-resume（或等执行者交付新 head 由调度自动交回）" },
  merge_bounce: { label: "合并反复退回（bounce 上限）", release: "冲突 / CI 退回的根因排除，PM 排期",
    next: "PM 排期解冲突 / 查 CI 退回原因后 ledger workflow-resume" },
  unknown: { label: "合并 / 部署结果真不明", release: "外部回执确认合并 / 部署结果",
    next: "ledger scheduler-merge-resolve 凭外部回执结清（结果未明前不交回）" },
};

export interface ManualCaseRow {
  taskId: string; title: string; stage: Stage; terminal: boolean; workflowRev: number;
  /** seq of the formal entry event; null = no entry event on record */
  episodeId: number | null;
  reasonCode: ManualReasonCode | null; label: string; subreason: string | null; mergeVariant: MergeUnknownVariant | null;
  text: string; structured: boolean;
  /** entry time; null = unknown */
  since: number | null; ageMin: number | null;
  owner: ManualCaseDefaults["owner"];
  due: ManualCaseDefaults["due"] & { overdue: boolean | null };
  blocking: ManualReasonRecord["blocking"]; release: string | null; nextStep: string;
  gaps: string[];
  /** release looks met on read-only facts: shown, never acted on */
  candidate: boolean;
  request: { seq: number; state: string; why: string | null } | null;
}

const HEAD = /^\s*([A-Za-z0-9_]+)\s*[:：]/;

/** The raw sub-reason under the code: a planner escalation code at the text head, or the resolve op and its outcome. */
function manualSubreason(entry: ManualEntry): string | null {
  const d = entry.event.data, op = String(d.op);
  if (op === "merge_resolve" || op === "deploy_resolve") return `${op}:${String(d.outcome)}`;
  for (const raw of [entry.record?.text, d.reason, d.takeover, d.hold]) {
    const head = typeof raw === "string" ? HEAD.exec(raw)?.[1] : undefined;
    if (head && !isManualReasonCode(head)) return head;
  }
  return null;
}

function mergeVariant(code: ManualReasonCode | null, sub: string | null): MergeUnknownVariant | null {
  if (code !== "merge_unknown") return null;
  if (sub === "merge_bounce_limit") return "merge_bounce";
  if (sub === "merge_retry_requires_pm" || /^(merge|deploy)_resolve:(cancelled|failed)$/.test(sub ?? "")) return "cancel_retry";
  return "unknown";
}

/** Cards with a merge / deploy journal still unknown (the same tables the patrol reads); undefined = not readable. */
function unknownJournal(db: Database, project: string): string[] | undefined {
  const ids: string[] = [];
  for (const table of ["scheduler_merges", "scheduler_deploys"]) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return undefined;
    ids.push(...(db.query(`SELECT taskId FROM ${table} WHERE project=? AND phase='unknown'`).all(project) as { taskId: string }[]).map((r) => r.taskId));
  }
  return ids;
}

interface ManualCaseFacts {
  meta: ReturnType<typeof getMeta>;
  blocked: (taskId: string) => string[];
  mergeUnknown: string[] | undefined;
  requests: Map<string, ManualCaseRow["request"]>;
  now: number;
}

function caseFacts(db: Database, project: string, train: TrainSignal, now: number): ManualCaseFacts {
  const deps = depViews(listDeps(db, project), listTasks(db, project));
  const requests = new Map<string, ManualCaseRow["request"]>();
  for (const r of manualQueueView(db, project, train, now).rows) requests.set(r.task, { seq: r.request, state: r.state, why: r.why });
  return { meta: getMeta(db, project), blocked: (id) => blockedBy(id, deps).map((d) => d.from), mergeUnknown: unknownJournal(db, project), requests, now };
}

const NO_ENTRY_NEXT = "PM 核对事件链后用 workflow-set --mode manual --reason \"<理由码>: 说明\" 补记理由（本视图不补记）";

/** One manual card's row; pure over the card, its own events and the project facts. */
function manualCaseRow(task: LedgerTask, workflowRev: number, events: readonly LedgerEvent[], f: ManualCaseFacts): ManualCaseRow {
  const terminal = endStages(task.kind).includes(task.stage);
  const entry = manualEntry(events);
  const code = entry?.code ?? null, sub = entry ? manualSubreason(entry) : null, variant = mergeVariant(code, sub);
  const since = entry?.event.ts ?? null;
  const d = manualCaseDefaults(code, since, task, f.meta);
  const diag = !terminal && entry ? diagnoseManual({ task, events, blockedBy: f.blocked(task.id), mergeUnknown: f.mergeUnknown }) : null;
  const gaps = entry ? [...(diag?.gaps ?? [])] : ["没有进入 manual 的正式事件，进入时间与理由未知"];
  if (entry && !code) gaps.push("理由未知：不按关键词猜，不扩大恢复授权");
  const exit = variant ? MERGE_EXIT[variant] : null;
  // the journal check in diagnoseManual only proves a real unknown settled; a cancelled retry / bounce has no read-only release proof
  const proofless = variant === "cancel_retry" || variant === "merge_bounce";
  if (proofless) gaps.push(`${exit!.label}：解除条件没有只读证据可核`);
  const release = exit?.release ?? diag?.release ?? entry?.record?.release ?? null;
  const nextStep = terminal ? `已到终态 ${task.stage}，无待处置` : !entry || !code ? NO_ENTRY_NEXT
    : exit ? `${exit.next}${gaps.length ? `；先补：${gaps[0]}` : ""}` : diag?.next ?? NO_ENTRY_NEXT;
  return {
    taskId: task.id, title: task.title, stage: task.stage, terminal, workflowRev, episodeId: entry?.event.seq ?? null,
    reasonCode: code, label: exit?.label ?? diag?.label ?? (code ?? "未知"), subreason: sub, mergeVariant: variant,
    text: (entry?.text ?? "").slice(0, 200), structured: !!entry?.record,
    since, ageMin: since === null ? null : Math.floor((f.now - since) / 60_000),
    owner: d.owner, due: { ...d.due, overdue: d.due.at === null || terminal ? null : f.now > d.due.at },
    blocking: entry?.record?.blocking ?? null, release, nextStep, gaps,
    candidate: !!diag?.wouldResume && !proofless, request: f.requests.get(task.id) ?? null,
  };
}

export interface ManualCaseView { project: string; active: ManualCaseRow[]; terminal: ManualCaseRow[] }

/** Every mode=manual card of the project, active (blocked / live included) and terminal apart, oldest episode first. */
export function manualCaseView(db: Database, project: string, train: TrainSignal, now: number): ManualCaseView {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_workflows'").get()) return { project, active: [], terminal: [] };
  const ids = db.query("SELECT taskId FROM task_workflows WHERE project = ? AND mode = 'manual' ORDER BY taskId").all(project) as { taskId: string }[];
  const f = caseFacts(db, project, train, now);
  const rows: ManualCaseRow[] = [];
  for (const { taskId } of ids) {
    const task = getTask(db, taskId), wf = getWorkflow(db, taskId);
    if (task && wf) rows.push(manualCaseRow(task, wf.rev, listEvents(db, { project, target: taskId }), f));
  }
  const order = (a: ManualCaseRow, b: ManualCaseRow) => (a.since ?? -1) - (b.since ?? -1) || a.taskId.localeCompare(b.taskId);
  return { project, active: rows.filter((r) => !r.terminal).sort(order), terminal: rows.filter((r) => r.terminal).sort(order) };
}
