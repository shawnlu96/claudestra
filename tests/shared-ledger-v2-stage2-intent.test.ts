import { describe, expect, test } from "bun:test";
import type { AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { configureSchedulerV2Intents, withSchedulerV2Intents, type SchedulerV2IntentPort, type SchedulerV2IntentRoute } from "../src/lib/scheduler-v2-intent.js";
import type { V2Fence } from "../src/lib/shared-ledger-contract-v2.js";
import type { EnsureResult, SessionRef, SubmitReceipt, WorkerSession, WorkOrder } from "../src/lib/worker-session.js";
import { INTENT_FENCE, intentCenter } from "./shared-ledger-v2-stage2-intent-fixture.test.js";

const HEAD = "d".repeat(40);
const task = { id: "T1", project: "p", agent: "agent-one" } as LedgerTask;
const ref: SessionRef = { taskId: "T1", role: "author", agent: "agent-one", sessionId: "s-one", family: "claude", transport: "tmux" };
const order = (step: WorkOrder["step"] = "write", head: string | null = HEAD): WorkOrder => ({ taskId: "T1", specRev: 1, head, round: 0,
  node: step === "review" ? "adversarial_review" : "write", step, dedupKey: "intent-one", inputs: [], outputs: [], acceptance: [], writeBack: "" });

/** Spy-backed original ports; every effect counts so pass-through and suppression can be compared exactly. */
function original(onSubmit?: () => void) {
  const counts = { submit: 0, ensure: 0, pin: 0, notify: 0, cancel: 0, manager: 0 };
  let sendResult: SubmitReceipt = { status: "sent", route: "channel", messageKey: "m1", evidence: "ok" };
  const session: WorkerSession = { route: "channel", fallbackReason: null,
    ensure: async () => ({ kind: "wait", reason: "n/a" }),
    submit: async () => { counts.submit++; onSubmit?.(); return sendResult; },
    observe: async () => ({ state: "running", busy: true }),
    cancel: async () => { counts.cancel++; return { ok: true, evidence: "c" }; },
    archive: async () => { counts.cancel++; return { ok: true, evidence: "a" }; } };
  const ready: EnsureResult = { kind: "ready", ref, created: false };
  let duringEnsure: (() => void) | undefined;
  const deps: AutoTickDeps = {
    manager: async () => { counts.manager++; return { ok: true }; },
    worker: () => session,
    ensure: async () => { counts.ensure++; duringEnsure?.(); return ready; },
    pinReview: async () => { counts.pin++; return { dir: "/tmp/rv" }; },
    reviewDirty: async () => null,
    notifyPm: async () => { counts.notify++; },
    now: () => 1000,
  };
  return { deps, session, ready, counts, setSend: (r: SubmitReceipt) => { sendResult = r; },
    duringEnsure: (fn: () => void) => { duringEnsure = fn; } };
}

function port(route: SchedulerV2IntentRoute, extra: Partial<SchedulerV2IntentPort> = {}) {
  const wrapped: unknown[] = [], routes: string[] = [], observed: string[] = [];
  const p: SchedulerV2IntentPort = {
    route: (id) => { routes.push(id); return route; },
    wrapManager: (m) => { wrapped.push(m); const w = async (...args: string[]) => m(...args); return w; },
    observe: (_id, code) => { observed.push(code); },
    ...extra,
  };
  configureSchedulerV2Intents(p);
  return { p, wrapped, routes, observed };
}

describe("S2I routing of the auto tick's side-effect ports", () => {
  test("no port: the original deps object is returned untouched", () => {
    const o = original();
    configureSchedulerV2Intents(null);
    expect(withSchedulerV2Intents(o.deps)).toBe(o.deps);
  });

  test("route=local passes every port through: same objects, same spy counts, zero center requests", async () => {
    const o = original(), c = intentCenter(), { wrapped, routes } = port("local", { central: c.bound as never, fence: () => INTENT_FENCE });
    const deps = withSchedulerV2Intents(o.deps);
    expect(wrapped).toEqual([o.deps.manager]);
    expect(deps.worker(ref)).toBe(o.session);
    expect(await deps.ensure(task, "author", "claude")).toBe(o.ready);
    expect(await deps.pinReview(task, ref, HEAD)).toEqual({ dir: "/tmp/rv" });
    await deps.notifyPm(task, "hi");
    const w = deps.worker(ref) as WorkerSession;
    expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "sent" });
    expect(o.counts).toEqual({ submit: 1, ensure: 1, pin: 1, notify: 1, cancel: 0, manager: 0 });
    for (const key of ["now", "reviewDirty"] as const) expect(deps[key]).toBe(o.deps[key]);
    expect(routes.every((id) => id === "T1")).toBe(true);
    expect(c.calls).toHaveLength(0);
  });

  test("route=skip (incl. migrating): zero center requests and zero side effects", async () => {
    const o = original(), c = intentCenter();
    const fence = () => INTENT_FENCE;
    const { observed } = port("skip", { central: c.bound as never, fence, claimFence: fence });
    const deps = withSchedulerV2Intents(o.deps);
    const w = deps.worker(ref) as WorkerSession;
    expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected" });
    expect(await w.cancel(ref)).toMatchObject({ ok: false, unknown: false });
    expect(await w.archive(ref)).toMatchObject({ ok: false, unknown: false });
    expect(await deps.ensure(task, "author", "claude")).toMatchObject({ kind: "wait" });
    expect(await deps.pinReview(task, ref, HEAD)).toHaveProperty("manual");
    await deps.notifyPm(task, "hi");
    expect(o.counts).toEqual({ submit: 0, ensure: 0, pin: 0, notify: 0, cancel: 0, manager: 0 });
    expect(c.calls).toHaveLength(0);
    expect(observed.every((code) => code === "skip")).toBe(true);
  });
});

