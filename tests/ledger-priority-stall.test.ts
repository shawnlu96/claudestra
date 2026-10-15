import type { StallClaim } from "../src/lib/ledger-priority-stall-store.js";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, openLedger, listEvents } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { setPriority, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import { openAsk, listAsks } from "../src/lib/ledger-asks.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { priorityStallBases } from "../src/lib/ledger-priority-stall-read.js";
import { claimPriorityStalls, finishPriorityStall, priorityStallOwner, setPriorityStallThreshold,
  priorityStallRevision } from "../src/lib/ledger-priority-stall-store.js";
import { isPriorityStallProgress, PRIORITY_STALL_MS as W, stallNotice } from "../src/lib/ledger-priority-stall.js";
import { priorityStallCommand } from "../src/lib/ledger-priority-stall-command.js";
import { priorityStallTick } from "../src/lib/ledger-priority-stall-tick.js";
import { runLedger } from "../src/manager/ledger.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";

let db: Database;
const project = "prio", pm = "agent-pm", t0 = 1000;
const evidence = { ownerWords: "现在做", ownerAt: t0, sourceRef: "test:owner" };
const ctx = (now = t0) => ({ actor: "scheduler", now });
function mode(value: "off" | "observe" | "on", rev = 0, now = t0) {
  return setPriorityMode(db, { actor: pm, project, now, dedupKey: crypto.randomUUID() },
    { mechanism: "priorityStall", mode: value, rev, evidence });
}
function band(value: "now" | "next" | "later", rev = 0, now = t0) {
  setPriority(db, { actor: pm, project, now, dedupKey: crypto.randomUUID() },
    { target: { kind: "task", id: "T" }, band: value, rev, evidence });
}
const claim = (now: number) => claimPriorityStalls(db, ctx(now), project)[0];
function finish(c: StallClaim, now: number, result: "success" | "failed" | "unknown" | "unavailable" = "success") {
  return finishPriorityStall(db, ctx(now), project, c.basis.key, c.token, result, "test result");
}
beforeEach(() => {
  db = openLedger(":memory:");
  db.query("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner", now: t0 }, { project, key: "pms", value: [pm] });
  createTask(db, { actor: pm, now: t0 }, { project, id: "T", kind: "code", title: "task", pm });
  band("now"); mode("on");
});
afterEach(() => closeLedger(":memory:"));

test("virtual clock: 30m heal, one window PM, another window owner; repeated ticks do nothing", () => {
  expect(claim(t0 + W - 1)).toBeUndefined();
  const heal = claim(t0 + W);
  expect(heal.action).toBe("heal");
  expect(claim(t0 + W)).toBeUndefined();
  finish(heal, t0 + W);
  expect(claim(t0 + 2 * W - 1)).toBeUndefined();
  const notify = claim(t0 + 2 * W);
  expect(notify.action).toBe("pm"); finish(notify, t0 + 2 * W);
  const owner = claim(t0 + 3 * W);
  expect(owner.action).toBe("owner");
  expect(priorityStallOwner(db, ctx(t0 + 3 * W), project, owner.basis.key, owner.token)).toMatch(/^ask_/);
  expect(claim(t0 + 10 * W)).toBeUndefined();
  expect(listAsks(db, { project })).toHaveLength(1);
});

test("notes, asks, observations, recovery attempts and repeated heartbeat never renew the clock", () => {
  for (const [kind, data] of [["note", {}], ["ask", {}], ["scheduler", { op: "heartbeat" }],
    ["scheduler", { op: "recovery_observe" }], ["note", { op: "owner_resolved" }]] as const) {
    expect(isPriorityStallProgress({ kind, data })).toBe(false);
  }
  appendEvent(db, { actor: pm, now: t0 + W - 1 }, { project, target: "T", kind: "note", text: "still waiting" });
  const ask = openAsk(db, { project, taskId: "T", source: "reply", kind: "decide", title: "question", body: "Which scope?\nDetails", assignee: pm,
    extra: { via: "mcp_ask" } }, t0 + W - 1);
  const c = claim(t0 + W);
  expect(c.basis.why).toBe(`等 PM 答 ask ${ask.id}`);
  finish(c, t0 + W, "unavailable");
  const pmClaim = claim(t0 + W);
  expect(pmClaim.action).toBe("pm");
  expect(stallNotice(pmClaim.basis, pmClaim.cycle, t0 + W).split("\n")[0]).toBe(`等 PM 答 ask ${ask.id}：Which scope?`);
});

