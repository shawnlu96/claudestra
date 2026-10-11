/**
 * dispatch-recovery-TRAINHANG1: a merge train car whose CI hangs past the car timeout. Synthetic trains on a fake GitHub (refs,
 * draft PRs, one Actions run per draft with jobs, cancel, job logs), a fake clock and temp dirs only. Fixtures: 本机 / peer A.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBounceReceipt } from "../src/lib/scheduler-merge-conflict.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import {
  formTrain, nextSkip, stepTrain, trainGate, type MemberStatus, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore,
} from "../src/lib/scheduler-merge-train.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";
import { fileTrainStore } from "../src/lib/scheduler-merge-train-tick.js";
import { CANCEL_RECHECKS, type TrainCiTimeoutPort } from "../src/lib/train-ci-timeout.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

const REPO = "example/repo", BASE = "f".repeat(40), MIN = 60_000;
let shaSeq = 0;
const newSha = () => (++shaSeq).toString(16).padStart(40, "0");
const runUrl = (id: number, repo = REPO) => `https://github.com/${repo}/actions/runs/${id}`;
const LOG = ["2026-10-11T09:00:00.0000000Z ##[group]tests/a.test.ts:", "2026-10-11T09:00:01.0000000Z (pass) a", "##[endgroup]",
  "2026-10-11T09:00:02.0000000Z ##[group]tests/hang.test.ts:", "2026-10-11T09:00:03.0000000Z (pass) first"].join("\n");

interface Run { id: number; branch: string; status: string; hang: boolean }
/** GitHub with Actions: every draft gets one run; a run whose branch holds a hanging head never finishes until cancelled. */
function fakeHub(repo = REPO) {
  const hub = {
    main: BASE, prs: new Map<string, string>(), branches: new Map<string, string[]>(), drafts: new Map<number, string>(), runs: [] as Run[],
    hang: new Set<string>(), red: new Set<string>(), hangChecks: ["test shard 4 of 4", "check"], cancels: [] as number[], calls: [] as string[],
    cancelFails: false as boolean | number, statusFails: new Set<number>(), sticky: false, listFails: false as boolean | string, hideRuns: false,
    allShards: false, queuedOnly: false, noLog: false, finishFirst: false, nextRun: 500, logOf: undefined as ((job: number) => string) | undefined,
  };
  const run = (id: number) => hub.runs.find((r) => r.id === id)!;
  const carRun = (b: string) => hub.runs.find((r) => r.branch === b);
  const gh: TrainGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => [`f${pr.split("/").pop()}`],
    prHead: async (pr) => hub.prs.get(pr)!,
    createBranch: async (_r, b) => { hub.branches.set(b, []); },
    mergeInto: async (_r, b, head) => { hub.branches.get(b)!.push(head); return "merged"; },
    openDraft: async (_r, b) => {
      const n = 1000 + hub.drafts.size;
      hub.drafts.set(n, b); hub.calls.push(`draft:${b}`);
      hub.runs.push({ id: ++hub.nextRun, branch: b, status: "in_progress", hang: hub.branches.get(b)!.some((h) => hub.hang.has(h)) });
      return n;
    },
    checks: async (_r, n) => {
      const b = hub.drafts.get(n)!, r = carRun(b)!;
      if (r.hang) return hub.hangChecks.map((name) => ({ name, bucket: r.status === "completed" ? "cancel" : "pending", link: `${runUrl(r.id, repo)}/job/${r.id * 10 + 4}` }));
      r.status = "completed";
      return hub.branches.get(b)!.some((h) => hub.red.has(h)) ? [{ name: "check", bucket: "fail", link: runUrl(r.id, repo) }] : [{ name: "check", bucket: "pass" }];
    },
    failLog: async () => "FAIL boom",
    parents: async () => [newSha()],
    mergeMatchHead: async () => newSha(),
    closePr: async (_r, n) => { hub.calls.push(`close:${n}`); },
    deleteBranch: async (_r, b) => { hub.calls.push(`delete:${b}`); },
    branchRuns: async (_r, b) => {
      hub.calls.push(`runs:${b}`);
      if (hub.listFails === true || hub.listFails === b) throw new Error("HTTP 502");
      return hub.runs.filter((r) => r.branch === b && !hub.hideRuns).map((r) => ({ id: r.id, url: runUrl(r.id, repo), status: r.status }));
    },
    runJobs: async (_r, id) => {
      const done = run(id).status === "completed", hung = done ? "completed" : hub.queuedOnly ? "queued" : "in_progress";
      return [{ id: id * 10 + 1, name: "test shard 1 of 4", status: hub.allShards ? hung : "completed" },
        ...(hub.allShards ? [2, 3] : []).map((n) => ({ id: id * 10 + n, name: `test shard ${n} of 4`, status: hung })), { id: id * 10 + 4, name: "test shard 4 of 4", status: hung },
        { id: id * 10 + 9, name: "typecheck + test + guard", status: done ? "completed" : "queued" }];
    },
    cancelRun: async (_r, id) => {
      hub.calls.push(`cancel:${id}`);
      if (hub.cancelFails === true || hub.cancelFails === id) throw new Error("HTTP 500");
      const r = run(id);
      if (hub.finishFirst) r.status = "completed";
      if (r.status === "completed") return "finished";
      hub.cancels.push(id);
      if (!hub.sticky) r.status = "completed";
      return "requested";
    },
    jobLog: async (_r, job) => { if (hub.noLog) throw new Error("HTTP 404: Not Found"); return { text: hub.logOf?.(job) ?? LOG, truncated: false }; },
    runStatus: async (_r, id, b) => {
      hub.calls.push(`status:${id}`);
      if (hub.statusFails.has(id)) throw new Error("HTTP 502");
      if (run(id).branch !== b) throw new Error("wrong branch");
      return run(id).status;
    },
  };
  return { hub, gh };
}

