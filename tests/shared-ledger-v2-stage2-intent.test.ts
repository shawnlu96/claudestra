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
    const w = deps.worker(ref) as WorkerSession;
    expect(w).not.toBe(o.session); // 验收线 5 (PM 定 10-10): the local worker is a forwarding object
    expect(await deps.ensure(task, "author", "claude")).toBe(o.ready);
    expect(await deps.pinReview(task, ref, HEAD)).toEqual({ dir: "/tmp/rv" });
    await deps.notifyPm(task, "hi");
    expect(await deps.manager("ledger", "scheduler-settle", "intent-one", "--from", "pending", "--to", "submitted", "--receipt", "c"))
      .toEqual({ ok: true });
    expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "sent" });
    expect(o.counts).toEqual({ submit: 1, ensure: 1, pin: 1, notify: 1, cancel: 0, manager: 1 });
    for (const key of ["now", "reviewDirty"] as const) expect(deps[key]).toBe(o.deps[key]);
    expect(routes.every((id) => id === "T1")).toBe(true);
    expect(c.calls).toHaveLength(0);
  });

  test("route=local worker, plain or frozen: original untouched (still frozen, same submit), every method forwards exactly", async () => {
    for (const frozen of [false, true]) {
      const o = original(), c = intentCenter(), calls: { key: string; self: unknown; args: unknown[] }[] = [];
      const boom = new Error("boom"), base: WorkerSession = { ...o.session,
        observe: async function (this: unknown, ...args: unknown[]) { calls.push({ key: "observe", self: this, args }); throw boom; } as never,
        cancel: async function (this: unknown, ...args: unknown[]) { calls.push({ key: "cancel", self: this, args }); return { ok: true, evidence: "c" }; } as never };
      const session = frozen ? Object.freeze(base) : base, members = { ...session };
      const { routes } = port("local", { central: c.bound as never });
      const deps = withSchedulerV2Intents({ ...o.deps, worker: () => session });
      const w = deps.worker(ref) as WorkerSession;
      expect(Object.isFrozen(session)).toBe(frozen);
      for (const key of Object.keys(members) as (keyof WorkerSession)[]) expect(session[key]).toBe(members[key]);
      expect(Object.keys(w).sort()).toEqual(Object.keys(members).sort());
      expect(w.route).toBe(session.route);
      expect(w.fallbackReason).toBe(session.fallbackReason);
      const sent = { status: "sent", route: "channel", messageKey: "m2", evidence: "x" } as const;
      o.setSend(sent);
      const before = routes.length;
      expect(await w.submit(ref, "intent-one", order())).toBe(sent);
      expect(routes.length - before).toBe(1); // one route read per send, no center request
      await expect(w.observe(ref, order() as never)).rejects.toBe(boom);
      expect(await w.cancel(ref)).toEqual({ ok: true, evidence: "c" });
      expect(calls).toEqual([{ key: "observe", self: session, args: [ref, order()] }, { key: "cancel", self: session, args: [ref] }]);
      expect(o.counts.submit).toBe(1);
      expect(session.submit).toBe(members.submit);
      expect(c.calls).toHaveLength(0);
    }
  });

  test("a local worker whose original submit throws or rejects: the forwarding object throws the same", async () => {
    const o = original(), boom = new Error("send failed");
    const session: WorkerSession = { ...o.session, submit: async () => { throw boom; } };
    port("local");
    const w = withSchedulerV2Intents({ ...o.deps, worker: () => session }).worker(ref) as WorkerSession;
    await expect(w.submit(ref, "intent-one", order())).rejects.toBe(boom);
  });

  test("a local card that leaves local (skip / central) before, during or after the claim is never sent", async () => {
    const claim = ["ledger", "scheduler-settle", "intent-one", "--from", "pending", "--to", "submitted", "--receipt", "c"];
    for (const to of ["skip", "central"] as const) {
      for (const when of ["before", "during", "after"] as const) {
        const o = original(), c = intentCenter(), seen: string[][] = [], submit = o.session.submit;
        let route: SchedulerV2IntentRoute = "local";
        const { observed } = port("local", { central: c.bound as never, route: () => route,
          wrapManager: (m) => async (...args) => { seen.push(args); if (when === "during") route = to; return m(...args); } });
        const deps = withSchedulerV2Intents(o.deps);
        const w = deps.worker(ref) as WorkerSession; // taken while local, as Card.work does
        if (when === "before") route = to;
        expect(await deps.manager(...claim)).toEqual({ ok: true }); // the claim is S2Q's (wrapManager)
        if (when === "after") route = to;
        expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected", route: "channel" });
        expect(seen).toEqual([claim]);
        expect(o.counts.submit).toBe(0);
        expect(o.session.submit).toBe(submit);
        expect(c.calls).toHaveLength(0);
        expect(observed).toEqual([to === "skip" ? "skip" : "route_changed"]);
      }
    }
  });

  test("the send guard reads only the sent card's route: another card leaving local never touches this card", async () => {
    const o = original(), routes: Record<string, SchedulerV2IntentRoute> = { T1: "local", T2: "local" };
    const { observed } = port("local", { route: (id) => routes[id] ?? "skip" });
    const ref2: SessionRef = { ...ref, taskId: "T2", agent: "agent-two", sessionId: "s-two" };
    const deps = withSchedulerV2Intents(o.deps);
    const w1 = deps.worker(ref) as WorkerSession, w2 = deps.worker(ref2) as WorkerSession;
    routes.T1 = "skip";
    expect(await w2.submit(ref2, "intent-two", { ...order(), taskId: "T2", dedupKey: "intent-two" })).toMatchObject({ status: "sent" });
    expect(await w1.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected" });
    expect(o.counts.submit).toBe(1);
    expect(observed).toEqual(["skip"]);
  });

  test("the route is read at every hand-out: the original handed out again as skip / central is wrapped, never modified", async () => {
    const c = intentCenter(), o = original(), submit = o.session.submit;
    let route: SchedulerV2IntentRoute = "local";
    const { observed } = port("local", { route: () => route, central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch") });
    const deps = withSchedulerV2Intents(o.deps);
    expect(deps.worker(ref)).not.toBe(o.session);
    route = "skip";
    const skipped = deps.worker(ref) as WorkerSession;
    expect(await skipped.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected" });
    expect(o.counts.submit).toBe(0);
    expect(c.calls).toHaveLength(0);
    route = "central";
    const central = deps.worker(ref) as WorkerSession;
    expect(await central.submit(ref, "intent-one", order())).toMatchObject({ status: "sent" });
    expect(o.counts.submit).toBe(1);
    expect(c.types().at(-1)).toBe("operation.result");
    expect(o.session.submit).toBe(submit);
    expect(observed).toEqual(["skip"]);
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

  test("a transport refusal after X8 began is reported once as unknown and returned unknown (held, never read as sent)", async () => {
    const c = intentCenter(), o = original();
    o.setSend({ status: "rejected", route: "channel", reason: "bridge 拒收" });
    port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch") });
    const w = withSchedulerV2Intents(o.deps).worker(ref) as WorkerSession;
    const got = await w.submit(ref, "intent-one", order());
    expect(got).toMatchObject({ status: "unknown", route: "channel" });
    expect(got.status === "unknown" && got.reason).toContain("bridge 拒收");
    expect(c.types().filter((t) => t === "operation.result")).toHaveLength(1);
    const reported = c.calls.at(-1)!;
    expect(reported.type === "operation.result" && reported.payload.result).toMatchObject({ state: "unknown" });
    expect(reported.type === "operation.result" && reported.payload.result.summary).toContain("未投递（本机明确拒收）");
    expect(o.counts.submit).toBe(1);
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

describe("S2I one result writer and the route guard up to the send", () => {
  const settle = (to: string, from = "submitted") => ["ledger", "scheduler-settle", "intent-one", "--from", from, "--to", to, "--receipt", "r"];

  test("after X8 reported, the driver's settle never reaches S2Q: settled answers it, or it holds without a request", async () => {
    for (const wired of [false, true]) {
      const c = intentCenter(), o = original(), settledCalls: string[][] = [];
      port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch"),
        ...(wired ? { settled: async (...a: string[]) => { settledCalls.push(a); return { ok: true, projected: true }; } } : {}) });
      const deps = withSchedulerV2Intents(o.deps);
      // pending→submitted of the same intent and settles of intents X8 never ran stay plain S2Q traffic.
      expect(await deps.manager(...settle("submitted", "pending"))).toEqual({ ok: true });
      expect(o.counts.manager).toBe(1);
      const w = deps.worker(ref) as WorkerSession;
      expect((await w.submit(ref, "intent-one", order())).status).toBe("sent");
      const calls = c.calls.length;
      expect(await deps.manager(...settle("done"))).toEqual(wired ? { ok: true, projected: true } : { ok: false, code: "v2_unmapped" });
      expect(o.counts.manager).toBe(1); // no second operation.result through S2Q
      expect(c.calls).toHaveLength(calls);
      expect(c.types().filter((t) => t === "operation.result")).toHaveLength(1);
      expect(settledCalls).toEqual(wired ? [["T1", "intent-one", "done"]] : []);
    }
  });

  test("a refusal before X8 began journals nothing: the cancel settle passes through to S2Q", async () => {
    const c = intentCenter(), o = original();
    c.state.refuse = "stale_epoch";
    port("central", { central: (taskId, intentId) => c.bound(taskId, intentId, HEAD, "dispatch"), settled: async () => ({ ok: false }) });
    const deps = withSchedulerV2Intents(o.deps);
    expect((await (deps.worker(ref) as WorkerSession).submit(ref, "intent-one", order())).status).toBe("rejected");
    expect(await deps.manager(...settle("cancelled"))).toEqual({ ok: true });
    expect(o.counts.manager).toBe(1);
  });

  for (const flipOn of ["authorization.check", "intent.check"] as const) {
    test(`route leaves central while X8 awaits ${flipOn}: no send, blocked, nothing reported`, async () => {
      const c = intentCenter(), o = original();
      let route: SchedulerV2IntentRoute = "central", flipped = false;
      const { p, observed } = port("central", { central: (taskId, intentId) => {
        const b = c.bound(taskId, intentId, HEAD, "dispatch"), inner = b.runtime.client;
        return { ...b, runtime: { ...b.runtime, client: { command: async (cmd) => {
          const r = await inner.command(cmd);
          if (cmd.type === flipOn && !flipped) { flipped = true; route = "skip"; } // the home lock stays held
          return r;
        } } } };
      } });
      configureSchedulerV2Intents({ ...p, route: () => route });
      const w = withSchedulerV2Intents(o.deps).worker(ref) as WorkerSession;
      expect(await w.submit(ref, "intent-one", order())).toMatchObject({ status: "rejected", reason: expect.stringContaining("route_changed") });
      expect(o.counts.submit).toBe(0);
      expect(c.types()).toEqual(flipOn === "intent.check" ? ["authorization.check", "intent.check"] : ["authorization.check"]);
      expect(c.journal.read(c.bound("T1", "intent-one", HEAD, "dispatch").context)).toBeNull();
      expect(observed).toContain("route_changed");
    });
  }
});
