/**
 * S2F · S2R lease adapter (E6 / E11). S2R holds one fence per local execution feature; the center leases per task
 * (`lease.acquire|renew|release`, shared-ledger-contract-v2-commands.ts). One feature lease = every workflow card of the
 * feature leased under the same (serviceGeneration, epoch, bootId). Values S2R trusts come only from authenticated receipts:
 * `centerNow` is the newest receipt's committedAt (online center time), `renewedAt` the oldest, so the shortest task lease
 * bounds the feature. Transient failures (transport, a moved card rev, another boot's lease still live) map to unavailable,
 * which S2R backs off on; stale_epoch / lease_expired / wrong_home lose the feature as S2R specifies.
 * The feature fence authorizes only the cards whose own task lease this incarnation holds (`holds`): a card another boot
 * still leases, or one not leased yet, gets no fence even while its feature's other cards are leased.
 */
import { randomUUID } from "node:crypto";
import {
  fail, V2ContractError, V2_LEASE_MS, type V2Command, type V2Fence, type V2Receipt,
} from "./shared-ledger-contract-v2.js";
import type { Stage2LeaseFeature, Stage2LeasePort, Stage2LeaseReceipt } from "./scheduler-v2-lease.js";
import type { Stage2View, Stage2Wiring } from "./shared-ledger-v2-wiring.js";

type LeaseType = "lease.acquire" | "lease.renew" | "lease.release";
/** Errors that say "not now", not "this term is over". */
const TRANSIENT = new Set(["unavailable", "conflict", "resource_busy"]);
const transient = (e: unknown) => !(e instanceof V2ContractError) || TRANSIENT.has(e.code);

export interface Stage2LeaseAdapter {
  command: Stage2LeasePort["command"];
  /** Lease workflow cards that appeared after the feature's grant (pre-pass), under the fence S2R currently exposes. */
  /** `assert` (the pass guard) runs right before each lease request and after it settles. */
  extend(feature: Stage2LeaseFeature, fence: V2Fence, assert?: () => void): Promise<void>;
  /** This incarnation (feature + the fence's bootId) holds the card's own task lease. */
  holds(featureId: string, fence: V2Fence, taskId: string): boolean;
}

export function stage2LeaseAdapter(wiring: Stage2Wiring, instanceId: () => string): Stage2LeaseAdapter {
  /** Tasks leased per feature incarnation (local feature id + bootId). */
  const held = new Map<string, Set<string>>();
  const heldOf = (f: Stage2LeaseFeature, bootId: string) => {
    const k = `${f.localFeatureId}\0${bootId}`;
    let set = held.get(k);
    if (!set) held.set(k, set = new Set());
    return set;
  };

  const submit = async (f: Stage2LeaseFeature, fence: V2Fence, type: LeaseType, payload: Record<string, unknown>): Promise<V2Receipt> => {
    const transport = wiring.transportFor(f.projectId), scope = wiring.scope(f.projectId);
    if (!transport || !scope) return fail("unavailable");
    const command = { teamId: scope.teamId, projectId: scope.projectId, requestId: `lease-${randomUUID()}`,
      serviceGeneration: fence.serviceGeneration, epoch: fence.epoch, bootId: fence.bootId, type, payload } as V2Command;
    return transport.call("commands", {}, command);
  };
  const acquire = (f: Stage2LeaseFeature, fence: V2Fence, view: Stage2View, taskId: string) => {
    const task = view.tasks.find((t) => t.id === taskId)!, workflow = view.workflows.find((w) => w.taskId === taskId)!;
    return submit(f, fence, "lease.acquire", { taskId, expectedRev: task.rev, expectedSpecRev: task.specRev,
      expectedWorkflowRev: workflow.rev, homeInstanceId: instanceId() });
  };
  /** Online view of the feature; the home and epoch must still be this instance's. */
  const view = async (f: Stage2LeaseFeature): Promise<Stage2View> => {
    const v = await wiring.snapshot(f.projectId, f.localFeatureId);
    if (v.feature.homeInstanceId !== instanceId()) return fail("wrong_home");
    if (v.feature.epoch !== f.centerExecution?.epoch) return fail("stale_epoch");
    return v;
  };
  const leasable = (v: Stage2View) => v.tasks.filter((t) => v.workflows.some((w) => w.taskId === t.id)).map((t) => t.id);

  async function command(f: Stage2LeaseFeature, type: LeaseType, bootId: string, prior: V2Fence | null): Promise<Stage2LeaseReceipt | void> {
    try {
      const tasks = heldOf(f, bootId);
      if (type === "lease.release") {
        if (!prior) return;
        await Promise.allSettled([...tasks].map((taskId) => submit(f, prior, type, { taskId, reason: "主场停止（S2R stop）" })));
        held.delete(`${f.localFeatureId}\0${bootId}`);
        return;
      }
      const v = await view(f);
      const fence: V2Fence = prior ?? { serviceGeneration: v.serviceGeneration, epoch: v.feature.epoch, bootId };
      // Renewals of held cards must all land: one lost card lease loses the feature. New cards are best effort.
      const renewals = type === "lease.renew" ? [...tasks].map((taskId) =>
        submit(f, fence, "lease.renew", { taskId, homeInstanceId: instanceId() })) : [];
      const fresh = leasable(v).filter((id) => type === "lease.acquire" || !tasks.has(id));
      const acquired = await Promise.allSettled(fresh.map((id) => acquire(f, fence, v, id)));
      const receipts = await Promise.all(renewals);
      acquired.forEach((r, i) => {
        if (r.status === "fulfilled") { tasks.add(fresh[i]!); receipts.push(r.value); }
        else if (!transient(r.reason)) throw r.reason;
      });
      if (!receipts.length) return fail("unavailable");
      const at = receipts.map((r) => r.committedAt), renewedAt = Math.min(...at);
      return { fence: { serviceGeneration: receipts[0]!.serviceGeneration, epoch: receipts[0]!.result.epoch, bootId },
        centerNow: Math.max(...at), renewedAt, expiresAt: renewedAt + V2_LEASE_MS };
    } catch (e) {
      throw transient(e) ? new V2ContractError("unavailable") : e;
    }
  }

  async function extend(f: Stage2LeaseFeature, fence: V2Fence, assert = () => {}): Promise<void> {
    const tasks = heldOf(f, fence.bootId);
    if (!tasks.size) return; // nothing granted in this incarnation yet: the S2R loop acquires
    assert();
    const v = await view(f);
    for (const id of leasable(v).filter((t) => !tasks.has(t))) {
      assert();
      try { await acquire(f, fence, v, id); tasks.add(id); }
      catch (e) { console.warn(`[stage2-lease] ${id}: ${(e as Error).message}`); }
      assert();
    }
  }
  const holds = (featureId: string, fence: V2Fence, taskId: string) => held.get(`${featureId}\0${fence.bootId}`)?.has(taskId) === true;
  return { command, extend, holds };
}