function memStore(): TrainStore & { events: TrainEvent[] } {
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  return { events, load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1 };
}

/** Cards T1..Tn; `mode` = trainCiTimeout (undefined = no port at all, the wiring before this card). */
function setup(count: number, mode?: RecoveryMode, store: TrainStore = memStore(), repo = REPO) {
  const f = fakeHub(repo), clock = { t: 1_000 };
  const cards = Array.from({ length: count }, (_, i) => {
    const prRef = `https://github.com/${repo}/pull/${i + 1}`, head = newSha();
    f.hub.prs.set(prRef, head);
    return { taskId: `T${i + 1}`, prRef, head };
  });
  // runs a train must never touch: an author PR and main
  f.hub.runs.push({ id: 90, branch: "task/T1", status: "in_progress", hang: false }, { id: 91, branch: "main", status: "in_progress", hang: false });
  const notices: { text: string; alarm: boolean }[] = [], observed: string[] = [];
  const port: TrainCiTimeoutPort = { mode: () => policy.mode, observe: (s, car, action) => { observed.push(`${s.id}:${car.id}:${action}`); } };
  const policy = { mode: mode ?? "off" };
  const status = new Map<string, MemberStatus>();
  const deps: TrainDeps = { gh: f.gh, store, now: () => clock.t, requiredChecks: ["check"], memberStatus: (id) => status.get(id) ?? { kind: "waiting" },
    notify: async (_s, text, alarm) => { notices.push({ text, alarm }); }, ...(mode ? { ciTimeout: port } : {}) };
  const tick = async (d: TrainDeps = deps) => {
    const live = d.store.load("p");
    return live && live.phase !== "done" ? stepTrain(live, d) : formTrain("p", cards, d);
  };
  /** Ticks until `stop`; the clock jumps past the car timeout only when every live car is just waiting on CI. */
  const drive = async (stop: (s: TrainState) => boolean, max = 60, d: TrainDeps = deps) => {
    for (let i = 0; i < max; i++) {
      const s = await tick(d);
      if (!s || stop(s)) return s;
      const live = s.cars.filter((c) => ["new", "assemble", "ci"].includes(c.status));
      if (s.phase === "testing" && live.length && live.every((c) => c.status === "ci" && !c.timeout)) clock.t += 61 * MIN;
    }
    throw new Error("train never stopped");
  };
  return { ...f, cards, clock, notices, observed, policy, status, deps, store, tick, drive };
}
type Env = ReturnType<typeof setup>;
const texts = (env: Env) => (env.store as ReturnType<typeof memStore>).events.map((e) => e.text);
const settledOrDone = (s: TrainState) => s.phase !== "testing";

beforeEach(() => setTrainModeSource(() => "on"));
afterEach(() => setTrainModeSource(null));

