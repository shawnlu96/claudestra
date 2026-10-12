/**
 * dispatch-recovery-TRAINHANG2: a voided merge train keeps the serial / bounced verdicts it already reached (trainCiTimeout on),
 * so the next train does not regroup the same failure. Synthetic train states and a fake GitHub only; no real state dir.
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { formTrain, nextSkip, stepTrain, type TrainCar, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import { configuredVoidSkip, VOID_SKIP_CAR, VOID_SKIP_NOTE_KEYS, voidHeldKeys, voidSkipMode, voidSkipNote } from "../src/lib/scheduler-merge-train-skip.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";
import { trainCiTimeoutPort, type TrainCiTimeoutPort } from "../src/lib/train-ci-timeout.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const pr = (n: number) => `https://github.com/example/repo/pull/${n}`;
const card = (n: number) => ({ taskId: `T${n}`, prRef: pr(n), head: sha(n) });
const A = card(1), B = card(2), C = card(3), D = card(4);
const key = (c: { taskId: string; head: string }) => `${c.taskId}:${c.head}`;

/** The nextSkip before this card, verbatim, for the off comparison. */
function legacy(prev: TrainState | null): string[] {
  if (!prev) return [];
  const m = (id: string) => prev.members.find((x) => x.taskId === id)!;
  const own = prev.outcome === "void" ? [] : [...prev.serial.map((id) => m(id)), ...prev.bounced].map((c) => `${c.taskId}:${c.head.toLowerCase()}`);
  return [...new Set([...(prev.skip ?? []), ...own])];
}

/** Last train: A kicked out for a merge conflict (serial), B pinned and bounced, C cleared; then voided by the hold limit. */
function prevTrain(outcome: TrainState["outcome"] = "void", phase: TrainState["phase"] = "done"): TrainState {
  return { v: 1, id: "3m-qf075", seq: 130, project: "p", repo: "example/repo", base: sha(99), phase, outcome,
    reason: outcome === "void" ? "列车超时：逐张合并超过 60 分钟仍未结束，放行串行合并 PR1176" : null,
    members: [A, B, C, D].map((c) => ({ ...c, files: [`f${c.taskId}`] })),
    cars: [{ id: "3m-qf075", level: 0, parent: null, members: ["T2", "T3", "T4"], branch: "train/3m-qf075", created: true, assembled: [],
      pr: 1000, status: "split", startedAt: 0 }],
    cleared: ["T3"], merged: [], bounced: [{ taskId: "T2", head: B.head, receipt: "r" }], serial: ["T1"], dropped: [], ciRuns: 3,
    startedAt: 0, updatedAt: 0, skip: [key(D)] };
}

beforeEach(() => setTrainModeSource(() => "on"));
afterEach(() => setTrainModeSource(null));

describe("nextSkip on a synthetic void", () => {
  test("[验收线 1] on: the void hands on A (serial) and B (bounced) at their heads; the old rule dropped them", () => {
    const prev = prevTrain();
    expect(legacy(prev)).toEqual([key(D)]); // red before this card: neither A nor B
    expect(nextSkip(prev, "on").sort()).toEqual([key(A), key(B), key(D)].sort());
    expect(nextSkip({ ...prev, voidSkip: "on" }).sort()).toEqual([key(A), key(B), key(D)].sort()); // the mode the cleanup saved
    expect(nextSkip(prev, "on")).not.toContain(key(C)); // a cleared member regroups
  });

  test("[验收线 2] on: A at a new head boards the next train", async () => {
    const prev = prevTrain(), moved = { ...A, head: sha(0xa1) }, env = deps();
    const next = await formTrain("p", [moved, B, C], env.deps, async (c) => [c.taskId], nextSkip(prev, "on"));
    expect(next!.members.map((m) => key(m))).toEqual([key(moved), key(C)]);
    expect(next!.skip).toEqual([key(B)]);
  });

  test("[验收线 3] off / observe and no saved mode: verbatim the old nextSkip (a void hands on nothing of its own)", () => {
    const prev = prevTrain();
    for (const p of [prev, { ...prev, voidSkip: "observe" as RecoveryMode }, { ...prev, voidSkip: "off" as RecoveryMode }]) {
      expect(nextSkip(p)).toEqual(legacy(p));
      expect(nextSkip(p, "off")).toEqual(legacy(p));
      expect(nextSkip(p, "observe")).toEqual(legacy(p));
    }
    expect(nextSkip(null, "on")).toEqual([]);
  });

  test("[验收线 5] merged / serial outcomes: the same as before in all three modes", () => {
    for (const outcome of ["merged", "serial"] as const) {
      const prev = prevTrain(outcome);
      for (const mode of ["off", "observe", "on"] as const) expect(nextSkip(prev, mode)).toEqual(legacy(prev));
      expect(legacy(prev).sort()).toEqual([key(A), key(B), key(D)].sort());
    }
    expect(voidHeldKeys(prevTrain("merged"))).toEqual([]);
  });

  test("[验收线 4] an unreadable key or a broken policy reads as off", () => {
    expect(voidSkipMode(() => { throw new Error("policy file broken"); })).toBe("off");
    expect(voidSkipMode(() => "maybe" as RecoveryMode)).toBe("off");
    expect(voidSkipMode(() => undefined as unknown as RecoveryMode)).toBe("off");
    expect(voidSkipMode(() => "on")).toBe("on");
  });
});

