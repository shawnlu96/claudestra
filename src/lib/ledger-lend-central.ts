import {
  fail, parseCommand, parseLendResult, v2ObjectDigest, V2ContractError,
  type V2Command, type V2Receipt, type V2LendResult,
} from "./shared-ledger-contract-v2.js";
import { parseLendRequest, isDeliverRequest } from "./lend-wire.js";
import { parseV2Request } from "./lend-wire-v2.js";
import {
  allowed, bindingOf, checkedReceipt, checkView, checkPending, grantOf,
  type LendCentralBinding, type LendCentralGrantDeps, type LendCentralView,
} from "./ledger-lend-central-checks.js";
import { LendCentralOutbox, type LendCentralPending } from "./ledger-lend-central-state.js";

/** X12 supplies authenticated home-bridge transport. Each read must be online, never a cached projection.
 * command performs a single attempt; the central transaction rechecks fences, grant binding, versions and leases.
 * Transport failures become V2ContractError("unavailable"); authorization/CAS rejections propagate unchanged.
 * No port can create/kill workers, mutate owner grants or write the local task ledger.
 */
export interface LendCentralTransport {
  receipt(requestId: string): Promise<unknown | null>;
  view(orderId: string): Promise<LendCentralView>;
  command(command: V2Command): Promise<unknown>;
}
/** freshClaim is a first-response hint, not permission to spawn: the local driver still rechecks grant/quota.
 * Reconciled claims must inspect the existing worker journal and never automatically start another worker. */
export type LendCentralOutcome =
  | { status: "confirmed"; receipt: V2Receipt; freshClaim: boolean }
  | { status: "outbox" | "ready"; requestId: string };
export interface LendCentralSharedResult { summary: string; artifactIds: string[] }

/** One instance per authenticated worker/order binding, constructed by the bridge, never by the worker.
 * Persist the original binding in the local journal: recovery must reuse it, not repin to a newer lease/fence. */