describe("[验收线 1] on: a hanging card is cancelled, bisected and bounced like a red one", () => {
  test("4 cards, T3 hangs: each timed-out car's run is cancelled before its halves start; T3 bounces ci_fail, the rest merge", async () => {
    const env = setup(4, "on");
    env.hub.hang.add(env.cards[2]!.head);
    await env.drive((s) => s.cars[0]!.timeout?.cancel === "pending");
    expect(env.hub.cancels).toEqual([501]); // only the level-0 car's run, and no half drafted yet
    expect(env.hub.drafts.size).toBe(1);
    const s = await env.drive(settledOrDone);
    expect(s!.phase).toBe("settling");
    expect(s!.bounced.map((b) => b.taskId)).toEqual(["T3"]);
    expect(s!.cleared.sort()).toEqual(["T1", "T2", "T4"]);
    expect(env.hub.cancels).toEqual(s!.cars.filter((c) => c.timeout).map((c) => env.hub.runs.find((r) => r.branch === c.branch)!.id));
    for (const c of s!.cars.filter((x) => x.timeout)) { // every cancel landed before the next level was drafted
      const kids = s!.cars.filter((k) => k.parent === c.id);
      for (const k of kids) expect(env.hub.calls.indexOf(`draft:${k.branch}`)).toBeGreaterThan(env.hub.calls.indexOf(`cancel:${env.hub.runs.find((r) => r.branch === c.branch)!.id}`));
    }
    const bounce = parseBounceReceipt(s!.bounced[0]!.receipt)!;
    expect(bounce).toMatchObject({ cause: "ci_fail", prHead: env.cards[2]!.head });
    expect(bounce.checks.map((c) => c.name)).toEqual(["check"]);
    expect(bounce.checks[0]!.link).toMatch(/^https:\/\/github\.com\/example\/repo\/actions\/runs\/\d+ 列车 .* 超时诊断：分片号：4；最后在跑的测试文件：tests\/hang\.test\.ts$/); // the run is the link itself, said once
    expect(env.hub.runs.filter((r) => r.id === 90 || r.id === 91).map((r) => r.status)).toEqual(["in_progress", "in_progress"]);
    // the bisect pin is the existing one: next train skips T3 at this head, a new head may ride again
    for (const id of ["T1", "T2", "T4"]) env.status.set(id, { kind: "merged", sha: newSha() });
    env.status.set("T3", { kind: "gone", why: "阶段 fix" });
    const done = await env.drive((x) => x.phase === "done");
    const skip = nextSkip(done!);
    expect(skip).toContain(`T3:${env.cards[2]!.head}`);
    const files = async (c: { taskId: string }) => [c.taskId];
    const again = await formTrain("p", [env.cards[2]!, { taskId: "T5", prRef: `https://github.com/${REPO}/pull/5`, head: newSha() }], env.deps, files, skip);
    expect(again).toBeNull();
    const fresh = await formTrain("p", [{ ...env.cards[2]!, head: newSha() }, { taskId: "T5", prRef: `https://github.com/${REPO}/pull/5`, head: newSha() }],
      env.deps, files, skip);
    expect(fresh?.members.map((m) => m.taskId)).toEqual(["T3", "T5"]);
  });

  test("red before: without trainCiTimeout on the car timeout voids and the same hanging card boards the next train", async () => {
    const env = setup(4, "off");
    env.hub.hang.add(env.cards[2]!.head);
    const s = await env.drive(settledOrDone);
    expect(s).toMatchObject({ phase: "cleanup", outcome: "void", reason: "车厢 " + s!.cars[0]!.id + " CI 超时", bounced: [] });
    const done = await env.drive((x) => x.phase === "done");
    expect(nextSkip(done!)).toEqual([]); // nothing remembered: T3 rides again and hangs the next train too
    expect(env.hub.cancels).toEqual([]);
  });
});

