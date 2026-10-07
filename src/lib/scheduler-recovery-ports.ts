/** Scheduler recovery reads its reader; the leased manager owns every recovery write. */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import { getTask, LedgerError } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { manualResumeTick, type ManualResumeDeps } from "./manual-resume.js";
import type { ObservedAction } from "./recovery-policy.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { RecoveryFence } from "./scheduler-recovery-write.js";

export type RecoveryManager = (...args: string[]) => Promise<Record<string, unknown>>;

export function recoveryFence(db: Database, task: LedgerTask): RecoveryFence {
  const workflow = getWorkflow(db, task.id);
  if (!workflow) throw new LedgerError("not_found", "缺任务流程");
  return { taskId: task.id, taskRev: task.rev, workflowRev: workflow.rev, head: task.headSHA, round: task.round, specRev: task.specRev };
}

export const recoveryArgs = (f: RecoveryFence): string[] => [f.taskId, "--rev", String(f.taskRev), "--workflow-rev", String(f.workflowRev),
  "--head", f.head ?? "-", "--round", String(f.round), "--spec-rev", String(f.specRev)];

export async function recoveryWrite(manager: RecoveryManager, command: string, args: string[], cardRefusal = false): Promise<Record<string, unknown>> {
  const r = await manager("ledger", command, ...args);
  if (r.code === "lease-lost") throw new SchedulerStopped(`${command}: ${String(r.error)}`);
  if (r.ok !== true) {
    const message = `${command} [${String(r.code ?? "unknown")}]: ${String(r.error ?? "没有成功结果")}`;
    // MAN2 continues after a business refusal; invalid also carries raw SQLite failures, so it must still escape.
    if (cardRefusal && (r.code === "conflict" || r.code === "forbidden" || r.code === "not_found")) throw new LedgerError(r.code, message);
    throw new Error(message);
  }
  return r;
}

export async function manualResumeManagerTick(db: Database, projects: Record<string, { maxActiveWorkers: number }>,
  deps: Pick<ManualResumeDeps, "notifyPm" | "now"> & { manager: RecoveryManager; recoveryPolicy?: ManualResumeDeps["policy"] }, yieldNow?: () => boolean) {
  const write = (taskId: string, mode: string, reason: string, maxWorkers: number) => {
    const task = getTask(db, taskId);
    if (!task) throw new LedgerError("not_found", `没有任务 ${taskId}`);
    return recoveryWrite(deps.manager, "scheduler-manual-resume", [...recoveryArgs(recoveryFence(db, task)),
      "--mode", mode, "--reason", reason, "--max-workers", String(maxWorkers)], true);
  };
  return manualResumeTick(db, projects, { notifyPm: deps.notifyPm, now: deps.now, policy: deps.recoveryPolicy, yieldNow,
    resume: (_db, _ctx, input) => write(input.taskId, "on", input.reason, input.maxWorkers),
    observe: async (_db, action: ObservedAction) => {
      const task = getTask(db, action.target), wf = task && getWorkflow(db, task.id);
      if (!task || !wf) throw new LedgerError("not_found", "观察任务已不存在");
      const reason = action.action.slice(`把 ${task.id} 交回自动：`.length);
      const r = await write(task.id, "observe", reason, projects[task.project]!.maxActiveWorkers);
      return { recorded: r.recorded === true };
    },
  });
}
