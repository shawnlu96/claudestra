/**
 * i28-MT1sw merge train switch: on / observe / off per project (lib/scheduler-merge-train-switch.ts), the void on switching
 * away from on, the audited config write and `ledger scheduler-merge-train` / `merge-train-observe`. Fake GitHub, temp files only.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import {
  clearedMember, formTrain, stepTrain, trainGate, type MemberStatus, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore,
} from "../src/lib/scheduler-merge-train.js";
import { fileTrainStore, withMergeTrain } from "../src/lib/scheduler-merge-train-tick.js";
import { observeSummary, setMergeTrainMode, setTrainModeSource, TRAIN_CLOSED, trainMode } from "../src/lib/scheduler-merge-train-switch.js";
import type { MergeTrainMode } from "../src/lib/scheduler-merge-train-switch-config.js";
import type { MergeExternal } from "../src/lib/scheduler-merge-driver.js";
import type { Registry } from "../src/manager/core.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { mergeTrainSwitchCmds } from "../src/manager/ledger-merge-train-switch.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const REPO = "example/repo";
const BASE = "f".repeat(40);
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(40, "0");

/** Minimal GitHub: every call is logged; CI on a draft passes unless `pending`. */
function fakeGh() {
  const hub = { main: BASE, heads: new Map<string, string>(), files: new Map<string, string[]>(), pending: false, calls: [] as string[] };
  const gh: TrainGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => { hub.calls.push(`files:${pr.split("/").pop()}`); return hub.files.get(pr)!; },
    prHead: async (pr) => hub.heads.get(pr)!,
    createBranch: async (_r, b) => { hub.calls.push(`branch:${b}`); },
    mergeInto: async (_r, b) => { hub.calls.push(`into:${b}`); return "merged"; },
    openDraft: async (_r, b) => { hub.calls.push(`draft:${b}`); return 1000; },
    checks: async () => { hub.calls.push("checks"); return [{ name: "check", bucket: hub.pending ? "pending" : "pass" }]; },
    failLog: async () => "",
    parents: async () => [],
    mergeMatchHead: async (pr) => { hub.calls.push(`match-head:${pr.split("/").pop()}`); return newSha(); },
    closePr: async (_r, n) => { hub.calls.push(`close:${n}`); },
    deleteBranch: async (_r, b) => { hub.calls.push(`delete:${b}`); },
  };
  return { hub, gh };
}

function memStore(): TrainStore & { events: TrainEvent[]; saves: number } {
  let state: TrainState | null = null, seq = 0;
  const store = {
    events: [] as TrainEvent[], saves: 0,
    load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s: TrainState) => { store.saves++; state = structuredClone(s); seq = Math.max(seq, s.seq); },
    event: (_p: string, ev: TrainEvent) => { store.events.push(ev); }, nextSeq: () => seq + 1,
  };
  return store;
}

function setup(project: string, n = 3, store: TrainStore & { events: TrainEvent[]; saves: number } = memStore()) {
  const f = fakeGh();
  const cards = Array.from({ length: n }, (_, i) => {
    const prRef = `https://github.com/${REPO}/pull/${i + 1}`, head = newSha();
    f.hub.heads.set(prRef, head); f.hub.files.set(prRef, [`src/f${i}.ts`]);
    return { taskId: `T${i + 1}`, prRef, head };
  });
  const status = new Map<string, MemberStatus>();
  const deps: TrainDeps = { gh: f.gh, store, now: () => 1_000, requiredChecks: ["check"],
    memberStatus: (id) => status.get(id) ?? { kind: "waiting" }, notify: async () => {} };
  const tick = async () => {
    const live = store.load(project);
    return live && live.phase !== "done" ? stepTrain(live, deps) : formTrain(project, cards, deps);
  };
  const run = (i: number): MergeRun => ({ intentId: `m-${i}`, taskId: cards[i]!.taskId, project, prRef: cards[i]!.prRef, expectedBranch: `task/T${i + 1}`,
    reviewedHead: cards[i]!.head, requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 });
  return { ...f, cards, status, deps, store, tick, run };
}

let modes: Record<string, MergeTrainMode> = {};
beforeEach(() => { modes = {}; setTrainModeSource((p) => modes[p] ?? "on"); });
afterEach(() => setTrainModeSource(null));

describe("off: as before MT1", () => {
  test("no train, no GitHub call, no state, no event; the serial merge never consults a train", async () => {
    modes.off1 = "off";
    const env = setup("off1");
    for (let i = 0; i < 3; i++) expect(await env.tick()).toBeNull();
    expect(env.hub.calls).toEqual([]);
    expect([env.store.saves, env.store.events]).toEqual([0, []]);
    expect(await trainGate(env.store.load("off1"), env.run(0), { ...env.deps })).toBeNull();
    const merged: string[] = [];
    const base = { merge: async (pr: string) => { merged.push(pr); return "sha"; } } as unknown as MergeExternal;
    const ext = withMergeTrain(base, { gh: env.gh, store: env.store });
    expect(await ext.train!(env.run(0))).toBeNull();
    await ext.merge(env.cards[0]!.prRef, env.cards[0]!.head);
    expect([merged, env.hub.calls]).toEqual([[env.cards[0]!.prRef], []]); // the plain serial merge, no match-head override
  });
});