describe("[验收线 2] one split entry for red and timeout", () => {
  test("combination-only hang (each half green): give up to serial with a PM alarm, no bounce, the log file blames nobody", async () => {
    const env = setup(2, "on");
    const gh = env.gh, open = gh.openDraft;
    gh.openDraft = async (r, b, t, body) => {
      const n = await open(r, b, t, body), run = env.hub.runs.at(-1)!;
      run.hang = env.hub.branches.get(b)!.length === 2; // only the two together hang
      return n;
    };
    const s = await env.drive(settledOrDone);
    expect(s).toMatchObject({ phase: "cleanup", outcome: "serial", bounced: [] });
    expect(s!.serial.sort()).toEqual(["T1", "T2"]);
    expect(env.notices.some((n) => n.alarm && n.text.includes("拆开都绿"))).toBe(true);
    expect(s!.cars[0]!.summary).toContain("tests/hang.test.ts"); // evidence kept on the car, never a verdict
  });

  test("a hang only in a non-required check: bisected down, then the single card goes serial (its own CI judges), no bounce", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    env.hub.hangChecks = ["desktop typecheck + cargo test"];
    const s = await env.drive(settledOrDone);
    expect(s!.bounced).toEqual([]);
    expect(s!.serial).toEqual(["T2"]);
    expect(texts(env).some((t) => t.includes("单独跑超时的是非必需检查"))).toBe(true);
  });

  test("timeout and red cars share failCar: same events, same depth; a moved head never takes the old bounce", async () => {
    const env = setup(3, "on");
    env.hub.hang.add(env.cards[0]!.head);
    env.hub.red.add(env.cards[2]!.head);
    const s = await env.drive(settledOrDone);
    expect(s!.bounced.map((b) => b.taskId).sort()).toEqual(["T1", "T3"]);
    expect(Math.max(...s!.cars.map((c) => c.level))).toBeLessThanOrEqual(3);
    const ci = (env.store as ReturnType<typeof memStore>).events.filter((e) => e.kind === "ci" && e.data?.failed);
    expect(new Set(ci.map((e) => e.data!.result))).toEqual(new Set(["red", "timeout"]));
    const run = (head: string): MergeRun => ({ intentId: "m1", taskId: "T1", project: "p", prRef: env.cards[0]!.prRef, expectedBranch: "task/T1",
      reviewedHead: head, requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 });
    const io = { gh: env.gh, store: env.store, now: () => env.clock.t, notify: async () => {} };
    expect(await trainGate(structuredClone(s!), run(env.cards[0]!.head), io)).toEqual({ bounce: s!.bounced.find((b) => b.taskId === "T1")!.receipt });
    expect(await trainGate(structuredClone(s!), run(newSha()), io)).not.toHaveProperty("bounce");
  });
});

