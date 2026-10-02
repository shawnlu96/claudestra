import { randomUUID } from "node:crypto";
import { fail, parseCommand, parseOperationResult, parseReceipt, v2ObjectDigest, type V2OperationResult } from "./shared-ledger-contract-v2.js";
import {
  assertLocalOwner, authorizationAction, centralEnvelope, centralVersions, parseSchedulerCentralContext,
  type SchedulerCentralCommand, type SchedulerCentralContext, type SchedulerCentralObservation, type SchedulerCentralRuntime,
} from "./scheduler-central-context.js";

/** A transport success alone is not a matching fenced receipt. Invalid or lost receipts always stop execution. */
async function checkedCommand(runtime: SchedulerCentralRuntime, command: SchedulerCentralCommand): Promise<void> {
  const parsed = parseCommand(command);
  const receipt = parseReceipt(await runtime.client.command(command));
  if (receipt.teamId !== parsed.teamId || receipt.projectId !== parsed.projectId || receipt.requestId !== parsed.requestId
    || receipt.command !== parsed.type || receipt.commandDigest !== v2ObjectDigest(parsed)
    || receipt.serviceGeneration !== parsed.serviceGeneration || receipt.result.epoch !== parsed.epoch
    || receipt.instanceId !== runtime.instanceId) fail("unavailable");
  if ((command.type === "intent.check" && receipt.result.operationId !== command.payload.operationId)
    || (command.type === "operation.result" && receipt.result.operationId !== command.payload.result.operationId)) fail("unavailable");
}

/** Run immediately before EACH effect, inside the existing local lock. The final intent check repeats the authorization
 * check in the center's transaction, closing the gap between separate owner authorization and intent reads.
 */
export async function checkSchedulerCentral(input: SchedulerCentralContext, runtime: SchedulerCentralRuntime): Promise<void> {
  const c = parseSchedulerCentralContext(input);
  assertLocalOwner(c, runtime);
  await checkedCommand(runtime, { ...centralEnvelope(c), requestId: randomUUID(), type: "authorization.check",
    payload: { ...centralVersions(c), askId: c.authorizationAskId, bind: c.authorizationBind, action: authorizationAction(c.action) } });
  assertLocalOwner(c, runtime);
  await checkedCommand(runtime, { ...centralEnvelope(c), requestId: randomUUID(), type: "intent.check",
    payload: { ...centralVersions(c), intentId: c.intentId, operationId: c.operationId,
      authorizationAskId: c.authorizationAskId, authorizationDigest: c.authorizationDigest } });
  assertLocalOwner(c, runtime);
}

export function schedulerCentralResult(input: SchedulerCentralContext, observation: SchedulerCentralObservation, observedAt: number): V2OperationResult {
  const c = parseSchedulerCentralContext(input);
  return parseOperationResult({ ...centralEnvelope(c), taskId: c.taskId, intentId: c.intentId, operationId: c.operationId,
    state: observation.state, head: observation.head, summary: observation.summary, artifactIds: observation.artifactIds,
    approvalAskId: c.authorizationAskId, observedAt });
}

/** No retry, lease release or intent cancellation on failure. The caller keeps an unknown local outbox and held resources.
 * Results retain the original epoch even when the lease has since been lost; the center decides if it can accept them.
 */
export async function reportSchedulerCentral(c: SchedulerCentralContext, runtime: SchedulerCentralRuntime, result: V2OperationResult): Promise<void> {
  const expected = schedulerCentralResult(c, result, result.observedAt);
  if (v2ObjectDigest(expected) !== v2ObjectDigest(result)) fail("invalid_field");
  const command: SchedulerCentralCommand = { ...centralEnvelope(c), requestId: `result-${v2ObjectDigest(result)}`,
    type: "operation.result", payload: { result: parseOperationResult(result) } };
  await checkedCommand(runtime, command);
}
