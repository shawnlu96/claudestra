import { describe, expect, test } from "bun:test";
import { createServicePlan, runServicePlan } from "../src/lib/floka-services/plan/index.ts";
import type { Controller, Journal, Lease, Service, ServicePlan, Side, State } from "../src/lib/floka-services/plan/types.ts";

const plan = createServicePlan("rename-1", {
  repoRoot: "/fixture/repo", bunPath: "/fixture/bun", home: "/fixture/home", envPath: "/bin", logDir: "/fixture/log",
});

// Every operation can lose its reply before or after its durable effect, just like a process crash.
class Fake implements Controller {
  journal: Journal | null = null;
  events: string[] = [];
  states = new Map<string, State>();
  prepared = new Set<string>();
  restored = new Set<string>();
  legacyClear = true;
  healthy = true;
  stuck: Side | null = null;
  locked = false;
  leaseValid = true;
  calls = 0;
  fault = -1;
  after = false;
  maxLive = 1;
  constructor() {
    for (const [i, d] of plan.services.entries()) {
      this.states.set(`old:${d.name}`, { loaded: true, pids: [100 + i] });
      this.states.set(`new:${d.name}`, { loaded: false, pids: [] });
    }
  }
  async call<T>(event: string, effect: () => T): Promise<T> {
    this.events.push(event);
    const fail = ++this.calls === this.fault;
    if (fail && !this.after) throw new Error(`before ${event}`);
    const result = effect();
    for (const d of plan.services) {
      const old = this.states.get(`old:${d.name}`)!;
      const next = this.states.get(`new:${d.name}`)!;
      const live = old.pids!.length + next.pids!.length;
      this.maxLive = Math.max(this.maxLive, live);
      expect(live).toBeLessThanOrEqual(1);
      expect(old.loaded && next.loaded).toBe(false);
    }
    if (fail) throw new Error(`after ${event}`);
    return structuredClone(result);
  }
  async withLock<T>(key: string, run: (lease: Lease) => Promise<T>): Promise<T> {
    expect(key).toBe("floka-services");
    if (this.locked) throw new Error("busy");
    this.locked = true;
    try {
      return await run({ assertHeld: () => { if (!this.leaseValid) throw new Error("lost lease"); } });
    } finally { this.locked = false; }
  }
  readJournal() { return this.call("read", () => this.journal); }
  saveJournal(j: Journal) { return this.call(`save:${j.direction}:${j.cursor}`, () => { this.journal = structuredClone(j); }); }
  auditLegacy() {
    return this.call("legacy", () => Object.fromEntries(plan.legacyLabels.map((label) => [label,
      { loaded: false, pids: [], restartDisabled: this.legacyClear }])));
  }
  inspect(_p: ServicePlan, d: Service, side: Side) {
    return this.call(`inspect:${side}:${d.name}`, () => this.states.get(`${side}:${d.name}`)!);
  }
  prepare(_p: ServicePlan, d: Service) {
    return this.call(`prepare:${d.name}`, () => { this.prepared.add(d.name); });
  }
  unload(_p: ServicePlan, d: Service, side: Side) {
    return this.call(`unload:${side}:${d.name}`, () => {
      const state = this.states.get(`${side}:${d.name}`)!;
      state.loaded = false;
      if (this.stuck !== side) state.pids = [];
    });
  }
  waitExited(_p: ServicePlan, d: Service, side: Side) {
    return this.call(`exit:${side}:${d.name}`, () => this.states.get(`${side}:${d.name}`)!.pids?.length === 0);
  }
  restoreOld(_p: ServicePlan, d: Service) {
    return this.call(`restore:${d.name}`, () => { this.restored.add(d.name); });
  }
  load(_p: ServicePlan, d: Service, side: Side) {
    return this.call(`load:${side}:${d.name}`, () => {
      expect(this.prepared.has(d.name) || side === "old").toBe(true);
      if (side === "old") expect(this.restored.has(d.name)).toBe(true);
      this.states.set(`${side}:${d.name}`, { loaded: true, pids: [side === "old" ? 123 : 456] });
    });
  }
  health(_p: ServicePlan, d: Service, side: Side) {
    return this.call(`health:${side}:${d.name}`, () => this.healthy && this.states.get(`${side}:${d.name}`)!.pids?.length === 1);
  }
  commit(_p: ServicePlan, side: Side) { return this.call(`commit:${side}`, () => undefined); }
}
const run = (controller: Fake, action: "resume" | "rollback" = "resume") =>
  runServicePlan({ plan, controller, rename: { services: "on" }, action });