describe("[验收线 3] cancel exactly the bound runs, confirm before anything new", () => {
  test("two live cars + an author PR + main: only the timed-out car is cancelled; a whole-train exit cancels the rest of the train only", async () => {
    const env = setup(4, "on");
    env.hub.hang.add(env.cards[3]!.head);
    env.hub.hang.add(env.cards[0]!.head);
    await env.drive((s) => s.cars.length === 3 && s.cars.every((c) => c.status === "ci" || c.status === "split"));
    const s = env.store.load("p")!, [a, b] = [s.cars[1]!, s.cars[2]!];
    a.startedAt = env.clock.t; env.store.save(s); // car a started later: still inside its timeout when b times out
    env.clock.t += 30 * MIN;
    b.startedAt = env.clock.t - 61 * MIN; env.store.save(s);
    await env.tick();
    const runOf = (branch: string) => env.hub.runs.find((r) => r.branch === branch)!;
    expect(env.hub.cancels).toEqual([runOf(s.cars[0]!.branch).id, runOf(b.branch).id]);
    expect(runOf(a.branch).status).toBe("in_progress");
    env.hub.main = newSha(); // main moves: the whole train exits
    const out = await env.drive((x) => x.phase === "cleanup");
    expect(out!.outcome).toBe("void");
    await env.drive((x) => x.phase === "done");
    expect(env.hub.cancels).toContain(runOf(a.branch).id);
    expect(env.hub.calls.indexOf(`cancel:${runOf(a.branch).id}`)).toBeLessThan(env.hub.calls.findIndex((c) => c.startsWith("close:")));
    expect(env.hub.calls.filter((c) => c === "cancel:90" || c === "cancel:91")).toEqual([]);
    expect(env.hub.runs.filter((r) => r.id >= 90 && r.id <= 91).map((r) => r.status)).toEqual(["in_progress", "in_progress"]);
    expect(env.store.load("p")!.ciExit).toMatchObject({ cancel: "confirmed" });
  });

  test("a run that finished before the cancel is fine (idempotent): confirmed, then split as usual", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    env.hub.finishFirst = true;
    const s = await env.drive(settledOrDone);
    expect(s!.bounced.map((b) => b.taskId)).toEqual(["T2"]);
    expect(s!.cars.filter((c) => c.timeout).every((c) => c.timeout!.cancel === "confirmed" && c.timeout!.receipts.every((r) => r.endsWith(":finished")))).toBe(true);
  });

  for (const [name, arrange] of [
    ["cancel refused", (env: Env) => { env.hub.cancelFails = true; }],
    ["cancel never settles", (env: Env) => { env.hub.sticky = true; }],
    ["runs cannot be listed", (env: Env) => { env.hub.listFails = true; }],
  ] as const) {
    test(`${name}: PM alarm (judge), members serial, no half drafted for that car, no guess`, async () => {
      const env = setup(2, "on");
      env.hub.hang.add(env.cards[1]!.head);
      arrange(env);
      const s = await env.drive(settledOrDone);
      expect(s).toMatchObject({ phase: "cleanup", outcome: "serial", bounced: [] });
      expect(env.hub.drafts.size).toBe(1);
      expect(env.notices.filter((n) => n.alarm).map((n) => n.text).join("\n")).toMatch(/未定位/);
      if (name === "cancel never settles") expect(s!.cars[0]!.timeout).toMatchObject({ cancel: "unconfirmed", rechecks: CANCEL_RECHECKS });
    });
  }

  test("restart while the cancel is pending, and again after it was confirmed: one diagnosis, one pin, one bounce", async () => {
    const dir = mkdtempSync(join(tmpdir(), "train-ci-timeout-")), env = setup(2, "on", fileTrainStore(dir));
    env.hub.hang.add(env.cards[1]!.head);
    env.hub.sticky = true;
    await env.drive((s) => s.cars[0]!.timeout?.cancel === "pending");
    const reborn = { ...env.deps, store: fileTrainStore(dir) };
    expect(reborn.store.load("p")!.cars[0]!.timeout).toMatchObject({ cancel: "pending", runs: [{ id: 501 }] });
    env.hub.sticky = false;
    await env.tick(reborn);
    expect(env.hub.cancels).toEqual([501, 501]); // the recheck re-sent the cancel to the same run, nothing new listed
    await env.drive((s) => s.cars.some((c) => c.timeout?.cancel === "confirmed" && c.members.length === 1), 60, reborn);
    // simulate a crash after the confirmed claim but before failCar's save
    const s = reborn.store.load("p")!, single = s.cars.find((c) => c.timeout?.cancel === "confirmed" && c.members.length === 1)!;
    if (single.status !== "ci") { single.status = "ci"; s.bounced = []; s.phase = "testing"; reborn.store.save(s); }
    const again = { ...env.deps, store: fileTrainStore(dir) };
    const out = await env.drive(settledOrDone, 60, again);
    expect(out!.bounced.map((b) => b.taskId)).toEqual(["T2"]);
    expect(out!.cars.filter((c) => c.timeout).map((c) => c.timeout!.diag)).toHaveLength(2);
  });
});

describe("[验收线 4] the bounce carries the single card's own evidence", () => {
  test("logs gone after the combined car: the single card's bounce says 未取到 instead of borrowing the combined car's file", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    await env.drive((s) => s.cars[0]!.timeout?.diag !== undefined);
    env.hub.noLog = true;
    const s = await env.drive(settledOrDone);
    expect(s!.cars[0]!.timeout!.diag).toContain("tests/hang.test.ts");
    const link = parseBounceReceipt(s!.bounced[0]!.receipt)!.checks[0]!.link;
    expect(link).toContain("分片号：4；最后在跑的测试文件：未取到（日志取不到：HTTP 404: Not Found）");
    expect(link).not.toContain("tests/hang.test.ts");
    expect(link).toContain("/actions/runs/");
  });

  test("a car whose jobs only queued (no runner): cancelled, then judged, never bisected onto a card", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    env.hub.queuedOnly = true;
    const s = await env.drive(settledOrDone);
    expect(s).toMatchObject({ outcome: "serial", bounced: [] });
    expect(env.hub.cancels).toEqual([501]);
    expect(env.notices.some((n) => n.alarm && n.text.includes("一直在排队"))).toBe(true);
  });
});

