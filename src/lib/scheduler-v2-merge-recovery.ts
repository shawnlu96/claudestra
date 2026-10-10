import { randomUUID } from "node:crypto";
import type { CiBehindGh } from "./scheduler-merge-ci-behind.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";
import { assertLocalOwner, centralEnvelope, centralVersions, parseSchedulerCentralContext,
  type SchedulerCentralContext } from "./scheduler-central-context.js";
import { schedulerCentralResult } from "./scheduler-central-gate.js";
import { parseCommand, parseReceipt, v2ObjectDigest, type V2Command } from "./shared-ledger-contract-v2.js";
import { localMergeTask, mergeContext, mergeReason, schedulerV2MergePort, SchedulerV2MergeWait, taskRoute,
  type MergeProject } from "./scheduler-v2-merge-context.js";
import { parseSchedulerV2MergeSha, runMergeOperation } from "./scheduler-v2-merge-operation.js";

/** CI-red branch updates bypass MergeExternal in the driver. S2F installs this on its ciBehind dependency. */
export function wrapSchedulerV2MergeGh(gh: CiBehindGh, project: MergeProject, external: MergeExternal): CiBehindGh {
  return { ...gh, async updateBranch(repo, pull, head) {
    const port = schedulerV2MergePort(), pr = `https://github.com/${repo}/pull/${pull}`;
    let taskId = "", legacy = false;
    try {
      const task = port?.taskForPr ? port.taskForPr(pr, project) : localMergeTask(pr);
      taskId = task?.taskId ?? "";
      if (!task || taskRoute(port, task) === "local") { legacy = true; return await gh.updateBranch(repo, pull, head); }
      if (!port) throw new SchedulerV2MergeWait("unavailable");
      await runMergeOperation({ port, ...mergeContext(port, task, head), pr, action: "updateBranch",
        external: { ...external, updateBranch: () => gh.updateBranch(repo, pull, head) }, assertRoute: () => {
          if (schedulerV2MergePort() !== port || taskRoute(port, task) !== "central") throw new SchedulerV2MergeWait("route_changed");
        } });
    } catch (error) {
      if (!taskId || legacy) throw error; // An unrelated legacy gh failure retains its original semantics.
      port?.observe?.({ taskId, action: "updateBranch", reason: `等待中心合并：${mergeReason(error)}` });
      // The old CI helper interprets a rejection as a bounce; held central updates return without sending instead.
    }
  } };
}

function matchingRecoveryReceipt(raw: unknown, command: V2Command, instanceId: string): void {
  const receipt = parseReceipt(raw);
  const operationId = command.type === "operation.reconcile" ? command.payload.operationId : null;
  if (receipt.teamId !== command.teamId || receipt.projectId !== command.projectId || receipt.requestId !== command.requestId
    || receipt.command !== command.type || receipt.commandDigest !== v2ObjectDigest(command)
    || receipt.serviceGeneration !== command.serviceGeneration || receipt.result.epoch !== command.epoch
    || receipt.result.operationId !== operationId || receipt.instanceId !== instanceId) throw new SchedulerV2MergeWait("unavailable");
}

/** S2F/S2Q call before driving a restarted merging row. reconcileCommand must be an authenticated OWNER client;
 * the scheduler service cannot impersonate the owner or turn a local outbox into authorization.
 */
export async function reconcileSchedulerV2MergeOutbox(intentId: string, external: MergeExternal): Promise<{
  state: "wait" | "succeeded"; reason: string; mergeSha: string | null;
}> {
  const wait = (reason: string) => ({ state: "wait" as const, reason, mergeSha: null });
  const port = schedulerV2MergePort();
  const input = port?.contextForIntent?.(intentId), pr = port?.prForIntent?.(intentId);
  if (!port || !input || !pr || !port.journal || !port.reconcileCommand) return wait("v2_unmapped");
  let c: SchedulerCentralContext | null = null;
  try {
    c = parseSchedulerCentralContext(input);
    if (c.intentId !== intentId || c.action !== "merge") return wait("authorization_mismatch");
    const active = () => {
      if (schedulerV2MergePort() !== port || port.route(c!.taskId) !== "central") throw new SchedulerV2MergeWait("skip");
    };
    active();
    const runtime = port.runtime?.(c.taskId), entry = port.journal.read(c);
    if (!runtime || !entry) return wait("v2_unmapped");
    const recorded = entry.result && parseSchedulerV2MergeSha(entry.result.summary);
    if (entry.state === "confirmed" && entry.result?.state === "succeeded" && recorded) {
      return { state: "succeeded", reason: "recorded_result", mergeSha: recorded };
    }
    const snapshot = await external.inspect(pr);
    active();
    if (snapshot.state !== "MERGED" || snapshot.base !== "main" || snapshot.head !== c.head
      || !snapshot.mergeSha || !/^[a-f0-9]{40}$/i.test(snapshot.mergeSha)) return wait("unknown_operation");
    const result = schedulerCentralResult(c, { state: "succeeded", head: c.head,
      summary: `mergeSha:${snapshot.mergeSha.toLowerCase()}`, artifactIds: [] }, entry.result?.observedAt ?? Date.now());
    // Persist the exact reconcile command's material before sending so a lost response reuses its digest and requestId.
    entry.result = result; entry.state = "unknown"; port.journal.write(entry);
    const authorization = parseCommand({ ...centralEnvelope(c), requestId: randomUUID(), type: "authorization.check",
      payload: { ...centralVersions(c), askId: c.authorizationAskId, bind: c.authorizationBind, action: "merge" } });
    assertLocalOwner(c, runtime);
    matchingRecoveryReceipt(await runtime.client.command(authorization as Extract<V2Command, { type: "authorization.check" }>), authorization, runtime.instanceId);
    active(); assertLocalOwner(c, runtime);
    const command = parseCommand({ ...centralEnvelope(c), requestId: `reconcile-${v2ObjectDigest(result)}`, type: "operation.reconcile",
      payload: { ...centralVersions(c), intentId: c.intentId, operationId: c.operationId, result, authorizationAskId: c.authorizationAskId } }) as
      Extract<V2Command, { type: "operation.reconcile" }>;
    matchingRecoveryReceipt(await port.reconcileCommand(command), command, runtime.instanceId);
    entry.state = "confirmed"; port.journal.write(entry);
    return { state: "succeeded", reason: "reconciled", mergeSha: snapshot.mergeSha.toLowerCase() };
  } catch (error) {
    const reason = mergeReason(error);
    port.observe?.({ taskId: c?.taskId ?? input.taskId, action: "merge", reason: `等待中心合并：${reason}` });
    return wait(reason);
  }
}