test("real execution results end the cycle; changing a title does not", () => {
  const old = claim(t0 + W); finish(old, t0 + W);
  setTask(db, { actor: pm, now: t0 + W + 10 }, { id: "T", rev: 1, patch: { title: "new title" } });
  expect(claim(t0 + 2 * W)?.action).toBe("pm");
  // A genuine delivery result comes through the ledger's sanctioned append interface.
  appendEvent(db, { actor: pm, now: t0 + 2 * W + 10 }, { project, target: "T", kind: "deploy", data: { result: "success" } });
  expect(claim(t0 + 3 * W)).toBeUndefined();
  expect(claim(t0 + 3 * W + 10)?.action).toBe("heal");
  expect(finish(old, t0 + 4 * W)).toBe(false);
});

test("lower and raise between ticks starts a new cycle; title and note cannot reset it", () => {
  const old = claim(t0 + W); finish(old, t0 + W);
  band("later", 1, t0 + W + 1); band("now", 2, t0 + W + 2);
  expect(claim(t0 + 2 * W)).toBeUndefined();
  const next = claim(t0 + 2 * W + 2);
  expect(next.action).toBe("heal"); expect(next.cycle.id).not.toBe(old.cycle.id);
});

test("interrupted heal is unknown and never executed again after restart", () => {
  const heal = claim(t0 + W);
  expect(claim(t0 + W + 1)).toBeUndefined();
  const next = claim(t0 + W + 5 * 60_000);
  expect(next.action).toBe("pm"); expect(next.cycle.heal?.result).toBe("unknown");
  expect(finish(heal, t0 + 2 * W)).toBe(false);
});

test("PM retries are bounded; a success stops retries; failure details reach owner", () => {
  const heal = claim(t0 + W); finish(heal, t0 + W, "failed");
  for (let i = 0; i < 3; i++) {
    const c = claim(t0 + W + i * 60_000);
    expect(c.action).toBe("pm"); finish(c, t0 + W + i * 60_000, "failed");
  }
  expect(claim(t0 + W + 3 * 60_000)).toBeUndefined();
  const owner = claim(t0 + 2 * W + 2 * 60_000);
  expect(owner.action).toBe("owner");
  expect(stallNotice(owner.basis, owner.cycle, t0 + 3 * W)).toContain("PM 通知：failed");
});

test("owner todo already open for this target is associated in a later cycle", () => {
  function escalate(at: number) {
    finish(claim(at), at, "unavailable"); finish(claim(at), at);
    const owner = claim(at + W);
    return priorityStallOwner(db, ctx(at + W), project, owner.basis.key, owner.token);
  }
  const first = escalate(t0 + W);
  band("later", 1, t0 + 2 * W + 1); band("now", 2, t0 + 2 * W + 2);
  const second = escalate(t0 + 3 * W + 2);
  expect(first).toBe(second); expect(listAsks(db, { project })).toHaveLength(1);
});

test("observe and on episodes stay separate; off is inert", () => {
  mode("observe", 1);
  const observed = claim(t0 + W); expect(observed.mode).toBe("observe"); finish(observed, t0 + W);
  mode("on", 2, t0 + W + 1);
  const actual = claim(t0 + W + 1); expect(actual.action).toBe("heal");
  expect(actual.cycle.id).not.toBe(observed.cycle.id);
  mode("off", 3);
  const n = listEvents(db).length;
  expect(claim(t0 + 10 * W)).toBeUndefined();
  expect(listEvents(db)).toHaveLength(n); expect(listAsks(db, { project })).toHaveLength(0);
});

test("unbound planned nodes inherit now and are monitored with precise dependency blockers", () => {
  createFeature(db, { actor: pm, now: t0 }, { project, slug: "work", title: "work" });
  initDag(db, { actor: pm, now: t0 }, { id: "ab12-work", rev: 1, nodes: [
    { key: "a", oneLine: "a", fileGlobs: ["src/a.ts"] }, { key: "b", oneLine: "b", deps: ["a"], fileGlobs: ["src/b.ts"] },
  ] });
  setPriority(db, { actor: pm, project, now: t0, dedupKey: "feature" },
    { target: { kind: "feature", id: "ab12-work" }, band: "now", rev: 0, evidence });
  const bases = priorityStallBases(db, project).filter((b) => b.taskId === null);
  expect(bases).toHaveLength(2);
  expect(bases.some((b) => b.why.includes("依赖没满足"))).toBe(true);
  expect(claimPriorityStalls(db, ctx(t0 + W), project)).toHaveLength(3);
});

test("threshold requires owner, validates bounds and records the change", () => {
  for (const actor of ["worker", pm, "master"]) {
    const count = listEvents(db).length;
    expect(() => setPriorityStallThreshold(db, { actor }, project, 1000, "change")).toThrow("owner");
    expect(listEvents(db)).toHaveLength(count);
  }
  expect(() => setPriorityStallThreshold(db, { actor: "owner" }, project, 0, "change")).toThrow("门槛");
  setPriorityStallThreshold(db, { actor: "owner" }, project, 1000, "owner wants 1s");
  expect(listEvents(db).at(-1)?.data).toMatchObject({ namespace: "priority-stall", op: "threshold", before: W, after: 1000 });
  expect(claim(t0 + 1000).action).toBe("heal");
});