describe("[验收线 5] off is unchanged, observe only records, trainMode off adds nothing", () => {
  const voidRun = async (mode?: RecoveryMode) => {
    shaSeq = 1000;
    const env = setup(3, mode);
    env.hub.hang.add(env.cards[1]!.head);
    const s = await env.drive((x) => x.phase === "done");
    return { env, s: s!, events: (env.store as ReturnType<typeof memStore>).events.map((e) => [e.kind, e.text, e.data]) };
  };

  test("off and observe: notices, state and skip are the ones the build without this card gives; observe adds one record", async () => {
    const before = await voidRun(undefined), off = await voidRun("off"), observe = await voidRun("observe");
    for (const r of [off, observe]) {
      expect(r.events).toEqual(before.events);
      expect(r.env.notices).toEqual(before.env.notices);
      expect(r.s).toEqual(before.s);
      expect(nextSkip(r.s)).toEqual([]);
      expect(r.env.hub.calls.filter((c) => /^(runs|cancel):/.test(c))).toEqual([]);
    }
    expect(before.s.reason).toBe(`车厢 ${before.s.cars[0]!.id} CI 超时`);
    expect([off.env.observed, observe.env.observed.length]).toEqual([[], 1]);
    expect(observe.env.observed[0]).toContain("按组合红二分");
  });

  test("trainMode off: a live train is closed as before; no run listed, no cancel, no observe", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    await env.drive((s) => s.cars[0]!.status === "ci");
    setTrainModeSource(() => "off");
    env.clock.t += 61 * MIN;
    const s = await env.drive((x) => x.phase === "done");
    expect(s).toMatchObject({ outcome: "void", reason: "列车已关闭" });
    expect(env.hub.calls.filter((c) => /^(runs|cancel):/.test(c))).toEqual([]);
    expect(env.observed).toEqual([]);
  });
});

describe("[验收线 6] deadline, drift and an outsider void never pin a card", () => {
  test("on: past the 6 h deadline the train cancels what runs and gives up as 未定位 (PM alarm), nobody bounced", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    await env.drive((s) => s.cars[0]!.status === "ci");
    env.clock.t += 7 * 60 * MIN;
    const s = await env.drive(settledOrDone);
    expect(s).toMatchObject({ outcome: "serial", reason: "列车超过总时限，未定位", bounced: [] });
    expect(env.notices.some((n) => n.alarm && n.text.includes("未定位"))).toBe(true);
    await env.drive((x) => x.phase === "done");
    expect(env.hub.cancels).toEqual([501]);
  });

  test("on: a member head moves mid-bisect: void (not a bounce), its running halves cancelled at exit", async () => {
    const env = setup(4, "on");
    env.hub.hang.add(env.cards[0]!.head);
    await env.drive((s) => s.cars.length === 3 && s.cars.slice(1).every((c) => c.status === "ci"));
    env.hub.prs.set(env.cards[3]!.prRef, newSha());
    const s = await env.drive((x) => x.phase === "done");
    expect(s).toMatchObject({ outcome: "void", bounced: [] });
    expect(s!.reason).toContain("T4 head 变成");
    const halves = s!.cars.slice(1).map((c) => env.hub.runs.find((r) => r.branch === c.branch)!.id);
    expect(env.hub.cancels).toEqual([501, ...halves]);
    // the timed-out car was still unlocated: its members go serial and PM judges (the moved T4 may ride again at its new head)
    expect(s!.serial.sort()).toEqual(["T1", "T2", "T3", "T4"]);
    expect(nextSkip(s!)).toEqual(env.cards.map((c) => `${c.taskId}:${c.head}`));
    expect(env.notices.filter((n) => n.alarm).map((n) => n.text)).toEqual([expect.stringContaining("未定位")]);
  });


  test("on: an outsider past the hold voids a timeout bisect: unlocated members go serial, skip the next train, PM judges; a cleared half regroups", async () => {
    const env = setup(4, "on");
    env.hub.hang.add(env.cards[2]!.head);
    await env.drive((s) => s.cars.length === 3 && s.cars.slice(1).every((c) => c.status === "ci"));
    const mid = await env.tick(); // [T1, T2] green, [T3, T4] still running
    expect(mid!.cars.slice(1).map((c) => c.status)).toEqual(["green", "ci"]);
    expect(await trainGate(env.store.load("p"), outsider(env), io(env))).toBeNull();
    const s = await env.drive((x) => x.phase === "done");
    expect(s).toMatchObject({ outcome: "void", bounced: [] });
    expect(s!.reason).toContain("放行串行合并 T9");
    expect([s!.serial.sort(), s!.cleared.sort()]).toEqual([["T3", "T4"], ["T1", "T2"]]);
    expect(nextSkip(s!)).toEqual([`T3:${env.cards[2]!.head}`, `T4:${env.cards[3]!.head}`]);
    const alarms = env.notices.filter((n) => n.alarm).map((n) => n.text);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatch(/T3、T4 回串行路径.*未定位，请 PM 看看/);
    expect(env.hub.cancels).toContain(env.hub.runs.find((r) => r.branch === s!.cars[2]!.branch)!.id); // its half was cancelled at exit
    const next = await formTrain("p", env.cards, env.deps, async (c) => [c.taskId], nextSkip(s!));
    expect(next!.members.map((m) => m.taskId)).toEqual(["T1", "T2"]); // the hanging pair waits on the serial path
  });

  test("on: an outsider voids a train with no timed-out car: the old regroup, nothing serial, no alarm", async () => {
    const env = setup(2, "on");
    await env.drive((s) => s.cars[0]!.status === "ci");
    env.clock.t += 61 * MIN; // past the hold, the car not yet checked
    expect(await trainGate(env.store.load("p"), outsider(env), io(env))).toBeNull();
    const s = await env.drive((x) => x.phase === "done");
    expect(s).toMatchObject({ outcome: "void", serial: [], bounced: [] });
    expect(nextSkip(s!)).toEqual([]);
    expect(env.notices.filter((n) => n.alarm)).toEqual([]);
  });
});

