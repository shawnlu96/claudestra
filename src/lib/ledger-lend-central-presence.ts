import { liveGrant } from "./lend-grant.js";
import { scopeProblem } from "./lend-grant-rules.js";
import { parseV2Request, type HelloRequest, type OfferRequest } from "./lend-wire-v2.js";
import { fail, parseLendOrder, type V2LendOrder } from "./shared-ledger-contract-v2.js";
import type { LendCentralGrantDeps } from "./ledger-lend-central-checks.js";

/** Trusted bridge service only; never expose presence/offer enumeration as a worker method.
 * X12 binds transport to the verified home and peer identity. Wire bodies remain lend-wire-v2 bodies.
 */
export interface LendCentralPresenceTransport {
  hello(request: HelloRequest): Promise<unknown>;
  offer(request: OfferRequest): Promise<unknown>;
  order(orderId: string): Promise<V2LendOrder>;
}
export interface LendCentralPeerBinding {
  teamId: string; projectId: string; homeInstanceId: string; executorInstanceId: string; peer: string; fp: string;
}
export class LedgerLendCentralPresence {
  private readonly peer: LendCentralPeerBinding;
  constructor(peer: LendCentralPeerBinding, private readonly transport: LendCentralPresenceTransport,
    private readonly deps: LendCentralGrantDeps) { this.peer = structuredClone(peer); }
  private async grant() {
    if (!this.peer.fp) return fail("forbidden");
    const grant = await liveGrant({ peer: this.peer.peer, fp: this.peer.fp }, this.deps);
    if (!grant.ok) return fail("authorization_expired");
    return grant.entry;
  }
  async hello(raw: unknown): Promise<unknown> {
    const parsed = parseV2Request("hello", raw);
    if (!parsed.ok) return fail("invalid_field");
    const req = parsed.value;
    // A withdrawn advertisement may always reach the center; it grants no capacity.
    if (req.grant === null) {
      if (req.slots.codex.total !== 0 || req.slots.claude.total !== 0) return fail("authorization_mismatch");
    } else {
      const grant = await this.grant(), g = req.grant;
      if (g.until > Date.parse(grant.until!) || g.until <= this.deps.now() || g.ordersPerDay > grant.ordersPerDay
        || g.ordersLeftToday > g.ordersPerDay || g.repos.some(repo => !grant.repos.includes(repo))) return fail("authorization_mismatch");
      for (const family of ["codex", "claude"] as const) {
        if (req.slots[family].total > (grant.families[family] ?? 0)) return fail("authorization_mismatch");
      }
    }
    return this.transport.hello(req);
  }
  async offer(raw: unknown): Promise<unknown> {
    const parsed = parseV2Request("offer", raw);
    if (!parsed.ok) return fail("invalid_field");
    for (const summary of parsed.value.orders) {
      const o = parseLendOrder(await this.transport.order(summary.orderId)), p = this.peer;
      if (o.teamId !== p.teamId || o.projectId !== p.projectId || o.homeInstanceId !== p.homeInstanceId
        || o.status !== "pooled" || (o.executorInstanceId !== null && o.executorInstanceId !== p.executorInstanceId)) return fail("forbidden");
      if (summary.orderId !== o.orderId || summary.taskId !== o.taskId || summary.repo !== o.repository || summary.family !== o.family
        || summary.step !== o.step || summary.pr !== o.pr || summary.head !== o.head || summary.round !== o.round
        || summary.specRev !== o.specRev) return fail("stale_order");
      const grant = await this.grant();
      if (scopeProblem(grant, { repo: o.repository, step: o.step, family: o.family })) return fail("authorization_mismatch");
    }
    // This only forwards an offer. The local lend driver still owns quota reservation and worker startup.
    return this.transport.offer(parsed.value);
  }
}