describe("S2I central dispatch / review through executeSchedulerCentral", () => {
  for (const step of ["write", "review"] as const) {
    test(`${step}: center checks precede the send, operation.result once after; manager is wrapManager(original)`, async () => {
      const c = intentCenter();
      const o = original(() => expect(c.types()).toEqual(["authorization.check", "intent.check"]));
      const action = step === "review" ? "review" : "dispatch";
      const { wrapped } = port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, action) });
      const deps = withSchedulerV2Intents(o.deps);
      expect(wrapped).toEqual([o.deps.manager]);
      await deps.manager("ledger", "scheduler-settle", "x");
      expect(o.counts.manager).toBe(1);
      const w = deps.worker({ ...ref, role: step === "review" ? "reviewer" : "author" }) as WorkerSession;
      expect(await w.submit(ref, "intent-one", order(step))).toEqual({ status: "sent", route: "channel", messageKey: "m1", evidence: "ok" });
      // X8 rechecks after the send as well (a lease lost during it turns success into unknown); the result is reported once.
      expect(c.types()).toEqual(["authorization.check", "intent.check", "authorization.check", "intent.check", "operation.result"]);
      const result = c.calls[4]!;
      expect(result.type === "operation.result" && result.payload.result).toMatchObject({ state: "succeeded", intentId: "intent-one", ...INTENT_FENCE });
      expect(o.counts.submit).toBe(1);
      // The durable journal makes a repeated submit of the same intent a replay: no second send, no second check.
      await w.submit(ref, "intent-one", order(step));
      expect(o.counts.submit).toBe(1);
      expect(c.calls).toHaveLength(5);
    });
  }

  test("lease lost mid-send: unknown, resources held, no further effect, no local retry", async () => {
    const c = intentCenter();
    const o = original(() => { c.state.held = false; });
    port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch") });
    const w = withSchedulerV2Intents(o.deps).worker(ref) as WorkerSession;
    const got = await w.submit(ref, "intent-one", order());
    expect(got.status).toBe("unknown");
    expect(c.types()).toEqual(["authorization.check", "intent.check", "operation.result"]);
    const reported = c.calls[2]!;
    expect(reported.type === "operation.result" && reported.payload.result.state).toBe("unknown"); // center keeps the resources
    const entry = c.journal.read(c.bound("T1", "intent-one", HEAD, "dispatch").context)!;
    expect(entry).toMatchObject({ state: "confirmed", result: { state: "unknown" } });
    c.state.held = true;
    expect((await w.submit(ref, "intent-one", order())).status).toBe("unknown");
    expect(o.counts.submit).toBe(1);
    expect(c.calls).toHaveLength(3);
  });

  test("a transport rejection is reported as failed and returned as the original rejected receipt", async () => {
    const c = intentCenter(), o = original();
    o.setSend({ status: "rejected", route: "channel", reason: "bridge 拒收" });
    port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch") });
    const w = withSchedulerV2Intents(o.deps).worker(ref) as WorkerSession;
    expect(await w.submit(ref, "intent-one", order())).toEqual({ status: "rejected", route: "channel", reason: "bridge 拒收" });
    const reported = c.calls.at(-1)!;
    expect(reported.type === "operation.result" && reported.payload.result.state).toBe("failed");
  });

  test("center refusal before the send: rejected, zero sends, no result report", async () => {
    const c = intentCenter(), o = original();
    c.state.refuse = "stale_epoch";
    port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch") });
    const w = withSchedulerV2Intents(o.deps).worker(ref) as WorkerSession;
    expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected" });
    expect(o.counts.submit).toBe(0);
    expect(c.types()).toEqual(["authorization.check"]);
  });

  test("missing or mismatched context holds with zero requests and zero sends", async () => {
    const c = intentCenter();
    const cases: Partial<SchedulerV2IntentPort>[] = [{}, { central: () => null },
      { central: (t, i) => c.bound(t, i, "e".repeat(40), "dispatch") }, { central: (t, i) => c.bound(t, i, HEAD, "review") },
      { central: (t) => c.bound(t, "other-intent", HEAD, "dispatch") }];
    for (const extra of cases) {
      const o = original();
      const { observed } = port("central", extra);
      const w = withSchedulerV2Intents(o.deps).worker(ref) as WorkerSession;
      expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected" });
      expect(await w.cancel(ref)).toMatchObject({ ok: false });
      expect(o.counts).toMatchObject({ submit: 0, cancel: 0 });
      expect(observed.length).toBeGreaterThan(0);
    }
    expect(c.calls).toHaveLength(0);
  });
});

