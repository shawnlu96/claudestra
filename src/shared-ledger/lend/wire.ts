import type { V2LendLease, V2LendOrder } from "../../lib/shared-ledger-contract-v2-lend.js";
import { parseLendLease, parseLendOrder } from "../../lib/shared-ledger-contract-v2-lend.js";
import type { LeaseState } from "../../lib/lend-wire.js";
import { offerBody, parseV2Request, type OfferRequest } from "../../lib/lend-wire-v2.js";
import { fail } from "../../lib/shared-ledger-contract-v2-validation.js";

/** Only the legacy offer fields cross the peer boundary. The home proxy retains central authority/fence metadata. */
export function lendOffer(orders: readonly V2LendOrder[]): OfferRequest {
  const body = offerBody(orders.map(input => {
    const o = parseLendOrder(input);
    if (o.status !== "pooled") fail("stale_order");
    return { orderId: o.orderId, taskId: o.taskId, step: o.step, family: o.family, repo: o.repository,
      pr: o.pr, head: o.head, round: o.round, specRev: o.specRev, offeredAt: o.createdAt };
  }));
  const parsed = parseV2Request("offer", body);
  if (!parsed.ok) fail("invalid_field");
  return parsed.value;
}
export function lendLeaseState(input: V2LendLease): LeaseState {
  const lease = parseLendLease(input);
  return { gen: lease.leaseGen, expiresAt: lease.expiresAt, ms: lease.leaseMs };
}
