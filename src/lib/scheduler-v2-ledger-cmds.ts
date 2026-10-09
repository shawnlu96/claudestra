import type { Database } from "bun:sqlite";
import { getIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { parseFence, type V2Fence, type V2ResourceKey } from "./shared-ledger-contract-v2.js";
import type { SharedLedgerExecClient } from "./shared-ledger-exec-client.js";
import { schedulerV2LedgerCall, schedulerV2LedgerClaimFence, schedulerV2LedgerFlags } from "./scheduler-v2-ledger-cmds-args.js";
import { schedulerV2LedgerLocal } from "./scheduler-v2-ledger-cmds-local.js";
import { schedulerV2LedgerCentral } from "./scheduler-v2-ledger-cmds-central.js";
import { retireIntentId } from "./scheduler-sessions.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { PlanIntentInput } from "./ledger-scheduler-write.js";

export type SchedulerV2LedgerManager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface SchedulerV2LedgerContext {
  teamId: string; projectId: string; serviceGeneration: number; bootId: string; homeInstanceId: string; fence: V2Fence;
}
interface SchedulerV2LedgerPlanData { dependencyDigest: string; resources: V2ResourceKey[] }
interface SchedulerV2ExecutorRef { featureId: string; taskId: string; fence: V2Fence; claimFence: V2Fence | null }
/** scope keeps its frozen fn-only signature; the callback carries the reference S2F passes to withExecutorScope. */
export interface SchedulerV2ExecutorCall<T> { (): T; executor: { db: Database; ref: SchedulerV2ExecutorRef } }
export interface SchedulerV2LedgerPort {
  route(taskId: string): "local" | "skip" | "central";
  clientFor(project: string): Pick<SharedLedgerExecClient, "command"> | null;
  fence(featureId: string): V2Fence | null;
  sync(project: string, featureId: string): Promise<void>;
  db(): Database;
  context?(project: string, featureId: string): SchedulerV2LedgerContext | null;
  scope?<T>(fn: () => T): T;
  /** Original submitted fence from the trusted center projection, never the current lease or a worker receipt. */
  claimFence?(project: string, intentId: string): V2Fence | null;
  /** Translate locks; retain proposal in scheduler:<id> event data.plan only on committed sync, for legacy replay comparison. */
  planData?(project: string, taskId: string, intentId: string, resources: readonly string[], proposal?: PlanIntentInput): SchedulerV2LedgerPlanData | null;
  /** Runs the existing read-only checklist; successful verification still needs a committed central task.stage. */
  verify?(task: LedgerTask, args: readonly string[]): Promise<Record<string, unknown>>;
  registryPath?: string;
  observe?(taskId: string, code: string): void;
}

const localActions = new Set(["ensure_session", "retire"]), centralActions = new Set(["dispatch", "stage", "review", "merge", "verify"]);
const reason = (error: unknown): string => error && typeof error === "object" && "code" in error && typeof error.code === "string"
  ? error.code : "unavailable";
function sameFence(a: V2Fence, b: V2Fence): boolean {
  return a.epoch === b.epoch && a.bootId === b.bootId && a.serviceGeneration === b.serviceGeneration;
}

/** Wrap both scheduler managers with the same port. Only central cards are intercepted; no child inherits executor tokens. */
export function withSchedulerV2LedgerCmds(manager: SchedulerV2LedgerManager, port: SchedulerV2LedgerPort): SchedulerV2LedgerManager {
  return async (...args) => {
    const db = port.db(), call = schedulerV2LedgerCall(db, args);
    if (!call || port.route(call.taskId) !== "central") return manager(...args);
    const held = (code = "v2_unmapped") => {
      if (port.observe) port.observe(call.taskId, code);
      else console.warn(`[scheduler-v2-ledger] ${call.taskId}: ${code}`);
      return { ok: false, code };
    };
    if (call.handling === "unmapped") return held();
    try {
      const task = getTask(db, call.taskId);
      if (!task) return { ok: false, code: "not_found" };
      const featureId = task.featureId ?? task.extra.sharedFeatureId;
      if (typeof featureId !== "string" || !featureId) return held();
      const fence = port.fence(featureId);
      if (!fence) return { ok: false, code: "lease_lost" };
      const context = port.context?.(task.project, featureId);
      if (!context) return held();
      const intent = call.intentId ? getIntent(db, call.intentId) : null;
      let action = intent?.action;
      if (call.command === "scheduler-plan") {
        action = schedulerV2LedgerFlags(args, ["id", "rev", "workflow-rev", "seq", "node", "action", "recipient", "reason", "resources"]).need("action") as typeof action;
        if (!localActions.has(action!) && !centralActions.has(action!)) return held();
      }
      if (call.command === "scheduler-settle" && !localActions.has(action!) && !centralActions.has(action!)) return held();
      const local = call.handling === "executor" || (call.handling === "mixed" && localActions.has(action!));
      if (!local) return await schedulerV2LedgerCentral(db, port, context, task, call, args, held);
      if (!port.scope) return held();
      parseFence(fence);
      let id = call.intentId;
      if (call.command === "scheduler-retire") id = retireIntentId(task.id);
      if (call.command === "scheduler-plan") {
        id = schedulerV2LedgerFlags(args, ["id", "rev", "workflow-rev", "seq", "node", "action", "recipient", "reason", "resources"]).need("id");
      }
      const mergeJournal = call.command === "scheduler-merge-begin" || call.command === "scheduler-merge-step";
      const rawClaim = mergeJournal ? port.claimFence?.(task.project, id!) ?? null : id ? schedulerV2LedgerClaimFence(db, id) : null;
      if (mergeJournal && rawClaim === null) return held();
      const claimFence = rawClaim === null ? null : parseFence(rawClaim);
      if (claimFence && !sameFence(fence, claimFence)) {
        const p = call.command === "scheduler-settle" ? schedulerV2LedgerFlags(args, ["from", "to", "receipt"]) : null;
        if (p?.need("from") !== "submitted" || p.need("to") !== "unknown") return { ok: false, code: "stale_claim" };
      }
      const fn: SchedulerV2ExecutorCall<Record<string, unknown>> = Object.assign(
        () => schedulerV2LedgerLocal(db, call, args, port.registryPath),
        { executor: { db, ref: { featureId, taskId: task.id, fence, claimFence } } },
      );
      return port.scope(fn);
    } catch (error) {
      return { ok: false, code: reason(error) };
    }
  };
}