describe("S2I ensure lease guard (unit)", () => {
  const other: V2Fence = { ...INTENT_FENCE, epoch: 2 };
  test("missing lease methods hold as v2_unmapped without building", async () => {
    const o = original();
    const { observed } = port("central");
    expect(await withSchedulerV2Intents(o.deps).ensure(task, "author", "claude")).toMatchObject({ kind: "wait" });
    expect(o.counts.ensure).toBe(0);
    expect(observed).toEqual(["v2_unmapped"]);
  });

  for (const [name, now, claim] of [["null fence", null, INTENT_FENCE], ["no claim", INTENT_FENCE, null],
    ["other epoch", other, INTENT_FENCE], ["other boot", { ...INTENT_FENCE, bootId: "boot-two" }, INTENT_FENCE]] as const) {
    test(`${name}: wait "lease", ensure never called`, async () => {
      const o = original();
      port("central", { fence: () => now, claimFence: () => claim });
      expect(await withSchedulerV2Intents(o.deps).ensure(task, "author", "claude")).toEqual({ kind: "wait", reason: "lease" });
      expect(o.counts.ensure).toBe(0);
    });
  }

  test("same term before and after: the original result; term moved during the build: unknown", async () => {
    const o = original();
    let fence: V2Fence | null = INTENT_FENCE;
    port("central", { fence: () => fence, claimFence: () => INTENT_FENCE });
    const deps = withSchedulerV2Intents(o.deps);
    expect(await deps.ensure(task, "author", "claude")).toBe(o.ready);
    for (const next of [other, null]) {
      o.duringEnsure(() => { fence = next; });
      fence = INTENT_FENCE;
      expect(await deps.ensure(task, "author", "claude")).toMatchObject({ kind: "unknown" });
    }
    expect(o.counts.ensure).toBe(3);
  });
});
