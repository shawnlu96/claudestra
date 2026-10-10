import { describe, expect, test } from "bun:test";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents, type SchedulerV2IntentRoute } from "../src/lib/scheduler-v2-intent.js";
import type { ControlReceipt, EnsureResult, SessionRef, SubmitReceipt, WorkerObservation, WorkerSession, WorkOrder } from "../src/lib/worker-session.js";

const ref: SessionRef = { taskId: "T1", role: "author", agent: "agent-one", sessionId: "s-one", family: "claude", transport: "tmux" };
const order = { taskId: "T1", specRev: 1, head: "d".repeat(40), round: 0, node: "write", step: "write", dedupKey: "intent-one",
  inputs: [], outputs: [], acceptance: [], writeBack: "" } as WorkOrder;
const METHODS = ["ensure", "submit", "observe", "cancel", "archive"] as const;
const boom = new Error("observe failed");
type Call = { key: string; self: unknown; args: unknown[] };

/** Methods on the prototype only; the instance is frozen. */
class ProtoWorker implements WorkerSession {
  readonly route = "channel" as const;
  readonly fallbackReason = null;
  constructor(readonly calls: Call[]) {}
  async ensure(...args: unknown[]): Promise<EnsureResult> { this.calls.push({ key: "ensure", self: this, args }); return { kind: "wait", reason: "w" }; }
  async submit(...args: unknown[]): Promise<SubmitReceipt> { this.calls.push({ key: "submit", self: this, args }); return SENT; }
  async observe(...args: unknown[]): Promise<WorkerObservation> { this.calls.push({ key: "observe", self: this, args }); throw boom; }
  async cancel(...args: unknown[]): Promise<ControlReceipt> { this.calls.push({ key: "cancel", self: this, args }); return { ok: true, evidence: "c" }; }
  async archive(...args: unknown[]): Promise<ControlReceipt> { this.calls.push({ key: "archive", self: this, args }); return { ok: true, evidence: "a" }; }
}
const SENT: SubmitReceipt = { status: "sent", route: "channel", messageKey: "m1", evidence: "ok" };

/** The same methods as own non-enumerable properties of a plain object. */
function hiddenWorker(calls: Call[]): WorkerSession {
  const w = { route: "channel", fallbackReason: null } as Record<string, unknown>;
  for (const key of METHODS) {
    Object.defineProperty(w, key, { enumerable: false, value: async function (this: unknown, ...args: unknown[]) {
      calls.push({ key, self: this, args });
      if (key === "observe") throw boom;
      return key === "submit" ? SENT : key === "ensure" ? { kind: "wait", reason: "w" } : { ok: true, evidence: key[0] };
    } });
  }
  return w as unknown as WorkerSession;
}

const shapes: [string, (calls: Call[]) => WorkerSession][] = [
  ["frozen class instance (methods on the prototype)", (calls) => Object.freeze(new ProtoWorker(calls))],
  ["object with non-enumerable methods", hiddenWorker],
];

function wire(session: WorkerSession, route: () => SchedulerV2IntentRoute) {
  const center: unknown[] = [];
  configureSchedulerV2Intents({ route: () => route(), wrapManager: (m) => m, observe: () => {},
    central: (...args) => { center.push(args); return null; } });
  const deps = withSchedulerV2Intents({ worker: () => session } as unknown as AutoTickDeps);
  return { w: deps.worker(ref) as WorkerSession, center };
}

describe("S2I route=local worker over any WorkerSession shape (验收线 5)", () => {
  for (const [name, make] of shapes) {
    test(`${name}: every method forwards with the original this, arguments, receipt and throw`, async () => {
      const calls: Call[] = [], session = make(calls), frozen = Object.isFrozen(session);
      const before = Object.fromEntries(METHODS.map((k) => [k, session[k]]));
      const { w, center } = wire(session, () => "local");
      expect(w).not.toBe(session);
      expect(Object.isFrozen(session)).toBe(frozen);
      for (const k of METHODS) { expect(typeof w[k]).toBe("function"); expect(session[k]).toBe(before[k]); }
      expect(w.route).toBe("channel");
      expect(w.fallbackReason).toBeNull();
      expect(await w.ensure("T1", "author", "claude")).toEqual({ kind: "wait", reason: "w" });
      expect(await w.submit(ref, "intent-one", order)).toBe(SENT);
      await expect(w.observe(ref, order as never)).rejects.toBe(boom);
      expect(await w.cancel(ref)).toEqual({ ok: true, evidence: "c" });
      expect(await w.archive(ref)).toEqual({ ok: true, evidence: "a" });
      expect(calls).toEqual([
        { key: "ensure", self: session, args: ["T1", "author", "claude"] },
        { key: "submit", self: session, args: [ref, "intent-one", order] },
        { key: "observe", self: session, args: [ref, order] },
        { key: "cancel", self: session, args: [ref] },
        { key: "archive", self: session, args: [ref] },
      ]);
      expect(center).toHaveLength(0);
    });

    for (const to of ["skip", "central"] as const) {
      test(`${name}: route flips to ${to} after the hand-out — zero local sends, observe still forwards`, async () => {
        const calls: Call[] = [], session = make(calls);
        let route: SchedulerV2IntentRoute = "local";
        const { w, center } = wire(session, () => route);
        route = to;
        expect(await w.submit(ref, "intent-one", order)).toMatchObject({ status: "rejected", route: "channel" });
        expect(calls.filter((c) => c.key === "submit")).toHaveLength(0);
        await expect(w.observe(ref, order as never)).rejects.toBe(boom);
        expect(center).toHaveLength(0);
      });
    }

    for (const route of ["skip", "central"] as const) {
      test(`${name}: a ${route} worker keeps route / fallbackReason and never sends`, async () => {
        const calls: Call[] = [], session = make(calls);
        const { w } = wire(session, () => route);
        expect(w.route).toBe("channel");
        expect(w.fallbackReason).toBeNull();
        expect(typeof w.observe).toBe("function");
        expect(await w.submit(ref, "intent-one", order)).toMatchObject({ status: "rejected" });
        expect(calls.filter((c) => c.key === "submit")).toHaveLength(0);
      });
    }
  }

  test("a method the original lacks is absent on the forwarding object too (typeof agrees)", () => {
    const calls: Call[] = [], session = hiddenWorker(calls);
    const partial = Object.freeze(Object.create(null, Object.fromEntries(["route", "fallbackReason", "submit", "observe", "ensure", "cancel"]
      .map((k) => [k, Object.getOwnPropertyDescriptor(session, k)!])))) as WorkerSession;
    const { w } = wire(partial, () => "local");
    for (const k of METHODS) expect(typeof w[k]).toBe(typeof partial[k]);
    expect("archive" in w).toBe(false);
  });
});
