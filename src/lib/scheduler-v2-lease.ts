import { randomUUID } from "node:crypto";
import {
  assertFence, parseFence, timestamp, V2ContractError, V2_LEASE_MS, V2_RENEW_MS, type V2Fence,
} from "./shared-ledger-contract-v2.js";

export interface Stage2LeaseFeature {
  localFeatureId: string;
  projectId: string;
  homeInstanceId: string;
  centerExecution?: { centerId: string; teamId: string; projectId: string; centerFeatureId: string; epoch: number };
  migrating?: unknown;
}
type LeaseCommand = "lease.acquire" | "lease.renew" | "lease.release";
/** The adapter resolves a feature's task-scoped lease commands; these are authenticated center values.
 * centerNow is sampled online for this request, even when the grant came from a historical receipt.
 * X0's fence identifies the incarnation by bootId; no new wire leaseId is invented here.
 */
export interface Stage2LeaseReceipt {
  fence: V2Fence;
  centerNow: number;
  renewedAt: number;
  expiresAt: number;
}
export interface Stage2LeaseClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}
export interface Stage2LeasePort {
  instanceId: string;
  bootId?: string;
  features(): readonly Stage2LeaseFeature[];
  mode(projectId: string): "off" | "observe" | "on";
  command(feature: Stage2LeaseFeature, type: LeaseCommand, bootId: string, fence: V2Fence | null): Promise<Stage2LeaseReceipt | void>;
  onLost(featureId: string, reason: string): void;
  clock?: Stage2LeaseClock;
}
interface Entry {
  feature: Stage2LeaseFeature;
  fence: V2Fence | null;
  releaseFence: V2Fence | null;
  deadline: number;
  nextRenew: number;
  lost: boolean;
  job: Promise<void> | null;
}
const MARGIN_MS = 10_000;
const realClock: Stage2LeaseClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