function memStore(): TrainStore & { events: TrainEvent[]; saved: TrainState[] } {
  let state: TrainState | null = null;
  const events: TrainEvent[] = [], saved: TrainState[] = [];
  return { events, saved, load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); saved.push(state); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => 200 };
}

type Mode = RecoveryMode | (() => RecoveryMode);

/**
 * A fake GitHub with the Actions methods (nothing running), a trainCiTimeout port answering `mode` (a function may throw) whose
 * observe dedups per actionKey like recordObserved, and the policy file's own mode (`config`, default: what `mode` names, else on).
 */
function deps(mode?: Mode, config?: (project: string) => RecoveryMode) {
  const store = memStore(), calls: string[] = [], observed = new Map<string, { car: TrainCar; action: string }>();
  const gh: TrainGh = {
    mainHead: async () => sha(99), prFiles: async (p) => [`f${p}`], prHead: async () => sha(1),
    createBranch: async () => {}, mergeInto: async () => "merged", openDraft: async () => 1, checks: async () => [], failLog: async () => "",
    parents: async () => [], mergeMatchHead: async () => sha(5), closePr: async (_r, n) => { calls.push(`close:${n}`); },
    deleteBranch: async (_r, b) => { calls.push(`delete:${b}`); },
    branchRuns: async () => [], runJobs: async () => [], cancelRun: async () => "finished", jobLog: async () => ({ text: "", truncated: false }),
    runStatus: async () => "completed",
  };
  const port: TrainCiTimeoutPort = { mode: () => (typeof mode === "function" ? mode() : mode!),
    observe: (s, car, action) => { const k = `train-timeout:${s.id}:${car.id}`; if (!observed.has(k)) observed.set(k, { car, action }); } };
  const d: TrainDeps = { gh, store, now: () => 5_000, requiredChecks: ["check"], memberStatus: () => ({ kind: "waiting" }),
    notify: async () => {}, ...(mode ? { ciTimeout: port } : {}), voidSkipConfig: config ?? (() => (typeof mode === "string" ? mode : "on")) };
  return { deps: d, store, calls, observed };
}

/** Run the voided train's cleanup to done; the state a later tick hands to nextSkip, and the void-skip observations recorded. */
async function cleanup(mode?: Mode, config?: (project: string) => RecoveryMode) {
  const env = deps(mode, config), s = prevTrain("void", "cleanup");
  let cur = s;
  for (let i = 0; i < 10 && cur.phase !== "done"; i++) cur = await stepTrain(env.store.load("p") ?? cur, env.deps);
  return { env, s: env.store.load("p")!, observes: [...env.observed.values()] };
}

/** A temp recovery-policy.json, read through the real recoveryPolicy port and the real configuredVoidSkip. */
function policyFile(body: string | null) {
  const path = join(mkdtempSync(join(tmpdir(), "train-skip-")), "recovery-policy.json");
  if (body !== null) writeFileSync(path, body);
  const port = trainCiTimeoutPort({} as Database, () => 0, (p, k) => recoveryPolicy(p, k, path));
  return { mode: () => port.mode("p"), config: (p: string) => configuredVoidSkip(p, undefined, path) };
}