const outsider = (env: Env) => ({ intentId: "m9", taskId: "T9", project: "p", prRef: `https://github.com/${REPO}/pull/9`, expectedBranch: "task/T9",
  reviewedHead: newSha(), requiredChecks: "check", phase: "ready", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 }) as MergeRun;
const io = (env: Env) => ({ gh: env.gh, store: env.store, now: () => env.clock.t, notify: async () => {} }); // the merge driver's io: no port, no notice
const alarms = (env: Env) => env.notices.filter((n) => n.alarm).map((n) => n.text);
const runOf = (env: Env, s: TrainState, i: number) => env.hub.runs.find((r) => r.branch === s.cars[i]!.branch)!.id;

describe("[验收线 3] a cancel is confirmed only by each run's own completed status", () => {
  test("复现 missing-confirm: the claimed run drops out of the branch listing but still runs: not confirmed, no half drafted, judged", async () => {
    const env = setup(2, "on");
    env.hub.hang.add(env.cards[1]!.head);
    env.hub.sticky = true;
    await env.drive((s) => s.cars[0]!.timeout?.cancel === "pending");
    env.hub.hideRuns = true; // the listing no longer shows run 501, which is still in_progress
    const s = await env.tick();
    expect(s!.cars[0]!.timeout).toMatchObject({ cancel: "pending", rechecks: 1 });
    expect(env.hub.drafts.size).toBe(1);
    env.hub.statusFails.add(501); // a status that cannot be read is not a stop either
    const end = await env.drive(settledOrDone);
    expect(end).toMatchObject({ outcome: "serial", bounced: [] });
    expect(env.hub.drafts.size).toBe(1);
    expect(alarms(env).some((t) => t.includes("仍未确认停下") && t.includes("未定位"))).toBe(true);
  });
});

describe("[验收线 3] an exit cancels every run on its own", () => {
  const exitWithTwoHalves = async () => {
    const env = setup(4, "on");
    env.hub.hang.add(env.cards[0]!.head);
    const s = await env.drive((x) => x.cars.length === 3 && x.cars.slice(1).every((c) => c.status === "ci"));
    env.hub.prs.set(env.cards[3]!.prRef, newSha()); // drift: void, both halves still running at exit
    return { env, halves: [runOf(env, s!, 1), runOf(env, s!, 2)] };
  };

  test("复现 cancel-short: the first half's cancel keeps failing: the second is still cancelled, the first re-sent, then judged", async () => {
    const { env, halves } = await exitWithTwoHalves();
    env.hub.cancelFails = halves[0]!;
    await env.drive((x) => x.phase === "done");
    expect(env.hub.cancels).toContain(halves[1]!);
    expect(env.hub.calls.filter((c) => c === `cancel:${halves[0]}`).length).toBeGreaterThan(1);
    const exit = alarms(env).filter((t) => t.includes("列车退出时"));
    expect(exit).toHaveLength(1);
    expect(exit[0]).toContain(`run ${halves[0]} 仍未确认停下`);
    expect(exit[0]).not.toContain(String(halves[1]));
  });

  test("one train branch cannot be listed at first: the other's run is cancelled right away, the branch is retried, no alarm", async () => {
    const { env, halves } = await exitWithTwoHalves();
    const s = env.store.load("p")!;
    env.hub.listFails = s.cars[1]!.branch;
    await env.tick(); // void
    const first = await env.tick(); // exit: lists, cancels what it could
    expect(first!.ciExit).toMatchObject({ cancel: "pending", unlisted: [s.cars[1]!.branch] });
    expect(env.hub.cancels).toEqual([501, halves[1]!]);
    env.hub.listFails = false;
    await env.drive((x) => x.phase === "done");
    expect(env.hub.cancels).toEqual([501, halves[1]!, halves[0]!]);
    expect(alarms(env).filter((t) => t.includes("列车退出时"))).toEqual([]);
  });
});