const effects = (f: Fake) => f.events.filter((s) => /^(prepare|unload|exit|load|health|commit|restore):/.test(s));
const group = (prefix: string) => plan.services.map((d) => `${prefix}:${d.name}`);

describe("Floka service switch", () => {
  test("reuses plist renderer for all four daemons", () => {
    expect(plan.services.map((d) => d.name)).toEqual(["bridge", "cron", "scheduler", "launcher"]);
    for (const d of plan.services) {
      expect(d.oldLabel).toBe(`com.claudestra.${d.name}`);
      expect(d.newLabel).toBe(`ai.floka.${d.name}`);
      expect(d.plist).toContain(`<string>${d.newLabel}</string>`);
      expect(d.plist).toContain(`<string>/fixture/repo/src/${d.name}.ts</string>`);
      expect(d.plist).toContain("<key>KeepAlive</key>");
    }
  });
  test("[验收线 1] global barriers: prepare, unload, exit, load, health, commit", async () => {
    const f = new Fake();
    expect((await run(f)).status).toBe("committed");
    expect(effects(f)).toEqual([...group("prepare"), ...group("unload:old"), ...group("exit:old"),
      ...group("load:new"), ...group("health:new"), "commit:new"]);
    expect(f.maxLive).toBe(1);
    const count = effects(f).length;
    expect((await run(f)).status).toBe("committed");
    expect(effects(f).length).toBe(count);
  });
  test("[验收线 3] off by default and observe never touch any controller port", async () => {
    const controller = new Proxy({} as Controller, { get() { throw new Error("controller accessed"); } });
    for (const mode of [undefined, "off", "typo", "observe"]) {
      const result = await runServicePlan({ plan, controller, rename: { services: mode } });
      expect(result.status).toBe(mode === "observe" ? "observed" : "off");
    }
    expect((await runServicePlan({ plan, controller })).status).toBe("off");
  });
  test("[验收线 3] legacy autostart/web must both be proven retired", async () => {
    for (const label of plan.legacyLabels) {
      const f = new Fake();
      f.auditLegacy = async () => ({ [label]: { loaded: false, pids: [], restartDisabled: true } });
      expect((await run(f)).status).toBe("blocked");
      expect(effects(f)).toEqual([]);
    }
    const f = new Fake(); f.legacyClear = false;
    expect((await run(f)).status).toBe("blocked");
    expect(f.journal).toBeNull();
  });
  test("[验收线 2] unknown PID/registration and surviving old process stop before loading", async () => {
    for (const state of [{ loaded: null, pids: [] }, { loaded: false, pids: null }]) {
      const f = new Fake(); f.states.set("new:bridge", state);
      expect((await run(f)).status).toBe("blocked");
      expect(effects(f)).toEqual([]);
    }
    const f = new Fake(); f.stuck = "old";
    expect((await run(f)).status).toBe("blocked");
    expect(effects(f).some((e) => e.startsWith("load:"))).toBe(false);
    f.stuck = null;
    for (const d of plan.services) f.states.set(`old:${d.name}`, { loaded: false, pids: [] });
    expect((await run(f)).status).toBe("committed");
  });
  test("[验收线 2] failed health stays recoverable; rollback stops new before restoring old", async () => {
    const f = new Fake(); f.healthy = false;
    expect((await run(f)).status).toBe("blocked");
    expect(effects(f)).not.toContain("commit:new");
    f.events = []; f.healthy = true;
    expect((await run(f, "rollback")).status).toBe("rolled-back");
    expect(effects(f)).toEqual([...group("unload:new"), ...group("exit:new"), ...group("unload:old"),
      ...group("exit:old"), ...group("restore"), ...group("load:old"), ...group("health:old"), "commit:old"]);
  });
  test("[验收线 2] rollback will not restore/load old while new PID survives", async () => {
    const f = new Fake(); await run(f); f.stuck = "new"; f.events = [];
    expect((await run(f, "rollback")).status).toBe("blocked");
    expect(effects(f).some((e) => /^(restore|load):/.test(e))).toBe(false);
    f.stuck = null;
    for (const d of plan.services) f.states.set(`new:${d.name}`, { loaded: false, pids: [] });
    expect((await run(f)).status).toBe("rolled-back");
  });
});

// All journal writes and semantic effects are faulted on both sides of the durable boundary.
const faultPoints = (f: Fake) => f.events.flatMap((e, i) =>
  /^(save|prepare|unload|exit|restore|load|health|commit):/.test(e) ? [i + 1] : []);