describe("a void's cleanup saves the mode nextSkip reads", () => {
  test("[验收线 1] on: the cleanup saves on, the tick's plain nextSkip(live) holds A and B back", async () => {
    const { s, observes } = await cleanup("on");
    expect(s.voidSkip).toBe("on");
    expect(nextSkip(s).sort()).toEqual([key(A), key(B), key(D)].sort());
    expect(observes).toEqual([]);
  });

  test("[验收线 3] off: nothing written beyond the old cleanup, the same skip as before", async () => {
    for (const mode of [undefined, "off"] as const) {
      const { s, observes } = await cleanup(mode);
      expect(s.voidSkip).toBeUndefined();
      expect(nextSkip(s)).toEqual(legacy(s));
      expect(nextSkip(s)).toEqual([key(D)]);
      expect(observes).toEqual([]);
    }
  });

  test("[验收线 3] observe: the skip stays off's, one deduped observation naming what on would also skip", async () => {
    const { env, s, observes } = await cleanup("observe");
    expect(nextSkip(s)).toEqual(legacy(s));
    expect(s.voidSkip).toBe("observe");
    expect(observes).toHaveLength(1);
    expect(observes[0]!.car).toMatchObject({ id: VOID_SKIP_CAR, members: [key(A), key(B)] });
    expect([...env.observed.keys()]).toEqual(["train-timeout:3m-qf075:void-skip"]);
    // a rerun of the same void's cleanup (a crash before done) never records it again
    const again = structuredClone(s);
    again.phase = "cleanup";
    await stepTrain(again, env.deps);
    expect(env.observed.size).toBe(1);
  });

  test("[验收线 3] observe: a failed observation write leaves no mark; the next tick records it, once", async () => {
    const env = deps("observe"), observe = env.deps.ciTimeout!.observe;
    let fail = true;
    env.deps.ciTimeout!.observe = (...a) => { if (fail) { fail = false; throw new Error("ledger write failed"); } observe(...a); };
    const s = prevTrain("void", "cleanup");
    env.store.save(s);
    await expect(stepTrain(env.store.load("p")!, env.deps)).rejects.toThrow("ledger write failed");
    expect(env.store.load("p")).toMatchObject({ phase: "cleanup" });
    expect(env.store.load("p")!.voidSkip).toBeUndefined();
    expect(env.observed.size).toBe(0);
    await stepTrain(env.store.load("p")!, env.deps);
    expect(env.store.load("p")).toMatchObject({ phase: "done", voidSkip: "observe" });
    expect(env.observed.size).toBe(1);
    // recorded, then a crash before the mark was saved: the rerun records again and the per-train dedup keeps it one
    const crashed = structuredClone(env.store.load("p")!);
    crashed.phase = "cleanup"; delete crashed.voidSkip;
    await stepTrain(crashed, env.deps);
    expect(env.observed.size).toBe(1);
  });

  test("[验收线 3] observe with nothing more to skip: no observation, nothing written", async () => {
    const env = deps("observe"), s = prevTrain("void", "cleanup");
    s.serial = []; s.bounced = [];
    await stepTrain(s, env.deps);
    expect(env.observed.size).toBe(0);
    expect(env.store.load("p")!.voidSkip).toBeUndefined();
  });

  test("[验收线 4] no policy file, no project entry or no trainCiTimeout key: off, though recoveryPolicy answers observe", async () => {
    for (const body of [null, JSON.stringify({ projects: {} }), JSON.stringify({ projects: { p: { keys: {} } } }),
      JSON.stringify({ projects: { p: { keys: { askReminder: "on" } } } })]) {
      const f = policyFile(body);
      expect(f.mode()).toBe("observe"); // the default: the port alone would observe
      expect(f.config("p")).toBe("off");
      const { s, observes } = await cleanup(f.mode, f.config);
      expect([s.voidSkip, nextSkip(s), observes]).toEqual([undefined, legacy(s), []]);
      expect(nextSkip(s)).toEqual([key(D)]);
    }
  });

  test("[验收线 4] the key or the project's mode named in the file is the mode", async () => {
    for (const [body, want] of [[{ p: { keys: { trainCiTimeout: "on" } } }, "on"], [{ p: { keys: { trainCiTimeout: "observe" } } }, "observe"],
      [{ p: { mode: "on" } }, "on"], [{ p: { mode: "on", keys: { trainCiTimeout: "off" } } }, "off"]] as const) {
      const f = policyFile(JSON.stringify({ projects: body }));
      expect([f.mode(), f.config("p")]).toEqual([want, want]);
      expect((await cleanup(f.mode, f.config)).s.voidSkip).toBe(want === "off" ? undefined : want);
    }
  });

  test("[验收线 4] a broken recovery-policy.json, a bogus mode, an observe the file does not name or no Actions methods: off", async () => {
    const broken = policyFile("{ not json");
    expect([broken.mode(), broken.config("p")]).toEqual(["off", "off"]);
    for (const [mode, config] of [[broken.mode, broken.config], [() => "maybe" as RecoveryMode, undefined],
      ["observe", () => { throw new Error("policy file broken"); }], ["observe", () => "maybe" as RecoveryMode], ["observe", (): RecoveryMode => "on"]] as const) {
      const { s, observes } = await cleanup(mode, config);
      expect([s.voidSkip, nextSkip(s), observes]).toEqual([undefined, [key(D)], []]);
    }
    const env = deps("on"), s = prevTrain("void", "cleanup");
    for (const k of ["branchRuns", "runJobs", "cancelRun", "jobLog", "runStatus"] as const) delete env.deps.gh[k];
    await stepTrain(s, env.deps);
    expect(env.store.load("p")!.voidSkip).toBeUndefined();
  });

  test("[验收线 5] a merged train's cleanup saves nothing new, in every mode", async () => {
    for (const mode of ["off", "observe", "on"] as const) {
      const env = deps(mode), s = prevTrain("merged", "cleanup");
      await stepTrain(s, env.deps);
      const done = env.store.load("p")!;
      expect(done.voidSkip).toBeUndefined();
      expect(nextSkip(done)).toEqual(legacy(done));
      expect(env.observed.size).toBe(0);
    }
  });

  test("[验收线 3] observe through the real ledger port: five 80-char taskIds still make one note ≤ 600 chars and the train ends", async () => {
    const ledger = tempLedgerPath("train-skip-long-"), db = openLedger(ledger);
    try {
      const env = deps("observe"), long = [1, 2, 3, 4, 5, 6].map((n) => ({ ...card(n), taskId: `${"x".repeat(78)}-${n}` }));
      env.deps.ciTimeout = trainCiTimeoutPort(db, () => 5_000, () => ({ mode: "observe" }) as ReturnType<typeof recoveryPolicy>);
      const s: TrainState = { ...prevTrain("void", "cleanup"), members: long.map((c) => ({ ...c, files: [`f${c.taskId}`] })),
        cars: [], cleared: [], bounced: [], serial: long.slice(0, 5).map((c) => c.taskId), skip: [] };
      let cur = s;
      for (let i = 0; i < 10 && cur.phase !== "done"; i++) cur = await stepTrain(env.store.load("p") ?? cur, env.deps);
      expect(env.store.load("p")).toMatchObject({ phase: "done", voidSkip: "observe" });
      const notes = listEvents(db, { project: "p" }).filter((e) => e.data.mechanism === "trainCiTimeout");
      expect(notes).toHaveLength(1);
      expect(notes[0]!.text.length).toBeLessThanOrEqual(600);
      expect(notes[0]!.data.members).toEqual(long.slice(0, 5).map(key)); // every full key stays in the structured data
      expect(nextSkip(env.store.load("p")!)).toEqual([]);
    } finally { closeLedger(ledger); }
  });

  test("[验收线 3] voidSkipNote: short lists verbatim, long lists bounded with a count", () => {
    expect(voidSkipNote([key(A), key(B)])).toBe(`作废后 ${key(A)}、${key(B)} 下一趟不再上车（这次照旧回去重新组车）`);
    const long = Array.from({ length: 6 }, (_, i) => `${"y".repeat(80)}:${sha(i)}`), note = voidSkipNote(long);
    expect(note).toContain("共 6 张");
    expect(note.length).toBeLessThan(VOID_SKIP_NOTE_KEYS + 60);
    expect(voidSkipNote([`${"z".repeat(500)}:${sha(1)}`])).toBe("作废后 共 1 张（完整见 members） 下一趟不再上车（这次照旧回去重新组车）");
  });
});
