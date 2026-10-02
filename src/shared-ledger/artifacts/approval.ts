import {
  fail, parseAsk, parseTask, parseFeature, parseWorkflow,
  type V2Artifact, type V2Ask, type V2Task, type V2Feature, type V2Workflow, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";

/** X12 supplies current domain/identity readers using this same transaction, never wire-supplied rows.
 * The authenticated context carries current project membership and the service's allowed actions.
 */
export interface ArtifactReaders {
  readAsk(context: V2TransactionContext, askId: string): V2Ask | null;
  readTask(context: V2TransactionContext, taskId: string): V2Task | null;
  readFeature(context: V2TransactionContext, featureId: string): V2Feature | null;
  readWorkflow(context: V2TransactionContext, taskId: string): V2Workflow | null;
  isProjectOwner(context: V2TransactionContext, personId: string): boolean;
}
function inScope(context: V2TransactionContext, row: { teamId: string; projectId: string }): boolean {
  return row.teamId === context.scope.teamId && row.projectId === context.scope.projectId;
}
export function assertArtifactApproval(context: V2TransactionContext, artifact: V2Artifact, readers: ArtifactReaders): void {
  const raw = readers.readAsk(context, artifact.approvalAskId);
  if (!raw || !inScope(context, raw)) fail("authorization_mismatch");
  const ask = parseAsk(raw), bind = ask.bind;
  if (ask.id !== artifact.approvalAskId || ask.kind !== "authorize" || ask.state !== "answered" || ask.decision !== "approved"
    || ask.answeredBy !== artifact.approvedBy || !bind || !bind.actions.includes("artifact.share")) fail("authorization_mismatch");
  if (ask.expiresAt <= context.scope.now) fail("authorization_expired");
  if (ask.answeredAt! > context.scope.now || artifact.createdAt < ask.answeredAt! || artifact.createdAt > context.scope.now
    || !readers.isProjectOwner(context, artifact.approvedBy)) fail("authorization_mismatch");
  if (bind.taskId !== artifact.taskId || bind.originalDigest !== artifact.originalDigest || bind.sharedDigest !== artifact.sharedDigest
    || bind.actionDigest !== artifact.sharedDigest || bind.redactionVersion !== artifact.redactionVersion
    || (artifact.specRev !== null && bind.specRev !== artifact.specRev) || (artifact.head !== null && bind.head !== artifact.head)) {
    fail("authorization_mismatch");
  }
  const taskRow = readers.readTask(context, artifact.taskId);
  if (!taskRow || !inScope(context, taskRow)) fail("authorization_mismatch");
  const task = parseTask(taskRow);
  if (task.id !== artifact.taskId || task.featureId !== bind.featureId || task.rev !== bind.taskRev
    || (bind.specRev !== null && task.specRev !== bind.specRev)
    || task.homeInstanceId !== bind.homeInstanceId || (bind.head !== null && task.head !== bind.head)
    || (artifact.kind === "spec" && task.spec.originalDigest !== artifact.originalDigest)) fail("authorization_mismatch");
  const featureRow = readers.readFeature(context, task.featureId);
  if (!featureRow || !inScope(context, featureRow)) fail("authorization_mismatch");
  const feature = parseFeature(featureRow);
  if (feature.id !== task.featureId || feature.currentVersion !== bind.baseVersion || feature.homeInstanceId !== task.homeInstanceId) {
    fail("authorization_mismatch");
  }
  if (feature.epoch !== context.scope.epoch) fail("stale_epoch");
  if (context.scope.actor.kind === "person" && context.scope.actor.instanceId !== task.homeInstanceId) fail("wrong_home");
  if (bind.workflowRev !== null) {
    const workflowRow = readers.readWorkflow(context, task.id);
    if (!workflowRow || !inScope(context, workflowRow)) fail("authorization_mismatch");
    const workflow = parseWorkflow(workflowRow);
    if (workflow.taskId !== task.id || workflow.rev !== bind.workflowRev || workflow.specRev !== task.specRev) fail("authorization_mismatch");
  }
}
