import {
  assertFence, fail, id, parseActor, parseFeature, parseFence, V2_COMMAND_POLICY,
  type V2Actor, type V2Command, type V2Feature, type V2Fence,
} from "./shared-ledger-contract-v2.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";

/** X12 supplies these from authenticated local transport and owner registration, never from request JSON. */
export interface ExecIdentity {
  centerId: string;
  teamId: string;
  projectId: string;
  actor: V2Actor;
  projectRole: "owner" | "member";
  registeredPersonId: string;
  registeredInstanceId: string;
}
/** Resolve task/ask/order ids to their actual feature before calling the gate; do not trust a caller-selected feature. */
interface ExecContext {
  feature: V2Feature;
  fence: V2Fence;
  orderId: string | null;
}
export interface ExecGateOptions {
  modeDirectory: string;
  identity: () => ExecIdentity;
  context: (command: V2Command) => ExecContext;
}
export function verifyExecIdentity(input: ExecIdentity, teamId: string, projectId: string): ExecIdentity {
  const actor = parseActor(input.actor);
  id(input.centerId); id(input.teamId); id(input.registeredPersonId); id(input.registeredInstanceId);
  if (input.teamId !== teamId || input.projectId !== projectId || !actor.projects.includes(projectId)) fail("forbidden");
  if (actor.personId !== input.registeredPersonId || actor.instanceId !== input.registeredInstanceId) fail("unauthenticated");
  if (!["owner", "member"].includes(input.projectRole)) fail("forbidden");
  if (actor.kind === "service" && actor.orderId === null) fail("forbidden");
  return { ...input, actor };
}
function checkOrder(command: V2Command, actor: V2Actor, context: ExecContext): void {
  if (actor.kind !== "service") return;
  if (actor.orderId !== context.orderId) fail("forbidden");
  const payload = command.payload;
  const nested = "result" in payload ? payload.result : "claim" in payload ? payload.claim : payload;
  if ("orderId" in nested && nested.orderId !== actor.orderId) fail("forbidden");
  if ("executorInstanceId" in nested && nested.executorInstanceId !== actor.instanceId) fail("forbidden");
}
/** Durable mode is reread for every send. Missing/corrupt state fails closed; this gate never changes modes. */
export class SharedLedgerExecGate {
  constructor(private readonly options: ExecGateOptions) {}
  identity(teamId: string, projectId: string): ExecIdentity {
    return verifyExecIdentity(this.options.identity(), teamId, projectId);
  }
  authorize(command: V2Command): ExecIdentity {
    const identity = this.identity(command.teamId, command.projectId);
    const actor = identity.actor;
    if (!actor.actions.includes(command.type)) fail("forbidden");
    const context = this.options.context(structuredClone(command));
    const feature = parseFeature(context.feature);
    if (feature.teamId !== command.teamId || feature.projectId !== command.projectId) fail("forbidden");
    if ("featureId" in command.payload && command.payload.featureId !== feature.id) fail("forbidden");
    const mode = readSharedLedgerMode(feature.id, this.options.modeDirectory);
    const policy = V2_COMMAND_POLICY[command.type];
    if (mode.authorityMode === "source" || mode.authorityMode !== feature.authorityMode
      || (policy.executionOnly && mode.authorityMode !== "execution")) fail("execution_not_shared");
    assertFence(parseFence(context.fence), { serviceGeneration: command.serviceGeneration, epoch: command.epoch, bootId: command.bootId });
    if (feature.epoch !== command.epoch) fail("stale_epoch");
    if (policy.actor === "owner" && (actor.kind !== "person" || identity.projectRole !== "owner")) fail("forbidden");
    if (policy.actor === "home_or_scoped_service" && actor.kind === "person" && actor.instanceId !== feature.homeInstanceId) fail("wrong_home");
    checkOrder(command, actor, context);
    return identity;
  }
}