test("[验收线 2] every forward checkpoint/effect can resume after before/after failure", async () => {
  const baseline = new Fake(); await run(baseline);
  for (const fault of faultPoints(baseline)) for (const after of [false, true]) {
    const f = new Fake(); Object.assign(f, { fault, after });
    expect((await run(f)).status).toBe("blocked");
    f.fault = -1;
    expect((await run(f)).status).toBe("committed");
    expect(f.maxLive).toBe(1);
    for (const d of plan.services) expect(f.events.filter((e) => e === `load:new:${d.name}`).length).toBeLessThanOrEqual(2);
  }
});

test("[验收线 2] every forward checkpoint/effect can instead roll back", async () => {
  const baseline = new Fake(); await run(baseline);
  for (const fault of faultPoints(baseline)) for (const after of [false, true]) {
    const f = new Fake(); Object.assign(f, { fault, after });
    await run(f); f.fault = -1;
    const result = await run(f, "rollback");
    // A failed initial write has made no service changes and has no transaction to undo.
    expect(result.status).toBe(f.journal ? "rolled-back" : "blocked");
    expect(f.maxLive).toBe(1);
  }
});

test("[验收线 2] every rollback checkpoint/effect resumes rollback, never re-enters forward", async () => {
  const baseline = new Fake(); await run(baseline);
  baseline.events = []; baseline.calls = 0;
  await run(baseline, "rollback");
  for (const fault of faultPoints(baseline)) for (const after of [false, true]) {
    const f = new Fake(); await run(f);
    f.events = []; f.calls = 0; Object.assign(f, { fault, after });
    expect((await run(f, "rollback")).status).toBe("blocked");
    f.fault = -1;
    // Before rollback intent is saved the caller must repeat its requested action.
    expect((await run(f, f.journal?.direction === "forward" ? "rollback" : "resume")).status).toBe("rolled-back");
    expect(f.maxLive).toBe(1);
    expect(effects(f).some((e) => e.startsWith("load:new:"))).toBe(false);
  }
});

test("[验收线 2] lock serializes different transaction IDs and lease loss stops effects", async () => {
  const f = new Fake();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  const prepare = f.prepare.bind(f);
  f.prepare = async (p, d) => { entered(); await gate; return prepare(p, d); };
  const pending = run(f); await started;
  expect((await runServicePlan({ plan: { ...plan, id: "other" }, controller: f, rename: { services: "on" } })).status).toBe("blocked");
  release(); expect((await pending).status).toBe("committed");
  const g = new Fake();
  const prepareG = g.prepare.bind(g);
  g.prepare = async (p, d) => { await prepareG(p, d); g.leaseValid = false; };
  expect((await run(g)).status).toBe("blocked");
  expect(effects(g)).toEqual(["prepare:bridge"]);
  g.leaseValid = true; g.prepare = prepareG;
  expect((await run(g)).status).toBe("committed");
});

test("[验收线 2] changed or corrupt journal cannot authorize service operations", async () => {
  const f = new Fake(); await run(f); f.events = [];
  const changed = { ...plan, id: "different" };
  expect((await runServicePlan({ plan: changed, controller: f, rename: { services: "on" } })).status).toBe("blocked");
  expect(effects(f)).toEqual([]);
  for (const patch of [{ cursor: -1 }, { cursor: 999 }, { status: "running" }, { version: 2 }, { direction: "typo" }]) {
    const g = new Fake(); g.journal = { ...structuredClone(f.journal!), ...patch } as Journal;
    expect((await run(g)).status).toBe("blocked");
    expect(effects(g)).toEqual([]);
  }
});

test("[验收线 2] stale exit evidence cannot authorize load after old registration returns", async () => {
  const f = new Fake();
  const save = f.saveJournal.bind(f);
  f.saveJournal = async (j) => {
    await save(j);
    if (j.direction === "forward" && j.cursor === 12) f.states.set("old:bridge", { loaded: true, pids: [] });
  };
  expect((await run(f)).status).toBe("blocked");
  expect(effects(f).some((e) => e.startsWith("load:"))).toBe(false);
});

test("[验收线 2] loaded KeepAlive with no PID is not proof of exit", async () => {
  const f = new Fake();
  f.unload = async (_p, d, side) => { f.states.set(`${side}:${d.name}`, { loaded: true, pids: [] }); };
  expect((await run(f)).status).toBe("blocked");
  expect(effects(f).some((e) => e.startsWith("load:"))).toBe(false);
});

test("[验收线 3] legacy changes between stages block subsequent mutations", async () => {
  const f = new Fake();
  const prepare = f.prepare.bind(f);
  f.prepare = async (p, d) => { await prepare(p, d); f.legacyClear = false; };
  expect((await run(f)).status).toBe("blocked");
  expect(effects(f)).toEqual(["prepare:bridge"]);
});