describe("[验收线 4] the single card's receipt keeps its own timeout evidence", () => {
  test("复现 evidence-fit: long owner/repo, four shards hung: the receipt still links the run with shard and last file", async () => {
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`, env = setup(2, "on", memStore(), repo);
    env.hub.hang.add(env.cards[0]!.head);
    env.hub.allShards = true;
    const s = await env.drive(settledOrDone);
    expect(s!.bounced.map((b) => b.taskId)).toEqual(["T1"]);
    const receipt = s!.bounced[0]!.receipt, link = parseBounceReceipt(receipt)!.checks[0]!.link;
    expect(receipt.length).toBeLessThanOrEqual(600);
    const run = runOf(env, s!, s!.cars.findIndex((c) => c.members.join() === "T1"));
    expect(link.startsWith(`${runUrl(run, repo)} 列车 ${s!.id} 超时诊断：分片号：1；最后在跑的测试文件：tests/hang.test.ts`)).toBe(true);
    expect(link.split(runUrl(run, repo)).length).toBe(2); // the run is said once
  });

  test("复现 evidence-fit r2: four shards running, only shard 4's log ends in tests/hang.test.ts: every shard is read and kept", async () => {
    const repo = `${"o".repeat(39)}/${"r".repeat(100)}`, env = setup(2, "on", memStore(), repo), read: number[] = [];
    env.hub.hang.add(env.cards[0]!.head);
    env.hub.allShards = true;
    env.hub.logOf = (job) => { read.push(job % 10); return job % 10 === 4 ? LOG : LOG.replace("tests/hang.test.ts", "tests/ok.test.ts"); };
    const s = await env.drive(settledOrDone);
    expect(s!.bounced.map((b) => b.taskId)).toEqual(["T1"]);
    expect(read.filter((n) => n === 4).length).toBeGreaterThan(0);
    const receipt = s!.bounced[0]!.receipt, link = parseBounceReceipt(receipt)!.checks[0]!.link;
    expect(receipt.length).toBeLessThanOrEqual(600);
    for (const n of [1, 2, 3]) expect(link).toContain(`分片号：${n}；最后在跑的测试文件：tests/ok.test.ts`);
    expect(link).toContain("分片号：4；最后在跑的测试文件：tests/hang.test.ts");
  });
});

describe("[验收线 6] a void mid timeout bisect after a red split", () => {
  test("复现 void-isolation: red split first, then the [T1, T2] half times out and splits; an outsider voids: only T1, T2 are held back", async () => {
    const env = setup(4, "on");
    env.hub.red.add(env.cards[3]!.head);
    await env.drive((x) => x.cars.length === 3); // the level-0 car went red and split; halves not drafted yet
    env.hub.hang.add(env.cards[0]!.head);
    const mid = await env.drive((x) => x.cars.some((c) => c.members.join() === "T1,T2" && c.status === "split") &&
      x.cars.some((c) => c.members.join() === "T1" && c.status === "ci"));
    expect(mid!.cars.find((c) => c.members.join() === "T1,T2")!.timeout).toBeDefined();
    expect(await trainGate(env.store.load("p"), outsider(env), io(env))).toBeNull();
    const s = await env.drive((x) => x.phase === "done");
    expect(s!.outcome).toBe("void");
    expect(nextSkip(s!).sort()).toEqual(s!.members.filter((m) => ["T1", "T2"].includes(m.taskId) && !s!.cleared.includes(m.taskId))
      .map((m) => `${m.taskId}:${m.head}`).sort());
    expect(nextSkip(s!).some((k) => k.startsWith("T3:") || k.startsWith("T4:"))).toBe(false);
    expect(alarms(env).some((t) => t.includes("未定位"))).toBe(true);
  });
});
