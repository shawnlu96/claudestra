import type { MergeExternal } from "./scheduler-merge-driver.js";
import {
  localMergeTask, mergeContext, mergeReason, SchedulerV2MergeWait, schedulerV2MergePort, taskRoute,
  type MergeProject, type MergeTaskRef, type SchedulerV2MergePort,
} from "./scheduler-v2-merge-context.js";
import { runMergeOperation } from "./scheduler-v2-merge-operation.js";
import { checkSchedulerCentral } from "./scheduler-central-gate.js";

export type { SchedulerV2MergePort } from "./scheduler-v2-merge-context.js";
export { SchedulerV2MergeWait } from "./scheduler-v2-merge-context.js";
export { configureSchedulerV2Merge } from "./scheduler-v2-merge-context.js";
export { parseSchedulerV2MergeSha } from "./scheduler-v2-merge-operation.js";
export { wrapSchedulerV2MergeGh, reconcileSchedulerV2MergeOutbox } from "./scheduler-v2-merge-recovery.js";

/** Readers stay byte-for-byte transparent. Every mutation resolves the current projection and route again. */
export function withSchedulerV2Merge(external: MergeExternal, project: MergeProject): MergeExternal {
  const run = async (pr: string, action: "merge" | "updateBranch", expectedHead?: string): Promise<string | void> => {
    const port = schedulerV2MergePort();
    let task: MergeTaskRef | null = null;
    try {
      task = port?.taskForPr ? port.taskForPr(pr, project) : localMergeTask(pr);
      if (!task || taskRoute(port, task) === "local") {
        if (task) port?.observe?.({ taskId: task.taskId, action, reason: "local：沿用阶段一合并路径" });
        return action === "merge" ? external.merge(pr, expectedHead!) : external.updateBranch(pr);
      }
      if (!port) throw new SchedulerV2MergeWait("unavailable");
      // updateBranch has no head parameter; inspecting is read-only and the center still checks its exact binding.
      const head = expectedHead ?? (await external.inspect(pr)).head;
      const bound = mergeContext(port, task, head);
      return await runMergeOperation({ port, ...bound, external, pr, action, assertRoute: () => {
        if (schedulerV2MergePort() !== port || taskRoute(port, task!) !== "central") throw new SchedulerV2MergeWait("route_changed");
      } });
    } catch (error) {
      if (task) port?.observe?.({ taskId: task.taskId, action, reason: mergeReason(error) });
      if (error instanceof SchedulerV2MergeWait) throw error;
      throw new SchedulerV2MergeWait(mergeReason(error));
    }
  };
  const gate: NonNullable<MergeExternal["train"]> = async (merge) => {
    const port = schedulerV2MergePort();
    let task: MergeTaskRef | null = null;
    try {
      task = port?.taskForPr ? port.taskForPr(merge.prRef, project) : localMergeTask(merge.prRef);
      if (task && taskRoute(port, task) === "central") {
        if (!port) throw new SchedulerV2MergeWait("unavailable");
        const { context, runtime, journal } = mergeContext(port, task, merge.reviewedHead);
        if (journal.read(context)) throw new SchedulerV2MergeWait("unknown_operation：已有副作用记录，须先对账");
        await checkSchedulerCentral(context, runtime);
        if (schedulerV2MergePort() !== port || taskRoute(port, task) !== "central") throw new SchedulerV2MergeWait("route_changed");
      }
    } catch (error) {
      port?.observe?.({ taskId: task?.taskId ?? merge.taskId, action: "merge", reason: `等待中心合并：${mergeReason(error)}` });
      return "wait";
    }
    return external.train ? external.train(merge) : null;
  };
  return { ...external, train: gate, merge: (pr, head) => run(pr, "merge", head) as Promise<string>,
    updateBranch: (pr) => run(pr, "updateBranch") as Promise<void> };
}
