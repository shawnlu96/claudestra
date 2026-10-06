/** Local execution envelopes use only frozen V2 fields. They never carry credentials or shell arguments to the center. */
import {
  choice, digest, fail, fenceFields, head, id, nullable, object, parseAuthorizationBind, positive, refine, scope,
  v2ObjectDigest, type Infer, type V2Command, type V2OperationResult,
} from "./shared-ledger-contract-v2.js";

export const parseSchedulerCentralContext = refine(object({
  ...scope, ...fenceFields, homeInstanceId: id, taskId: id, intentId: id, operationId: id,
  taskRev: positive, specRev: positive, workflowRev: positive, head: nullable(head),
  action: choice(["dispatch", "review", "merge", "deploy", "release"]),
  authorizationAskId: id, authorizationDigest: digest, authorizationBind: parseAuthorizationBind,
}), c => {
  const b = c.authorizationBind;
  return c.authorizationDigest === v2ObjectDigest(b) && b.homeInstanceId === c.homeInstanceId
    && (b.taskId === null || b.taskId === c.taskId) && (b.taskRev === null || b.taskRev === c.taskRev)
    && (b.specRev === null || b.specRev === c.specRev) && (b.workflowRev === null || b.workflowRev === c.workflowRev)
    && b.head === c.head && b.actions.includes(authorizationAction(c.action));
});
export type SchedulerCentralContext = Infer<typeof parseSchedulerCentralContext>;
export type SchedulerCentralCommand = Extract<V2Command, { type: "intent.check" | "authorization.check" | "operation.result" }>;

/** X12 supplies a newly authenticated online client in each process; no cache, queued write or automatic retry here.
 * intent.check MUST atomically revalidate submitted intent, home lease, fences, versions AND current owner authorization.
 * A fresh requestId is used for every check, so an old command receipt can never serve as live permission.
 */
export interface SchedulerCentralClient {
  command(command: SchedulerCentralCommand): Promise<unknown>;
}
interface SchedulerLocalLock { held(): boolean }
export interface SchedulerCentralRuntime {
  instanceId: string;
  client: SchedulerCentralClient;
  lock: SchedulerLocalLock;
}
export function authorizationAction(action: "dispatch" | "review" | "merge" | "deploy" | "release"): "merge" | "deploy" | "release" | "workflow.auto" {
  return action === "dispatch" || action === "review" ? "workflow.auto" : action;
}
export function centralEnvelope(c: SchedulerCentralContext) {
  return { teamId: c.teamId, projectId: c.projectId, serviceGeneration: c.serviceGeneration, epoch: c.epoch, bootId: c.bootId };
}
export function centralVersions(c: SchedulerCentralContext) {
  return { taskId: c.taskId, expectedRev: c.taskRev, expectedSpecRev: c.specRev, expectedWorkflowRev: c.workflowRev };
}
export function assertLocalOwner(c: SchedulerCentralContext, runtime: SchedulerCentralRuntime): void {
  if (runtime.instanceId !== c.homeInstanceId) fail("wrong_home");
  if (!runtime.lock.held()) fail("stale_epoch");
}
export type SchedulerCentralObservation = Pick<V2OperationResult, "state" | "head" | "summary" | "artifactIds">;