describe("observe: only counts", () => {
  test("one observe event per distinct batch with members and saved CI; no branch, no CI, no state, serial never waits", async () => {
    modes.obs1 = "observe";
    const env = setup("obs1");
    expect(await env.tick()).toBeNull();
    expect(await env.tick()).toBeNull(); // same batch next pass: still one observation
    expect(env.hub.calls.filter((c) => !c.startsWith("files:"))).toEqual([]);
    expect(env.store.saves).toBe(0);
    expect(env.store.events).toHaveLength(1);
    const ev = env.store.events[0]!;
    expect(ev.kind).toBe("observe");
    expect(ev.data).toMatchObject({ ciTrain: 1, ciSerial: 3, savedCi: 2, members: env.cards.map((c) => ({ taskId: c.taskId, head: c.head, files: 1 })) });
    expect(ev.text).toContain("预计省 CI 2 次");
    expect(await trainGate(env.store.load("obs1"), env.run(0), env.deps)).toBeNull();
    env.cards.pop(); // the batch changed → a new observation
    expect(await env.tick()).toBeNull();
    expect(env.store.events.map((e) => (e.data as { savedCi: number }).savedCi)).toEqual([2, 1]);
  });

  test("events land in the train file and merge-train-observe sums the last N", async () => {
    modes.obs2 = "observe";
    const dir = mkdtempSync(join(tmpdir(), "mt-switch-obs-"));
    const store = fileTrainStore(dir);
    const env = setup("obs2", 4, Object.assign(store, { events: [] as TrainEvent[], saves: 0 }));
    await env.tick();
    env.cards.pop();
    await env.tick();
    expect(observeSummary("obs2", 20, dir)).toMatchObject({ project: "obs2", count: 2, members: 7, savedCi: 5 });
    expect(observeSummary("obs2", 1, dir)).toMatchObject({ count: 1, members: 3, savedCi: 2, recent: [{ members: ["T1", "T2", "T3"], savedCi: 2 }] });
    expect(observeSummary("nothing", 20, dir)).toMatchObject({ count: 0, savedCi: 0, recent: [] });
    expect(store.load("obs2")).toBeNull(); // no train state was written
    const spec = mergeTrainSwitchCmds(join(dir, "none.json"), dir)["merge-train-observe"]!;
    const p = parseLedgerArgs(["merge-train-observe", "obs2", "--last", "5"], spec.valued, spec.bools);
    if ("error" in p) throw new Error(p.error);
    expect(await spec.run(new LedgerCli({ db: null as unknown as Database, actor: "unknown", projectIds: [], now: () => 1,
      loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} }, p))).toMatchObject({ ok: true, count: 2, savedCi: 5 });
  });
});

describe("switching away from on voids a live train", () => {
  for (const to of ["off", "observe"] as const) {
    test(`testing → ${to}: void with「${TRAIN_CLOSED}」, PR closed, branch deleted, members go serial`, async () => {
      const project = `t-${to}`;
      const env = setup(project);
      env.hub.pending = true;
      const formed = await env.tick();
      expect(formed!.phase).toBe("testing");
      await env.tick(); // assemble + open draft
      expect(await trainGate(env.store.load(project), env.run(0), env.deps)).toBe("wait");
      modes[project] = to;
      const s = (await env.tick())!;
      expect([s.phase, s.outcome, s.reason]).toEqual(["done", "void", TRAIN_CLOSED]);
      expect(env.hub.calls).toContain("close:1000");
      expect(env.hub.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(1);
      expect(env.store.events.some((e) => e.kind === "void" && e.text.includes(TRAIN_CLOSED))).toBe(true);
      expect(await trainGate(env.store.load(project), env.run(0), env.deps)).toBeNull();
      const before = env.hub.calls.length;
      await env.tick(); // next pass: no new train
      expect(env.hub.calls.slice(before).filter((c) => !c.startsWith("files:"))).toEqual([]);
    });
  }

  test("settling → off: void, verified members lose the match-head override, gate answers serial", async () => {
    const env = setup("set1");
    let s: TrainState | null = null;
    for (let i = 0; i < 5 && s?.phase !== "settling"; i++) s = await env.tick();
    expect(s!.phase).toBe("settling");
    expect(clearedMember(env.store.all(), env.cards[0]!.prRef, env.cards[0]!.head)).not.toBeNull();
    modes.set1 = "off";
    expect(await trainGate(env.store.load("set1"), env.run(0), env.deps)).toBeNull(); // before the next tick already
    expect(clearedMember(env.store.all(), env.cards[0]!.prRef, env.cards[0]!.head)).toBeNull();
    s = await env.tick();
    expect([s!.phase, s!.outcome, s!.reason]).toEqual(["done", "void", TRAIN_CLOSED]);
  });
});

describe("default = on", () => {
  test("no mode written: trainMode is on and a train forms as before", async () => {
    setTrainModeSource(null);
    const dir = mkdtempSync(join(tmpdir(), "mt-switch-def-"));
    expect(trainMode("p", join(dir, "missing.json"))).toBe("on");
    const cfg = join(dir, "scheduler.json");
    writeFileSync(cfg, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["c"], repoDir: "/r/p" } } }));
    expect(trainMode("p", cfg)).toBe("on");
    expect(trainMode("p")).toBe("on"); // the test state dir has no scheduler.json
    const env = setup("def1");
    expect((await env.tick())?.phase).toBe("testing");
  });

  test("config parse: on / observe / off kept, anything else is a config error", () => {
    const cfg = (mergeTrain: unknown) => ({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["c"], repoDir: "/r/p", mergeTrain } } });
    for (const m of ["on", "observe", "off"]) expect(parseSchedulerConfig(cfg(m)).projects.p!.mergeTrain).toBe(m as MergeTrainMode);
    expect(parseSchedulerConfig(cfg(undefined)).projects.p!.mergeTrain).toBeUndefined();
    expect(() => parseSchedulerConfig(cfg("ON"))).toThrow(/mergeTrain/);
  });
});

