import { randomUUID } from "node:crypto";
import {
  assertFence, parseFence, parseLeasePolicy, timestamp, V2ContractError, type V2Fence,
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
  /** The center's leasePolicy (X0 shape); unreadable or invalid means no lease is held. */
  leasePolicy(): unknown;
  clock?: Stage2LeaseClock;
  /** Center commands (and an async leasePolicy) that take longer count as unavailable. Default 10 seconds. */
  commandTimeoutMs?: number;
  /** Tick interval while nothing is held or backing off. Default 10 seconds. */
  idleTickMs?: number;
}
type LeasePolicy = ReturnType<typeof parseLeasePolicy>;
interface Entry {
  feature: Stage2LeaseFeature;
  policy: LeasePolicy | null;
  fence: V2Fence | null;
  releaseFence: V2Fence | null;
  deadline: number;
  nextRenew: number;
  lost: boolean;
  /** The port threw while checking this entry: no fence is exposed, renewed or released until it reads again. */
  suspended: boolean;
  job: Promise<void> | null;
  sentAt: number;
  retryAt: number;
  backoffMs: number;
}
const MARGIN_MS = 10_000;
const ACTIVE_TICK_MS = 1000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
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
  private discoveryFailing = false;
  private readonly timeoutMs: number;
  private readonly idleMs: number;

  constructor(private readonly port: Stage2LeasePort) {
    this.clock = port.clock ?? realClock;
    this.bootId = port.bootId ?? randomUUID();
    this.timeoutMs = port.commandTimeoutMs ?? 10_000;
    this.idleMs = port.idleTickMs ?? 10_000;
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
    catch (error) { console.warn("[stage2-leases] onLost callback failed", error); }
  }
  private valid(entry: Entry): boolean {
    if (this.stopped || entry.lost) return false;
    let active: boolean;
    try { active = this.matching(entry); }
    catch (error) {
      // An expired grant is lost whatever the port says; otherwise wait for a readable tick to decide.
      if (entry.fence && this.clock.now() >= entry.deadline) this.lose(entry, "lease_expired");
      else if (!entry.suspended) console.warn("[stage2-leases] port read failed; suspending", entry.feature.localFeatureId, error);
      entry.suspended = !entry.lost;
      return false;
    }
    entry.suspended = false;
    if (!active) this.lose(entry, "inactive");
    else if (entry.fence && this.clock.now() >= entry.deadline) this.lose(entry, "lease_expired");
    return !entry.lost;
  }
  current(featureId: string): V2Fence | null {
    try {
      const entry = this.entries.get(featureId);
      return entry && this.valid(entry) && entry.fence ? { ...entry.fence } : null;
    } catch (error) {
      console.warn("[stage2-leases] current failed", featureId, error);
      return null;
    }
  }
  private tick(): void {
    if (this.stopped) return;
    try { this.step(); }
    catch (error) { console.warn("[stage2-leases] tick failed", error); }
    this.cancelTimer = this.clock.schedule(() => this.tick(), this.delay());
  }
  private step(): void {
    for (const entry of this.entries.values()) this.valid(entry);
    try { this.discover(); this.discoveryFailing = false; }
    catch (error) {
      // Warn once per outage; a suspended loop keeps checking at its normal pace.
      if (!this.discoveryFailing) console.warn("[stage2-leases] feature discovery failed", error);
      this.discoveryFailing = true;
    }
    const now = this.clock.now();
    for (const entry of this.entries.values()) {
      if (!this.valid(entry) || entry.job || now < (entry.fence ? entry.nextRenew : entry.retryAt)) continue;
      entry.job = this.request(entry).finally(() => { entry.job = null; });
    }
  }
  /** A lost (epoch, bootId) is never reacquired; only a newer center epoch gets a fresh entry. */
  private discover(): void {
    for (const feature of this.port.features()) {
      const old = this.entries.get(feature.localFeatureId);
      if (old && !(old.lost && (feature.centerExecution?.epoch ?? 0) > old.feature.centerExecution!.epoch)) continue;
      if (!this.eligible(feature)) continue;
      this.entries.set(feature.localFeatureId, {
        feature: structuredClone(feature), policy: null, fence: null, releaseFence: null, deadline: 0,
        nextRenew: 0, lost: false, suspended: false, job: null, sentAt: 0, retryAt: 0, backoffMs: BACKOFF_MIN_MS,
      });
    }
  }
  private delay(): number {
    let delay = this.idleMs;
    const now = this.clock.now();
    for (const entry of this.entries.values()) {
      if (entry.lost) continue;
      if (entry.fence) {
        delay = Math.min(delay, ACTIVE_TICK_MS, entry.deadline - now);
        // A suspended entry renews nothing, so an overdue nextRenew must not spin the timer.
        if (!entry.job && !entry.suspended) delay = Math.min(delay, entry.nextRenew - now);
      } else if (entry.retryAt > 0 || entry.job) delay = Math.min(delay, ACTIVE_TICK_MS);
    }
    return Math.max(1, delay);
  }
  private timed<T>(value: T | Promise<T>, ms = this.timeoutMs): Promise<T> {
    if (!(value instanceof Promise) || !Number.isFinite(ms)) return Promise.resolve(value);
    return new Promise<T>((resolve, reject) => {
      const cancel = this.clock.schedule(() => reject(new V2ContractError("unavailable")), ms);
      value.then(v => { cancel(); resolve(v); }, e => { cancel(); reject(e); });
    });
  }
  /** Synchronous when the port answers synchronously, so the first acquire still leaves in the same tick. */
  private readPolicy(entry: Entry): LeasePolicy | Promise<LeasePolicy> {
    if (entry.policy) return entry.policy;
    const parse = (raw: unknown) => (entry.policy = parseLeasePolicy(raw));
    const failed = (error: unknown): never => {
      console.warn("[stage2-leases] center leasePolicy unreadable; not holding", entry.feature.localFeatureId, error);
      throw new V2ContractError("unavailable");
    };
    try {
      const raw = this.port.leasePolicy();
      return raw instanceof Promise ? this.timed(raw).then(parse).catch(failed) : parse(raw);
    } catch (error) { return failed(error); }
  }
  private grant(entry: Entry, raw: Stage2LeaseReceipt | void, sentAt: number, prior: V2Fence | null, policy: LeasePolicy): void {
    if (!raw) throw new V2ContractError("invalid_field");
    const fence = parseFence(raw.fence);
    const renewedAt = timestamp(raw.renewedAt), expiresAt = timestamp(raw.expiresAt), centerNow = timestamp(raw.centerNow);
    if (fence.bootId !== this.bootId || fence.epoch !== entry.feature.centerExecution!.epoch
      || centerNow < renewedAt || expiresAt <= renewedAt
      || expiresAt - renewedAt > policy.leaseMs) throw new V2ContractError("invalid_field");
    if (prior) assertFence(prior, fence);
    entry.releaseFence = fence;
    // A suspended entry still records the grant; current() keeps it hidden until the port reads again.
    if (this.stopped) return;
    this.valid(entry);
    if (entry.lost) return;
    // Starting the center duration at send time subtracts all network/queue delay conservatively.
    // Anchoring it at receive time would extend the lease after a delayed or replayed grant.
    const deadline = sentAt + expiresAt - centerNow - MARGIN_MS;
    if (this.clock.now() >= deadline) { this.lose(entry, "lease_expired"); return; }
    entry.fence = fence;
    entry.deadline = deadline;
    entry.nextRenew = sentAt + policy.renewMs;
    entry.retryAt = 0;
  }
  private async request(entry: Entry): Promise<void> {
    const prior = entry.fence ? { ...entry.fence } : null;
    let sentAt = entry.sentAt = this.clock.now();
    try {
      const read = this.readPolicy(entry);
      const policy = read instanceof Promise ? await read : read;
      // Awaiting the policy yields: recheck eligibility (mode, home, migration, suspension) before any center call.
      if (read instanceof Promise && !this.valid(entry)) return;
      if (this.stopped || entry.lost) return;
      sentAt = entry.sentAt = this.clock.now();
      const raw = await this.timed(this.port.command(structuredClone(entry.feature),
        prior ? "lease.renew" : "lease.acquire", this.bootId, prior));
      this.grant(entry, raw, sentAt, prior, policy);
    } catch (error) {
      const code = error instanceof V2ContractError ? error.code : "unavailable";
      // Transient failures keep an existing grant until its conservative deadline, or back off a first acquire.
      if (code !== "unavailable") this.lose(entry, code);
      else if (!prior) {
        entry.retryAt = sentAt + entry.backoffMs;
        entry.backoffMs = Math.min(entry.backoffMs * 2, BACKOFF_MAX_MS);
      } else {
        this.valid(entry);
        if (!entry.lost) entry.nextRenew = sentAt + entry.policy!.renewMs;
      }
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.cancelTimer?.();
    for (const entry of this.entries.values()) entry.fence = null;
    this.stopping = this.release().catch(error => { console.warn("[stage2-leases] stop failed", error); });
    return this.stopping;
  }
  /** Waits for an in-flight request no longer than the grant's deadline (or the command timeout before a grant). */
  private settle(entry: Entry): Promise<void> {
    const job = entry.job;
    if (!job) return Promise.resolve();
    const limit = (entry.deadline > 0 ? entry.deadline : entry.sentAt + this.timeoutMs) - this.clock.now();
    if (!Number.isFinite(limit)) return job;
    return new Promise<void>(resolve => {
      const cancel = this.clock.schedule(() => {
        console.warn("[stage2-leases] stop gave up waiting for a lease request", entry.feature.localFeatureId);
        resolve();
      }, Math.max(0, limit));
      void job.then(() => { cancel(); resolve(); });
    });
  }
  private async release(): Promise<void> {
    await Promise.all([...this.entries.values()].map(entry => this.settle(entry)));
    await Promise.all([...this.entries.values()].map(async entry => {
      try {
        // A suspended entry (or a port that cannot read now) is neither renewed nor released.
        if (!entry.releaseFence || entry.suspended) return;
        this.port.features();
        if (this.port.mode(entry.feature.projectId) !== "on") return;
        // The whole stop shares the grant's deadline: a release past it is still sent, but not awaited.
        const ms = entry.deadline > 0 ? Math.min(this.timeoutMs, Math.max(0, entry.deadline - this.clock.now())) : this.timeoutMs;
        // Release only this exact incarnation; a late acquire is also cleaned up after graceful stop.
        await this.timed(this.port.command(structuredClone(entry.feature), "lease.release", this.bootId, { ...entry.releaseFence }), ms);
      } catch (error) {
        console.warn("[stage2-leases] lease release failed", entry.feature.localFeatureId, error);
      }
    }));
  }
}

/** No persistent fence is read: a new process must acquire with its new bootId before exposing any grant. */
export function startStage2Leases(port: Stage2LeasePort | null): { stop(): Promise<void>; current(featureId: string): V2Fence | null } {
  if (!port) return { stop: async () => {}, current: () => null };
  const loop = new Stage2Leases(port);
  return { stop: () => loop.stop(), current: id => loop.current(id) };
}