test("CLI writer: identical request replays; rev CAS and changed dedup payload reject", () => {
  const b = priorityStallBases(db, project)[0], input = { op: "claim" as const, key: b.key };
  const service = { autoDispatch: true, projects: [project], maxWorkers: () => 3 };
  const c = { ...ctx(t0 + W), dedupKey: "claim" };
  const r = priorityStallCommand(db, c, project, "T", input, service, 0);
  expect(priorityStallCommand(db, c, project, "T", input, service, 0)).toEqual(r);
  expect(() => priorityStallCommand(db, { ...c, dedupKey: "other" }, project, "T", input, service, 0)).toThrow("版本");
  expect(() => priorityStallCommand(db, c, project, "T", { ...input, op: "owner" }, service)).toThrow("去重键");
  expect(priorityStallRevision(db, project, b.key)).toBeGreaterThan(0);
});

test("isolated scheduler tick uses real CLI writer; observe emits zero notices/asks, on follows heal→PM→owner", async () => {
  let now = t0 + W, notices = 0;
  const config = { enabled: true, autoDispatch: true, projects: { [project]: { maxActiveWorkers: 3 } } } as unknown as SchedulerConfig;
  const manager = async (...args: string[]) => runLedger(args.slice(1), { db, actor: "scheduler", projectIds: [project], now: () => now,
    autoDispatch: () => true, autoProjects: () => [project], loadRegistry: async () => ({ agents: {}, socket: "" }), saveRegistry: async () => {} });
  const ports = { manager, active: () => {}, now: () => now, notify: async () => { notices++; } };
  mode("observe", 1);
  expect(await priorityStallTick(db, config, ports)).toEqual([]);
  now += W; expect(await priorityStallTick(db, config, ports)).toEqual([]);
  now += W; expect(await priorityStallTick(db, config, ports)).toEqual([]);
  expect(notices).toBe(0); expect(listAsks(db, { project })).toHaveLength(0);
  mode("on", 2, now);
  expect(await priorityStallTick(db, config, ports)).toEqual([]);
  expect(notices).toBe(1);
  expect(await priorityStallTick(db, config, ports)).toEqual([]);
  expect(notices).toBe(1);
  now += W;
  expect(await priorityStallTick(db, config, ports)).toEqual([]);
  expect(listAsks(db, { project })).toHaveLength(1);
});

test("only actual dependency release advances an unbound node's clock", async () => {
  const { moveStage } = await import("../src/lib/ledger-write.js");
  createTask(db, { actor: pm, now: t0 }, { project, id: "U", title: "upstream", kind: "investigate" });
  createFeature(db, { actor: pm, now: t0 }, { project, slug: "deps", title: "deps" });
  initDag(db, { actor: pm, now: t0 }, { id: "ab12-deps", rev: 1, nodes: [
    { key: "up", taskId: "U" }, { key: "wait", oneLine: "wait", deps: ["up"], fileGlobs: ["src/wait.ts"] },
  ] });
  setPriority(db, { actor: pm, project, now: t0, dedupKey: "deps-now" },
    { target: { kind: "feature", id: "ab12-deps" }, band: "now", rev: 0, evidence });
  moveStage(db, { actor: pm, now: t0 + W - 2 }, { taskId: "U", from: "spec", to: "restate" });
  moveStage(db, { actor: pm, now: t0 + W - 1 }, { taskId: "U", from: "restate", to: "build" });
  const waiting = () => priorityStallBases(db, project).find((b) => b.featureId === "ab12-deps" && !b.taskId)!;
  expect(waiting().since).toBe(t0);
  moveStage(db, { actor: pm, now: t0 + W }, { taskId: "U", from: "build", to: "review" });
  moveStage(db, { actor: pm, now: t0 + W + 1 }, { taskId: "U", from: "review", to: "done" });
  expect(waiting().since).toBe(t0 + W + 1);
  expect(waiting().why).not.toContain("依赖没满足");
});

test("mode toggles preserve actual episode attempts instead of authorizing a second heal", () => {
  const first = claim(t0 + W); finish(first, t0 + W);
  mode("off", 1, t0 + W + 1); mode("observe", 2, t0 + W + 2); mode("on", 3, t0 + W + 3);
  expect(claim(t0 + W + 3)).toBeUndefined();
  const next = claim(t0 + 2 * W);
  expect(next.action).toBe("pm"); expect(next.cycle.id).toBe(first.cycle.id);
});