describe("ledger scheduler-merge-train: audited write, PM / master / owner only", () => {
  const PM_A = "agent-pm-a", PM_B = "agent-pm-b", DISP = "agent-helper";
  let db: Database, path: string;
  const CFG = { enabled: true, pollMs: 6000, projects: {
    a: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/r/a" }, b: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/r/b" } } };
  const deps = (actor: string): LedgerDeps => ({ db, actor, projectIds: ["a", "b"], now: () => 9_000,
    loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} });
  async function run(actor: string, ...args: string[]): Promise<Record<string, any>> {
    const spec = mergeTrainSwitchCmds(path)["scheduler-merge-train"]!;
    const p = parseLedgerArgs(["scheduler-merge-train", ...args], spec.valued, spec.bools);
    if ("error" in p) return { ok: false, code: "invalid", error: p.error };
    try { return await spec.run(new LedgerCli(deps(actor), p)); }
    catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
  }
  const file = () => ({ bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs });
  const decisions = () => listEvents(db, {}).filter((e) => e.kind === "decision");

  beforeEach(() => {
    setTrainModeSource(null);
    path = join(mkdtempSync(join(tmpdir(), "mt-switch-cli-")), "scheduler.json");
    writeFileSync(path, JSON.stringify(CFG, null, 2) + "\n");
    db = openLedger(tempLedgerPath("mt-switch-db-"));
    const owner = { actor: "owner", now: 1 };
    setMeta(db, owner, { project: "a", key: "pms", value: [PM_A, DISP] });
    setMeta(db, owner, { project: "a", key: "team", value: { dispatcher: DISP, audit: true } });
    setMeta(db, owner, { project: "b", key: "pms", value: [PM_B] });
  });

  test("PM switches: file changes, decision event carries op / from / to / reason, the scheduler reads the new mode", async () => {
    const r = await run(PM_A, "a", "observe", "--reason", "先只算不动手");
    expect(r).toMatchObject({ ok: true, project: "a", mode: "observe", from: "on", changed: true, event: decisions()[0]!.seq });
    expect(JSON.parse(readFileSync(path, "utf8")).projects.a.mergeTrain).toBe("observe");
    expect(trainMode("a", path)).toBe("observe");
    expect(trainMode("b", path)).toBe("on");
    expect(decisions().map((e) => [e.actor, e.project, e.text, e.data])).toEqual([
      [PM_A, "a", "先只算不动手", { op: "scheduler_merge_train", from: null, to: "observe" }]]);
    expect(await run("master", "a", "off", "--reason", "关掉")).toMatchObject({ ok: true, from: "observe", changed: true });
    expect(await run("owner", "a", "off", "--reason", "再来")).toMatchObject({ ok: true, changed: false, event: null });
    expect(await run("owner", "b", "on", "--reason", "缺省就是 on")).toMatchObject({ ok: true, changed: false, event: null });
    expect(decisions()).toHaveLength(2);
  });

  test("executor, dispatcher, other project's PM, unknown are refused; file untouched, no event", async () => {
    for (const actor of ["agent-task-i28-x", DISP, PM_B, "unknown"]) {
      const before = file();
      expect([actor, (await run(actor, "a", "off", "--reason", "r")).code]).toEqual([actor, "forbidden"]);
      expect(file()).toEqual(before);
    }
    expect(decisions()).toEqual([]);
  });

  test("bad arguments → invalid, file untouched", async () => {
    const before = file();
    for (const args of [["a", "--reason", "r"], ["a", "ON", "--reason", "r"], ["a", "pause", "--reason", "r"], ["a", "off"], ["a", "off", "x", "--reason", "r"]]) {
      expect([args, (await run(PM_A, ...args)).code]).toEqual([args, "invalid"]);
    }
    expect(file()).toEqual(before);
    await expect(setMergeTrainMode(db, { actor: PM_A, now: 1 }, { project: "zz", mode: "off", reason: "r" }, { path })).rejects.toMatchObject({ code: "forbidden" });
  });
});