export class LedgerLendCentralClient {
  private readonly binding: LendCentralBinding;
  private readonly key: string;
  constructor(binding: LendCentralBinding, private readonly transport: LendCentralTransport,
    private readonly grant: LendCentralGrantDeps, private readonly outbox: LendCentralOutbox) {
    this.binding = bindingOf(binding);
    const o = this.binding.order;
    this.key = v2ObjectDigest([o.teamId, o.projectId, o.orderId, o.serviceGeneration, o.epoch, o.bootId, o.leaseGen,
      this.binding.worker, this.binding.actor.personId, this.binding.actor.serviceId]);
  }
  private envelope(type: V2Command["type"], payload: unknown, requestId: string): V2Command {
    const o = this.binding.order;
    allowed(this.binding, type);
    return parseCommand({ teamId: o.teamId, projectId: o.projectId, serviceGeneration: o.serviceGeneration,
      epoch: o.epoch, bootId: o.bootId, requestId, type, payload });
  }
  private async submit(entry: LendCentralPending, key: string, resubmit: boolean, held: () => void, initial = false): Promise<LendCentralOutcome> {
    const c = entry.command;
    allowed(this.binding, c.type);
    checkPending(this.binding, c, `lend-${c.type === "lend.claim" ? "claim" : "result"}:${this.key}`);
    try {
      const receipt = await this.transport.receipt(c.requestId);
      if (receipt !== null) {
        const confirmed = checkedReceipt(this.binding, c, receipt);
        if (entry.receipt && v2ObjectDigest(entry.receipt) !== v2ObjectDigest(confirmed)) return fail("sequence_regressed");
        entry.receipt = confirmed;
        held(); this.outbox.save(key, entry);
        return { status: "confirmed", receipt: entry.receipt, freshClaim: false };
      }
      if (entry.receipt) return fail("sequence_regressed");
      checkView(this.binding, await this.transport.view(this.binding.order.orderId), c.type !== "lend.claim");
      await grantOf(this.binding, this.grant);
      if (!resubmit) return { status: "ready", requestId: c.requestId };
      held();
      entry.receipt = checkedReceipt(this.binding, c, await this.transport.command(c));
      held(); this.outbox.save(key, entry);
      return { status: "confirmed", receipt: entry.receipt, freshClaim: initial && c.type === "lend.claim" };
    } catch (error) {
      // Only an explicit transport-unavailable error can become pending; rejections/corrupt storage remain visible.
      if (!(error instanceof V2ContractError) || error.code !== "unavailable") throw error;
      return { status: "outbox", requestId: c.requestId };
    }
  }
  private async pending(kind: "claim" | "result", input: unknown, make: () => V2Command): Promise<LendCentralOutcome> {
    const key = `${this.key}:${kind}`, inputDigest = v2ObjectDigest(input);
    return this.outbox.exclusive(key, async held => {
      let entry = this.outbox.read(key);
      if (entry && entry.inputDigest !== inputDigest) return fail("dedup_mismatch");
      if (!entry) {
        entry = { inputDigest, input: structuredClone(input), command: make(), receipt: null };
        held(); this.outbox.save(key, entry);
        return this.submit(entry, key, true, held, true);
      }
      // Repeated calls/restarts only reconcile. A missing receipt requires explicit recover(..., true).
      return this.submit(entry, key, false, held);
    });
  }
  async claim(raw: unknown): Promise<LendCentralOutcome> {
    const parsed = parseLendRequest("claim", raw);
    if (!parsed.ok) return fail("invalid_field");
    const b = this.binding, o = b.order, req = parsed.value;
    if (req.orderId !== o.orderId || b.worker.kind === "human" || req.worker !== b.worker.agentId) return fail("forbidden");
    allowed(b, "lend.claim");
    await grantOf(b, this.grant);
    return this.pending("claim", req, () => this.envelope("lend.claim", { claim: {
      teamId: o.teamId, projectId: o.projectId, orderId: o.orderId, taskId: o.taskId, specRev: o.specRev, round: o.round,
      head: o.head, leaseGen: o.leaseGen, serviceGeneration: o.serviceGeneration, epoch: o.epoch, bootId: o.bootId,
      executorInstanceId: b.executorInstanceId, worker: b.worker, grantId: o.grantId, grantDigest: o.grantDigest, claimedAt: this.grant.now(),
    } }, `lend-claim:${this.key}`));
  }
  /** A batch from a worker may contain exactly its assigned order. Lifecycle/ended observations go to X12 reconciliation. */
  async beat(raw: unknown, requestId: string): Promise<V2Receipt> {
    const parsed = parseV2Request("beat", raw);
    if (!parsed.ok) return fail("invalid_field");
    const b = this.binding, o = b.order, orders = parsed.value.orders;
    if (orders.length !== 1 || orders[0]!.orderId !== o.orderId) return fail("forbidden");
    if (orders[0]!.gen !== o.leaseGen) return fail("stale_lease_gen");
    if (orders[0]!.ended) return fail("unknown_operation");
    const c = this.envelope("lend.renew", { orderId: o.orderId, leaseGen: o.leaseGen, executorInstanceId: b.executorInstanceId }, requestId);
    checkView(b, await this.transport.view(o.orderId), true);
    await grantOf(b, this.grant);
    return checkedReceipt(b, c, await this.transport.command(c));
  }
  /** shared is the approved/redacted projection from the home bridge, not report text supplied by the worker. */
  async result(raw: unknown, shared: LendCentralSharedResult): Promise<LendCentralOutcome> {
    const parsed = parseLendRequest("result", raw);
    if (!parsed.ok) return fail("invalid_field");
    const req = parsed.value, b = this.binding, o = b.order;
    allowed(b, "lend.result");
    if (req.orderId !== o.orderId || req.session.family !== o.family) return fail("forbidden");
    if (req.gen !== o.leaseGen) return fail("stale_lease_gen");
    const delivery = isDeliverRequest(req);
    if (delivery !== (o.step !== "review")) return fail("stale_order");
    if (delivery && (req.deliver.head === o.head || req.branch !== o.branch || (o.pr !== null && req.pr !== o.pr))) return fail("stale_order");
    if (!delivery && (req.verdict.head !== o.head || req.arbitration || req.cancelAck)) return fail("stale_order");
    // Keep reports, paths and self-check bodies local; only the approved projection and digest enter the center.
    const resultDigest = v2ObjectDigest(req);
    shared = structuredClone(shared);
    return this.pending("result", { wire: req, shared }, () => {
      const result: V2LendResult = parseLendResult({ teamId: o.teamId, projectId: o.projectId, orderId: o.orderId, taskId: o.taskId,
        serviceGeneration: o.serviceGeneration, epoch: o.epoch, bootId: o.bootId, specRev: o.specRev, round: o.round,
        expectedHead: o.head, head: delivery ? req.deliver.head : req.verdict.head, leaseGen: o.leaseGen,
        executorInstanceId: b.executorInstanceId, worker: b.worker, operationId: `lend-result:${this.key}`, resultDigest,
        verdict: delivery ? "delivered" : req.verdict.verdict, summary: shared.summary, artifactIds: shared.artifactIds, observedAt: this.grant.now() });
      return this.envelope("lend.result", { result }, `lend-result:${this.key}`);
    });
  }
  async recover(kind: "claim" | "result", resubmit = false): Promise<LendCentralOutcome> {
    allowed(this.binding, kind === "claim" ? "lend.claim" : "lend.result");
    const key = `${this.key}:${kind}`;
    return this.outbox.exclusive(key, async held => {
      const entry = this.outbox.read(key);
      if (!entry) return fail("not_found");
      return this.submit(entry, key, resubmit, held);
    });
  }
}
