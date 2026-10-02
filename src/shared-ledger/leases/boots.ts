import { fail, parseFeature, positive, type V2TransactionContext } from "../../lib/shared-ledger-contract-v2.js";
import type { LeaseDependencies } from "./types.js";

function boot(context: V2TransactionContext): { active: number } | undefined {
  return context.all("leases.boot")[0] as { active: number } | undefined;
}
export function assertCurrentBoot(context: V2TransactionContext): void {
  if (boot(context)?.active !== 1) fail("stale_epoch");
}
/** A boot identifies the home process, not a task. Retire all its leases atomically,
 * including leases in other features of this project, before admitting the new boot.
 */
export function admitBoot(context: V2TransactionContext, deps: LeaseDependencies): void {
  const known = boot(context);
  if (known?.active === 0) fail("stale_epoch");
  if (known) return;
  for (const { featureId } of context.all("leases.boot.features") as { featureId: string }[]) {
    const feature = parseFeature(deps.readFeature(context, featureId));
    if (feature.id !== featureId || feature.teamId !== context.scope.teamId || feature.projectId !== context.scope.projectId) fail("not_found");
    if (feature.homeInstanceId !== context.scope.actor.instanceId) fail("wrong_home");
    const next = positive(feature.epoch + 1);
    deps.advanceFeature(context, feature, next, feature.homeInstanceId);
    context.run("leases.boot.revoke", { featureId, nextEpoch: next });
  }
  context.run("leases.retire");
  context.run("leases.boot.put");
}