class Stage2Leases {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: Stage2LeaseClock;
  private readonly bootId: string;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly port: Stage2LeasePort) {
    this.clock = port.clock ?? realClock;
    this.bootId = port.bootId ?? randomUUID();
    this.tick();
  }
  private eligible(feature: Stage2LeaseFeature): boolean {
    return !!feature.centerExecution && feature.migrating === undefined
      && feature.homeInstanceId === this.port.instanceId && this.port.mode(feature.projectId) === "on";
  }
  private matching(entry: Entry): boolean {
    const f = this.port.features().find(f => f.localFeatureId === entry.feature.localFeatureId);
    const center = entry.feature.centerExecution;
    return !!f && this.eligible(f) && f.homeInstanceId === entry.feature.homeInstanceId
      && f.projectId === entry.feature.projectId
      && f.centerExecution?.centerId === center?.centerId && f.centerExecution?.teamId === center?.teamId
      && f.centerExecution?.projectId === center?.projectId && f.centerExecution?.centerFeatureId === center?.centerFeatureId
      && f.centerExecution?.epoch === center?.epoch;
  }
  private lose(entry: Entry, reason: string): void {
    if (entry.lost || this.stopped) return;
    entry.lost = true;
    entry.fence = null;
    // Mark lost before notifying: a callback can reenter current(), but cannot resurrect this incarnation.
    try { this.port.onLost(entry.feature.localFeatureId, reason); }
    catch { console.warn("[stage2-leases] onLost callback failed"); }
  }
  private valid(entry: Entry): boolean {
    if (this.stopped || entry.lost) return false;
    if (!this.matching(entry)) this.lose(entry, "inactive");
    else if (entry.fence && this.clock.now() >= entry.deadline) this.lose(entry, "lease_expired");
    return !entry.lost;
  }
  current(featureId: string): V2Fence | null {
    const entry = this.entries.get(featureId);
    return entry && this.valid(entry) && entry.fence ? { ...entry.fence } : null;
  }
  private tick(): void {
    if (this.stopped) return;
    for (const entry of this.entries.values()) this.valid(entry);
    for (const feature of this.port.features()) {
      if (this.entries.has(feature.localFeatureId) || !this.eligible(feature)) continue;
      this.entries.set(feature.localFeatureId, {
        feature: structuredClone(feature), fence: null, releaseFence: null, deadline: 0,
        nextRenew: 0, lost: false, job: null,
      });
    }
    for (const entry of this.entries.values()) {
      if (!this.valid(entry) || entry.job || (entry.fence && this.clock.now() < entry.nextRenew)) continue;
      entry.job = this.request(entry).finally(() => { entry.job = null; });
    }
    let delay = 1000;
    for (const entry of this.entries.values()) {
      if (!entry.lost && entry.fence) {
        delay = Math.min(delay, entry.deadline - this.clock.now());
        if (!entry.job) delay = Math.min(delay, entry.nextRenew - this.clock.now());
      }
    }
    this.cancelTimer = this.clock.schedule(() => this.tick(), Math.max(1, delay));
  }
  private grant(entry: Entry, raw: Stage2LeaseReceipt | void, sentAt: number, prior: V2Fence | null): void {
    if (!raw) throw new V2ContractError("invalid_field");
    const fence = parseFence(raw.fence);
    const renewedAt = timestamp(raw.renewedAt), expiresAt = timestamp(raw.expiresAt), centerNow = timestamp(raw.centerNow);
    if (fence.bootId !== this.bootId || fence.epoch !== entry.feature.centerExecution!.epoch
      || centerNow < renewedAt || expiresAt <= renewedAt
      || expiresAt - renewedAt > V2_LEASE_MS) throw new V2ContractError("invalid_field");
    if (prior) assertFence(prior, fence);
    entry.releaseFence = fence;
    if (this.stopped || !this.valid(entry)) return;
    // Starting the center duration at send time subtracts all network/queue delay conservatively.
    // Anchoring it at receive time would extend the lease after a delayed or replayed grant.
    const deadline = sentAt + expiresAt - centerNow - MARGIN_MS;
    if (this.clock.now() >= deadline) { this.lose(entry, "lease_expired"); return; }
    entry.fence = fence;
    entry.deadline = deadline;
    entry.nextRenew = sentAt + V2_RENEW_MS;
  }
  private async request(entry: Entry): Promise<void> {
    const prior = entry.fence ? { ...entry.fence } : null;
    const sentAt = this.clock.now();
    try {
      const raw = await this.port.command(structuredClone(entry.feature),
        prior ? "lease.renew" : "lease.acquire", this.bootId, prior);
      this.grant(entry, raw, sentAt, prior);
    } catch (error) {
      const code = error instanceof V2ContractError ? error.code : "unavailable";
      // Only transient transport failures preserve an existing grant until its conservative deadline.
      if (code !== "unavailable" || !prior) this.lose(entry, code);
      else if (this.valid(entry)) entry.nextRenew = sentAt + V2_RENEW_MS;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.cancelTimer?.();
    for (const entry of this.entries.values()) entry.fence = null;
    this.stopping = this.release();
    return this.stopping;
  }
  private async release(): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => entry.job));
    await Promise.all([...this.entries.values()].map(async entry => {
      if (!entry.releaseFence || this.port.mode(entry.feature.projectId) !== "on") return;
      // Release only this exact incarnation; a late acquire is also cleaned up after graceful stop.
      await this.port.command(structuredClone(entry.feature), "lease.release", this.bootId, { ...entry.releaseFence });
    }));
  }
}

/** No persistent fence is read: a new process must acquire with its new bootId before exposing any grant. */
export function startStage2Leases(port: Stage2LeasePort | null): { stop(): Promise<void>; current(featureId: string): V2Fence | null } {
  if (!port) return { stop: async () => {}, current: () => null };
  const loop = new Stage2Leases(port);
  return { stop: () => loop.stop(), current: id => loop.current(id) };
}
