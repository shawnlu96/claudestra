import { afterEach } from "bun:test";
import {
  startStage2Leases, type Stage2LeaseClock, type Stage2LeaseFeature, type Stage2LeasePort, type Stage2LeaseReceipt,
} from "../src/lib/scheduler-v2-lease.js";
import { V2ContractError, type V2Fence } from "../src/lib/shared-ledger-contract-v2.js";

export const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
class Clock implements Stage2LeaseClock {
  time = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await flush();
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}
type Controller = ReturnType<typeof startStage2Leases>;
const controllers: Controller[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.stop(); });
export function feature(id = "F"): Stage2LeaseFeature {
  return { localFeatureId: id, projectId: "local-project", homeInstanceId: "home",
    centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: id, epoch: 1 } };
}
export function fixture(bootId: string | undefined = "boot-1") {
  const clock = new Clock();
  let mode: "off" | "observe" | "on" = "on";
  let features = [feature()];
  const calls: { feature: Stage2LeaseFeature; type: string; bootId: string; fence: V2Fence | null; at: number }[] = [];
  const lost: { id: string; reason: string }[] = [];
  const receipt = (f: Stage2LeaseFeature, boot: string): Stage2LeaseReceipt => {
    const centerNow = 1_700_000_000_000 + clock.time;
    return { fence: { serviceGeneration: 7, epoch: f.centerExecution!.epoch, bootId: boot },
      centerNow, renewedAt: centerNow, expiresAt: centerNow + 60_000 };
  };
  let respond: Stage2LeasePort["command"] = async (f, _type, boot) => receipt(f, boot);
  const port: Stage2LeasePort = {
    instanceId: "home", bootId, clock, features: () => features, mode: () => mode,
    async command(f, type, boot, fence) {
      calls.push({ feature: f, type, bootId: boot, fence, at: clock.time });
      return respond(f, type, boot, fence);
    },
    onLost: (id, reason) => { lost.push({ id, reason }); },
    leasePolicy: () => ({ leaseMs: 60_000, renewMs: 15_000, clock: "central" }),
  };
  const start = () => { const controller = startStage2Leases(port); controllers.push(controller); return controller; };
  return { clock, calls, lost, port, start, receipt, setMode: (m: typeof mode) => { mode = m; },
    setFeatures: (fs: Stage2LeaseFeature[]) => { features = fs; },
    respond: (fn: Stage2LeasePort["command"]) => { respond = fn; } };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

