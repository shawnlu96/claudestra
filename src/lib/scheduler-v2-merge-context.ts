import { LedgerReader } from "./ledger-read.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";
import { STATE_DIR } from "./paths.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { parseSchedulerCentralContext, type SchedulerCentralContext, type SchedulerCentralRuntime } from "./scheduler-central-context.js";
import { SchedulerCentralJournal, type SchedulerCentralJournalEntry } from "./scheduler-central-journal.js";
import { V2ContractError, type V2OperationResult, type V2Command } from "./shared-ledger-contract-v2.js";
import type { SchedulerConfig } from "./scheduler-config.js";

export type MergeProject = SchedulerConfig["projects"][string];
export interface MergeTaskRef { taskId: string; projectId: string; featureId: string | null; centerFeatureId?: string }
export interface SchedulerV2MergePort {
  route(taskId: string): "local" | "skip" | "central";
  taskForPr?(pr: string, project: MergeProject): MergeTaskRef | null;
  context?(taskId: string, expectedHead: string): SchedulerCentralContext | null;
  runtime?(taskId: string): SchedulerCentralRuntime | null;
  journal?: SchedulerCentralJournal;
  reconcile?(context: SchedulerCentralContext, entry: SchedulerCentralJournalEntry): Promise<V2OperationResult | null>;
  contextForIntent?(intentId: string): SchedulerCentralContext | null;
  prForIntent?(intentId: string): string | null;
  reconcileCommand?(command: Extract<V2Command, { type: "operation.reconcile" }>): Promise<unknown>;
  observe?(decision: { taskId: string; action: "merge" | "updateBranch"; reason: string }): void;
}
let configured: SchedulerV2MergePort | null = null;
export function configureSchedulerV2Merge(port: SchedulerV2MergePort | null): void { configured = port; }
export function schedulerV2MergePort(): SchedulerV2MergePort | null { return configured; }

export function taskRoute(port: SchedulerV2MergePort | null, task: MergeTaskRef): "local" | "central" {
  const route = port ? port.route(task.taskId) : unwiredRoute(task);
  if (route === "skip") throw new SchedulerV2MergeWait(port ? "skip：execution 暂停或 feature 正在 migrating" : "unavailable");
  return route;
}

/** The existing driver propagates SchedulerStopped instead of treating a held, unsent update as a conflict. */
export class SchedulerV2MergeWait extends SchedulerStopped {
  readonly state = "wait";
  constructor(readonly reason: string) { super(`等待中心合并：${reason}`); this.name = "SchedulerV2MergeWait"; }
}
export const mergeReason = (error: unknown): string => error instanceof SchedulerV2MergeWait ? error.reason
  : error instanceof V2ContractError ? error.code : error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "unavailable";

/** Only the local read projection is consulted when wiring is absent; it can never authorize execution. */
export function localMergeTask(pr: string): MergeTaskRef | null {
  const reader = new LedgerReader();
  try {
    const db = reader.get();
    if (!db) return null;
    const rows = db.query("SELECT id, project, featureId FROM tasks WHERE rtrim(pr, '/') = ? COLLATE NOCASE").all(pr.replace(/\/$/, "")) as
      { id: string; project: string; featureId: string | null }[];
    if (rows.length > 1) throw new SchedulerV2MergeWait("PR 对应多张卡，无法确定授权绑定");
    const row = rows[0];
    return row ? { taskId: row.id, projectId: row.project, featureId: row.featureId } : null;
  } finally { reader.close(); }
}

function unwiredRoute(task: MergeTaskRef): "local" | "skip" {
  if (!task.featureId) return "local";
  const mode = readSharedLedgerMode(task.featureId, STATE_DIR);
  // S2G owns the extended mode schema; reading a freeze here also protects the unwired case.
  if ((mode as typeof mode & { migrating?: unknown }).migrating) throw new SchedulerV2MergeWait("migrating");
  return mode.authorityMode === "execution" ? "skip" : "local";
}

export function mergeContext(port: SchedulerV2MergePort, task: MergeTaskRef, head: string) {
  const input = port.context?.(task.taskId, head), runtime = port.runtime?.(task.taskId);
  if (!input || !runtime || !port.journal) throw new SchedulerV2MergeWait("v2_unmapped：缺少意图、运行上下文或持久日志");
  const context = parseSchedulerCentralContext(input);
  if (context.action !== "merge" || context.head !== head || context.taskId !== task.taskId
    || context.authorizationBind.featureId !== (task.centerFeatureId ?? task.featureId)) throw new SchedulerV2MergeWait("authorization_mismatch");
  return { context, runtime, journal: port.journal };
}
