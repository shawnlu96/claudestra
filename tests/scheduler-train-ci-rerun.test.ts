/**
 * merge-arch-CLASS1: a red merge train car is classified before it is bisected. Synthetic trains on a fake GitHub (one Actions run
 * per draft, with attempts), a fake clock, and a real ledger in a temp dir for the claim, the known flaky list and the serial gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addKnownFlaky, setKnownFlakyModeSource } from "../src/lib/ci-known-flaky.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { RERUN_SETTLE_MS, type CiRerunGh } from "../src/lib/scheduler-merge-ci-rerun.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { formTrain, stepTrain, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import { trainGh } from "../src/lib/scheduler-merge-train-gh.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";
import { RUN_FINISH_WAIT_MS, type TrainRerunGh } from "../src/lib/scheduler-train-ci-rerun.js";
import { contentKey, trainCiClassPort, type TrainCiClassPort } from "../src/lib/scheduler-train-ci-rerun-state.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import type { TrainRunsGh } from "../src/lib/train-ci-timeout.js";
import { ledgerAs, mergedCard } from "./deploy-test-kit.js";

const REPO = "example/repo", BASE = "f".repeat(40), MIN = 60_000, T9_HEAD = "c".repeat(40), T9_PR = `https://github.com/${REPO}/pull/7`;
const SLOW = "tests/slow.test.ts", FLAKY = "tests/flaky.test.ts";
const owner = { actor: "owner", now: 150 };
const runUrl = (id: number) => `https://github.com/${REPO}/actions/runs/${id}`;
const lines = (job: string, step: string, ls: string[]) => ls.map((l) => `${job}\t${step}\t2026-10-12T09:00:00.1234567Z ${l}`).join("\n");
const unit = (ls: string[], fails = 1) => lines("test shard 1 of 4", "Unit tests", [...ls, " 1999 pass", ` ${fails} fail`, "##[error]Process completed with exit code 1."]);
const TIMEOUT_LOG = unit([`##[group]${SLOW}:`, "(fail) slow > case [5000.00ms]", "  ^ this test timed out after 5000ms.", "##[endgroup]"]);
const FLAKY_LOG = unit([`##[group]${FLAKY}:`, "error: expect(received).toBe(expected)", "(fail) race > case [0.40ms]", "##[endgroup]"]);
const ENV_LOG = lines("test shard 1 of 4", "Install dependencies", ["error: ConnectionRefused downloading tarball zod@4.6.5", "##[error]Process completed with exit code 1."]);
const UNKNOWN_LOG = lines("test shard 1 of 4", "Guard (ratchets)", ["guard red", "##[error]Process completed with exit code 1."]);

interface Run { id: number; branch: string; attempt: number; status: string; conclusion: string; shown: "fail" | "pass" | "pending" | "cancel" }
/** GitHub: every draft gets one run that finishes at once; `red` / `log` answer per attempt. A rerun stays in progress until settle(). */
function fakeHub() {
  const hub = {
    main: BASE, prs: new Map<string, string>(), files: new Map<string, string[]>(), branches: new Map<string, string[]>(), drafts: new Map<number, string>(),
    runs: [{ id: 90, branch: "task/T1", attempt: 1, status: "in_progress", conclusion: "", shown: "pending" }] as Run[], nextRun: 500,
    red: ((_heads, attempt) => attempt === 1) as (heads: string[], attempt: number) => boolean, log: (() => TIMEOUT_LOG) as (attempt: number) => string,
    reruns: [] as number[], cancels: [] as number[], rerunFails: false, lag: false, stale: false, attemptFails: false, firstStatus: "completed",
  };
  const run = (id: number) => hub.runs.find((r) => r.id === id)!;
  const finish = (r: Run) => {
    const red = hub.red(hub.branches.get(r.branch)!, r.attempt);
    r.status = "completed"; r.conclusion = red ? "failure" : "success"; r.shown = red ? "fail" : "pass";
  };
  const gh: TrainGh & TrainRerunGh & TrainRunsGh = {
    mainHead: async () => hub.main,
    prFiles: async (pr) => hub.files.get(pr) ?? [`src/pr${pr.split("/").pop()}.ts`],
    prHead: async (pr) => hub.prs.get(pr)!,
    createBranch: async (_r, b) => { hub.branches.set(b, []); },
    mergeInto: async (_r, b, head) => { hub.branches.get(b)!.push(head); return "merged"; },
    openDraft: async (_r, b) => {
      const n = 1000 + hub.drafts.size, r: Run = { id: ++hub.nextRun, branch: b, attempt: 1, status: "", conclusion: "", shown: "fail" };
      hub.drafts.set(n, b); hub.runs.push(r); finish(r);
      r.status = hub.firstStatus; // a sibling job may still be going while a check already failed
      return n;
    },
    checks: async (_r, n) => { const r = hub.runs.find((x) => x.branch === hub.drafts.get(n))!; return [{ name: "check", bucket: r.shown, link: `${runUrl(r.id)}/job/${r.id}1` }]; },
    failLog: async () => "FAIL boom",
    parents: async () => ["1".repeat(40)],
    mergeMatchHead: async () => "2".repeat(40),
    closePr: async () => {},
    deleteBranch: async () => {},
    runAttempt: async (_r, id, branch) => {
      if (hub.attemptFails) throw new Error("HTTP 502");
      const r = run(id);
      if (r.branch !== branch) throw new Error("wrong branch");
      return { attempt: hub.lag ? 1 : r.attempt, status: r.status, conclusion: r.conclusion };
    },
    failedLog: async (_r, id) => hub.log(run(id).attempt),
    rerunFailed: async (_r, id) => {
      hub.reruns.push(id);
      if (hub.rerunFails) throw new Error("HTTP 500");
      const r = run(id);
      r.attempt++; r.status = "in_progress"; r.conclusion = "";
      if (!hub.lag && !hub.stale) r.shown = "pending"; // stale: the new attempt runs, the PR still shows the old red
    },
    branchRuns: async (_r, b) => hub.runs.filter((r) => r.branch === b).map((r) => ({ id: r.id, url: runUrl(r.id), status: r.status })),
    runJobs: async (_r, id) => [{ id: id * 10 + 1, name: "test shard 1 of 4", status: run(id).status === "completed" ? "completed" : "in_progress" }],
    cancelRun: async (_r, id) => { hub.cancels.push(id); Object.assign(run(id), { status: "completed", conclusion: "cancelled", shown: "cancel" }); return "requested"; },
    jobLog: async () => ({ text: "2026-10-12T09:00:00.0000000Z ##[group]tests/a.test.ts:", truncated: false }),
    runStatus: async (_r, id) => run(id).status,
  };
  /** Every re-run attempt still going ends: red or green by `red`, and the PR checks show it. */
  const settle = () => { hub.lag = false; for (const r of hub.reruns.map(run).filter((x) => x.status !== "completed")) { if (r.attempt === 1) r.attempt = 2; finish(r); } };
  return { hub, gh, settle, run };
}

function memStore(): TrainStore & { events: TrainEvent[] } {
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  return { events, load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1 };
}

/** Cards T9 (the kit's merge card, so the serial gate can run on it) and T1..; `mode` null = no port at all (the wiring before this card). */
function setup(mode: RecoveryMode | null, count = 2, over: Partial<TrainCiClassPort> = {}) {
  const c = mergedCard(), f = fakeHub(), clock = { t: 1_000 }, policy = { mode: mode ?? "off" }, store = memStore();
  const cards = Array.from({ length: count }, (_, i) => {
    const taskId = i ? `T${i}` : "T9", prRef = i ? `https://github.com/${REPO}/pull/${i}` : T9_PR, head = i ? String(i).repeat(40) : T9_HEAD;
    if (i) createTask(c.db, owner, { project: "p", id: taskId, title: taskId, kind: "code" });
    f.hub.prs.set(prRef, head);
    return { taskId, prRef, head };
  });
  const port = { ...trainCiClassPort(c.db, () => clock.t, () => ({ mode: policy.mode, manualAfterMs: null, source: "config" })), ...over };
  const notices: { text: string; alarm: boolean }[] = [];
  const deps: TrainDeps = { gh: f.gh, store, now: () => clock.t, requiredChecks: ["check"], memberStatus: () => ({ kind: "waiting" }),
    notify: async (_s, text, alarm) => { notices.push({ text, alarm }); }, ...(mode ? { ciClass: port } : {}) };
  const tick = async (d: TrainDeps = deps) => {
    const live = store.load("p");
    return live && live.phase !== "done" ? stepTrain(live, d) : formTrain("p", cards, d);
  };
  const drive = async (stop: (s: TrainState) => boolean, d: TrainDeps = deps) => {
    for (let i = 0; i < 40; i++) { const s = await tick(d); if (s && stop(s)) return s; }
    throw new Error("train never stopped");
  };
  /** Ticks until the first car's checks have been judged once: it is red / split, or held in ci. */
  const firstVerdict = async (d: TrainDeps = deps) => { await tick(d); await tick(d); return (await tick(d))!; };
  const events = (op: string) => (c.db.query("SELECT target, text, data FROM events ORDER BY seq").all() as { target: string; text: string; data: string }[])
    .map((e) => ({ target: e.target, text: e.text, ...JSON.parse(e.data) })).filter((e) => e.op === op);
  /** A valid known flaky entry for `file`; fixer(stage) opens the fixing node's card and moves it. */
  const listFlaky = (file = FLAKY) => {
    const featureId = createFeature(c.db, owner, { project: "p", slug: "rel", title: "rel" }).row.id;
    initDag(c.db, owner, { id: featureId, rev: 1, nodes: [{ key: "FIX1", oneLine: "修时序竞态" }] });
    addKnownFlaky(c.db, owner, { project: "p", file, featureId, node: "FIX1", reason: "时序竞态" });
    return (stage: string) => {
      createTask(c.db, owner, { project: "p", id: "rel-FIX1", title: "fix", kind: "code" });
      bindNode(c.db, owner, { id: featureId, rev: getFeature(c.db, featureId)!.rev, key: "FIX1", taskId: "rel-FIX1" });
      c.db.query("UPDATE tasks SET stage=? WHERE id='rel-FIX1'").run(stage);
    };
  };
  return { ...c, ...f, cards, clock, policy, store, port, deps, notices, tick, drive, firstVerdict, events, listFlaky };
}
type Env = ReturnType<typeof setup>;
const done = (s: TrainState) => s.phase !== "testing";
const car0 = (s: TrainState) => s.cars[0]!;
const shape = (s: TrainState) => ({ cars: s.cars.map((c) => `${c.id}:${c.status}`), bounced: s.bounced.map((b) => b.taskId).sort(), cleared: [...s.cleared].sort(),
  serial: [...s.serial].sort(), outcome: s.outcome });
/** A person re-ran the first car's run before the train read it: attempt 2, completed, still red (or green). Later cars start at attempt 1. */
const manualRerun = (env: Env, red = true) => {
  if (red) env.hub.red = () => true;
  const open = env.gh.openDraft;
  env.gh.openDraft = async (...a) => {
    const n = await open(...a);
    if (env.hub.drafts.size === 1) Object.assign(env.hub.runs.at(-1)!, { attempt: 2 }, red ? {} : { conclusion: "success", shown: "pass" });
    return n;
  };
};
const envs: Env[] = [];
const make = (...a: Parameters<typeof setup>) => { const e = setup(...a); envs.push(e); return e; };

beforeEach(() => setTrainModeSource(() => "on"));
afterEach(() => { setTrainModeSource(null); setKnownFlakyModeSource(null); for (const e of envs.splice(0)) e.close(); });

describe("[验收线 1] an eligible red is re-run once before any bisect", () => {
  test("先红: without the port a train spends no re-run on an untouched timeout, it bisects at once", async () => {
    const env = make(null);
    const s = await env.firstVerdict();
    expect(car0(s).status).toBe("split");
    expect(env.hub.reruns).toEqual([]);
  });
  test("on, CIF1-eligible timeout outside every member's files: one rerun of the car's own run, held, green attempt → green car, no bisect", async () => {
    const env = make("on");
    let s = await env.firstVerdict();
    const runId = env.hub.runs.at(-1)!.id;
    expect(env.hub.reruns).toEqual([runId]);
    expect([car0(s).status, s.cars.length, env.hub.drafts.size]).toEqual(["ci", 1, 1]);
    expect(env.events("merge_train_ci_rerun").map((e) => [e.target, e.prHead, e.run, e.class, e.attempt]))
      .toEqual(env.cards.map((c) => [c.taskId, c.head, runUrl(runId), "timeout", 1]));
    s = (await env.tick())!; // the new attempt is still running: nothing is judged
    expect(car0(s).status).toBe("ci");
    env.settle();
    s = await env.drive(done);
    expect(shape(s)).toMatchObject({ cars: [`${s.id}:green`], cleared: ["T1", "T9"], bounced: [] });
    expect([env.hub.reruns.length, env.hub.drafts.size, s.ciRuns]).toEqual([1, 1, 1]);
    expect(env.store.events.find((e) => e.data?.result === "rerun")?.text).toContain("判为没碰的测试超时，自动重跑一次");
  });
  test("on, failures only in valid known flaky files (CIF8 list) outside the members' files: one rerun; a green rerun registers nothing", async () => {
    const env = make("on");
    env.listFlaky();
    env.hub.log = () => FLAKY_LOG;
    await env.firstVerdict();
    expect(env.hub.reruns.length).toBe(1);
    expect(env.events("merge_train_ci_rerun")[0]).toMatchObject({ class: "known_flaky", files: [FLAKY] });
    env.settle();
    expect(shape(await env.drive(done)).cleared).toEqual(["T1", "T9"]);
    expect(env.events("ci_known_flaky_add").length).toBe(1); // only the PM's own entry: green after a rerun is no proof of flakiness
  });
  test("on, definite environment fault: rerun; green → cleared. Still the fault → PM, nobody pinned by tests that never ran", async () => {
    const ok = make("on");
    ok.hub.log = () => ENV_LOG;
    await ok.firstVerdict();
    expect(ok.events("merge_train_ci_rerun")[0]).toMatchObject({ class: "env" });
    ok.settle();
    expect(shape(await ok.drive(done)).cleared).toEqual(["T1", "T9"]);

    const bad = make("on");
    bad.hub.log = () => ENV_LOG; bad.hub.red = () => true;
    await bad.firstVerdict();
    bad.settle();
    const s = await bad.drive(done);
    expect(shape(s)).toMatchObject({ bounced: [], cleared: [], serial: ["T1", "T9"], outcome: "serial" });
    expect([bad.hub.reruns.length, bad.hub.drafts.size]).toEqual([1, 1]);
    expect(bad.notices.find((n) => n.alarm)?.text).toMatch(/环境故障，测试没能跑完（重跑后仍是 安装\/下载失败：ConnectionRefused.*actions\/runs\/\d+）/);
  });
  test("observe: the same bisect as before, and exactly one would-be action per car however often it is asked", async () => {
    const base = make(null), env = make("observe");
    const want = shape(await base.drive(done)), s = await env.drive(done);
    expect(shape(s)).toEqual({ ...want, cars: want.cars.map((c) => c.replace(base.store.load("p")!.id, s.id)) });
    expect(env.hub.reruns).toEqual([]);
    expect(env.events("merge_train_ci_rerun")).toEqual([]);
    const notes = env.events("recovery_observe").filter((e) => e.mechanism === "ciTrainFailureClass");
    expect(notes.map((e) => e.car)).toEqual(s.cars.filter((c) => c.status !== "new").map((c) => c.id)); // every car that ran red, once
    expect(notes[0]!.text).toContain("判为没碰的测试超时");
    env.port.observe("p", s.id, s.id, "again", {}); // a retried tick records nothing new
    expect(env.events("recovery_observe").length).toBe(notes.length);
  });
});

describe("[验收线 2] no eligibility, no rerun: the red is bisected as before", () => {
  const cases: [string, (env: Env) => void][] = [
    ["the list entry's fixing node is verified", (env) => { env.hub.log = () => FLAKY_LOG; env.listFlaky()("verified"); }],
    ["the failing file is not on the list", (env) => { env.hub.log = () => FLAKY_LOG; env.listFlaky("tests/other.test.ts"); }],
    ["a member (not the first) touches the timed-out test file", (env) => { env.hub.files.set(env.cards[1]!.prRef, ["src/a.ts", SLOW]); }],
    ["a member touches the known flaky file", (env) => { env.hub.log = () => FLAKY_LOG; env.listFlaky(); env.hub.files.set(T9_PR, [FLAKY]); }],
    ["an environment signature mixed with a test failure", (env) => { env.hub.log = () => `${ENV_LOG}\n${FLAKY_LOG}`; env.listFlaky(); }],
    ["an unknown log", (env) => { env.hub.log = () => UNKNOWN_LOG; }],
    ["the run was already re-run by someone (PM's manual rerun)", manualRerun],
    ["a runner shutdown in a step that also holds an import error and an error between tests", (env) => { env.hub.log = () => lines("test shard 1 of 4", "Unit tests",
      ["error: Cannot find module './gone' from 'tests/changed.test.ts'", "# Unhandled error between tests", "##[error]The runner has received a shutdown signal."]); }],
    ["an install network error in a car whose member changes package.json", (env) => { env.hub.log = () => ENV_LOG; env.hub.files.set(T9_PR, ["package.json"]); }],
    ["an install line that carries the network error and another failure (a registry 404) at once", (env) => { env.hub.log = () => lines("test shard 1 of 4",
      "Install dependencies", ["npm ERR! code ECONNRESET; 404 Not Found - GET https://registry.npmjs.org/nope", "##[error]Process completed with exit code 1."]); }],
  ];
  for (const mode of ["on", "observe"] as const) {
    test.each(cases)(`${mode}: %s → no rerun, no claim, no would-be action; split`, async (_name, arrange) => {
      const env = make(mode);
      arrange(env);
      const s = await env.firstVerdict();
      expect(car0(s).status).toBe("split");
      expect([env.hub.reruns.length, env.events("merge_train_ci_rerun").length, env.events("recovery_observe").length]).toEqual([0, 0, 0]);
    });
  }
  test("an entry verified between the read and the claim is refused inside the claim's transaction", () => {
    const env = make("on"), verified = env.listFlaky();
    const claim = { project: "p", train: "t", car: "t", base: BASE, members: env.cards.map((c) => ({ taskId: c.taskId, head: c.head })), run: runUrl(501), attempt: 1,
      kind: "known_flaky" as const, files: [FLAKY], reason: "r" };
    expect(env.port.listed("p", [FLAKY])).toEqual([`${FLAKY}（${getFeature(env.db, env.events("ci_known_flaky_add")[0]!.featureId)!.id}/FIX1）`]);
    verified("verified");
    expect(env.port.claim(claim)).toBe("unlisted");
    expect(env.events("merge_train_ci_rerun")).toEqual([]);
  });
});

describe("[验收线 3] at most one rerun per content, whatever happens around the claim", () => {
  test("two processes stepping the same red car: one claim, one rerun; the other bisects", async () => {
    const env = make("on");
    await env.tick(); await env.tick();
    const [a, b] = [env.store.load("p")!, env.store.load("p")!];
    await Promise.all([stepTrain(a, env.deps), stepTrain(b, env.deps)]);
    expect(env.hub.reruns.length).toBe(1);
    expect(env.events("merge_train_ci_rerun").length).toBe(2); // one note per member, from the one claim
    expect([car0(a).status, car0(b).status].sort()).toEqual(["ci", "split"]);
  });
  test("restart between the claim and the rerun call: the claim is found, nothing is sent; held within the settle window, then bisected", async () => {
    const env = make("on");
    await env.tick(); const s0 = (await env.tick())!;
    const members = env.cards.map((c) => ({ taskId: c.taskId, head: c.head }));
    expect(env.port.claim({ project: "p", train: s0.id, car: s0.id, base: BASE, members, run: runUrl(env.hub.runs.at(-1)!.id), attempt: 1, kind: "timeout",
      files: [SLOW], reason: "r" })).toBe("claimed");
    expect(env.port.claimOf("p", s0.id, s0.id)).toMatchObject({ attempt: 1, kind: "timeout", content: contentKey(BASE, members) });
    expect(car0((await env.tick())!).status).toBe("ci");
    env.clock.t += RERUN_SETTLE_MS + 1;
    expect(car0((await env.tick())!).status).toBe("split");
    expect(env.hub.reruns).toEqual([]);
  });
  test("switched to observe while a claimed rerun is awaited: no waiting, the red is bisected at once, no would-be action", async () => {
    const env = make("on");
    env.hub.lag = true;
    expect(car0(await env.firstVerdict()).status).toBe("ci");
    env.policy.mode = "observe";
    expect(car0((await env.tick())!).status).toBe("split");
    expect([env.hub.reruns.length, env.events("recovery_observe").length]).toEqual([1, 0]);
  });
  test("the rerun call fails: the budget is spent, no second call, bisected at once; its halves cannot rerun either", async () => {
    const env = make("on");
    env.hub.rerunFails = true; env.hub.red = () => true;
    expect(car0(await env.firstVerdict()).status).toBe("split");
    env.hub.rerunFails = false;
    const s = await env.drive(done);
    expect(env.hub.reruns.length).toBe(1);
    expect(shape(s).bounced).toEqual(["T1", "T9"]);
  });
  test("GitHub still shows the old attempt after the rerun: waits, never judges the old red; the new attempt red → bisect, one rerun in all", async () => {
    const env = make("on");
    env.hub.lag = true; env.hub.red = () => true;
    await env.firstVerdict();
    for (let i = 0; i < 3; i++) expect(car0((await env.tick())!).status).toBe("ci"); // checks still red, attempt still 1
    env.settle();
    expect(car0((await env.tick())!).status).toBe("split");
    expect(env.hub.reruns.length).toBe(1);
  });
  test("drift voids the evidence: main moves during the rerun → void; the same heads in a new train have no budget left", async () => {
    const env = make("on");
    env.hub.red = () => true;
    await env.firstVerdict();
    env.hub.main = "e".repeat(40);
    const first = await env.drive((s) => s.phase === "done");
    expect(first.outcome).toBe("void");
    const s = await env.drive((x) => x.id !== first.id && car0(x).status !== "ci" && car0(x).status !== "new" && car0(x).status !== "assemble");
    expect(car0(s).status).toBe("split");
    expect(env.hub.reruns.length).toBe(1);
  });
  test("a claim for other content is no evidence for this car", async () => {
    const env = make("on");
    env.hub.red = () => true;
    await env.tick(); const s0 = (await env.tick())!;
    env.port.claim({ project: "p", train: s0.id, car: s0.id, base: "a".repeat(40), members: [{ taskId: "T1", head: "9".repeat(40) }], run: runUrl(501), attempt: 1,
      kind: "timeout", files: [SLOW], reason: "r" });
    expect(car0((await env.tick())!).status).toBe("split");
  });
});

describe("[验收线 4] next to the serial gate, TRAINHANG and the PM", () => {
  const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });
  /** The serial gate on T9: its own PR CI red with an untouched timeout (CIF1 would re-run it once). */
  function serial(env: Env) {
    env.db.query("UPDATE scheduler_merges SET phase='await_ci', mergeSha=NULL WHERE intentId=?").run(env.intent);
    const calls: string[] = [], RUN = "https://github.com/example/repo/actions/runs/77";
    const ciRerun: CiRerunGh = { runAttempt: async () => ({ attempt: 1, status: "completed", conclusion: "failure", headSha: T9_HEAD }), failedLog: async () => TIMEOUT_LOG,
      prFiles: async () => ["src/lib/x.ts"], rerunFailed: async () => { calls.push("rerun"); } };
    const snap: PrSnapshot = { state: "OPEN", head: T9_HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false, mergeState: "UNSTABLE",
      mergeSha: null, checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/9` }] };
    const external = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }), carryReview: async () => ({ ok: false, reason: "不沿用" }),
      updateBranch: async () => {}, merge: async () => { throw new Error("不该合并"); }, ciRerun } as MergeExternal;
    return { calls, tick: () => schedulerMergeTick(env.db, config, ledgerAs(env.db, "scheduler", () => 200), () => external),
      phase: () => getMergeRun(env.db, env.intent)?.phase as string };
  }
  test("a head a train car spent its rerun on: the serial gate (CIF1) bounces its red, no second rerun", async () => {
    const env = make("on"), gate = serial(env);
    await env.firstVerdict();
    expect(env.hub.reruns.length).toBe(1);
    await gate.tick(); await gate.tick();
    expect([gate.calls, gate.phase()]).toEqual([[], "resolved"]);
  });
  test("a head the serial gate already re-ran: its train car gets no rerun (on) and no would-be action (observe)", async () => {
    for (const mode of ["on", "observe"] as const) {
      const env = make(mode), gate = serial(env);
      await gate.tick();
      expect([gate.calls, gate.phase()]).toEqual([["rerun"], "await_ci"]);
      expect(car0(await env.firstVerdict()).status).toBe("split");
      expect([env.hub.reruns.length, env.events("merge_train_ci_rerun").length, env.events("recovery_observe").length]).toEqual([0, 0, 0]);
    }
  });
  test("on, environment fault on heads whose budget is spent: PM, not a bisect over tests that never ran", async () => {
    const env = make("on"), gate = serial(env);
    await gate.tick();
    env.hub.log = () => ENV_LOG;
    const s = await env.firstVerdict();
    expect(shape(s)).toMatchObject({ bounced: [], outcome: "serial" });
    expect(env.hub.reruns).toEqual([]);
  });
  test("PM's manual rerun spends the heads' budget durably: the car's halves and the serial gate get no rerun; observe writes nothing", async () => {
    const env = make("on"), gate = serial(env);
    manualRerun(env);
    expect(car0(await env.firstVerdict()).status).toBe("split");
    const runId = env.hub.runs[1]!.id;
    expect(env.events("merge_train_ci_rerun_seen").map((e) => [e.target, e.prHead, e.run, e.attempt])).toEqual(env.cards.map((c) => [c.taskId, c.head, runUrl(runId), 2]));
    expect(env.port.spent(env.cards.map((c) => ({ taskId: c.taskId, head: c.head })))).toBe("T9");
    expect(env.port.claimOf("p", env.store.load("p")!.id, env.store.load("p")!.id)).toBeNull(); // never read as the car's own claim
    const s = await env.drive(done); // the halves are fresh attempt-1 runs with an eligible log: still no rerun
    expect([env.hub.reruns, shape(s).bounced, env.events("merge_train_ci_rerun").length]).toEqual([[], ["T1", "T9"], 0]);
    await gate.tick(); await gate.tick();
    expect([gate.calls, gate.phase()]).toEqual([[], "resolved"]);

    const obs = make("observe");
    manualRerun(obs);
    await obs.drive(done);
    expect([obs.events("merge_train_ci_rerun_seen").length, obs.port.spent([{ taskId: "T9", head: T9_HEAD }])]).toEqual([0, null]);
  });
  test("PM's manual rerun that went green spends the heads' budget too: a train formed again from those heads gets no rerun; observe reads nothing", async () => {
    const env = make("on"), heads = env.cards.map((c) => ({ taskId: c.taskId, head: c.head }));
    manualRerun(env, false);
    expect(car0(await env.firstVerdict()).status).toBe("green");
    expect(env.events("merge_train_ci_rerun_seen").map((e) => [e.target, e.prHead, e.run, e.attempt]))
      .toEqual(env.cards.map((c) => [c.taskId, c.head, runUrl(env.hub.runs[1]!.id), 2]));
    expect(env.port.spent(heads)).toBe("T9");
    env.hub.main = "e".repeat(40); // main moves: the train is void, the same heads form a new one whose first run is an eligible red
    const first = await env.drive((s) => s.phase === "done");
    expect(first.outcome).toBe("void");
    const s = await env.drive((x) => x.id !== first.id && !["new", "assemble", "ci"].includes(car0(x).status));
    expect([car0(s).status, env.hub.reruns, env.events("merge_train_ci_rerun").length]).toEqual(["split", [], 0]);

    const obs = make("observe");
    manualRerun(obs, false);
    const asked: number[] = [], attempt = obs.gh.runAttempt;
    obs.gh.runAttempt = async (r, id, b) => { asked.push(id); return attempt(r, id, b); };
    expect(car0(await obs.firstVerdict()).status).toBe("green");
    expect([asked, obs.events("merge_train_ci_rerun_seen").length, obs.port.spent(heads)]).toEqual([[], 0, null]);
  });
  test("on, a green car whose run cannot be read is green all the same (nothing stalls), and a red one's log is not needed to see the manual rerun", async () => {
    const env = make("on");
    manualRerun(env, false);
    env.hub.attemptFails = true;
    expect(car0(await env.firstVerdict()).status).toBe("green");
    const red = make("on");
    manualRerun(red);
    red.gh.failedLog = async () => { throw new Error("失败日志太长，可能被截断"); };
    expect(car0(await red.firstVerdict()).status).toBe("split");
    expect(red.events("merge_train_ci_rerun_seen").length).toBe(2);
  });
  test("a manually re-run run still failing in the environment: PM (on), never a bisect over tests that did not run; observe bisects as before", async () => {
    const env = make("on");
    manualRerun(env);
    env.hub.log = () => ENV_LOG;
    const s = await env.firstVerdict();
    expect(shape(s)).toMatchObject({ bounced: [], cleared: [], serial: ["T1", "T9"], outcome: "serial" });
    expect([env.hub.reruns.length, env.hub.drafts.size, env.events("merge_train_ci_rerun_seen").length]).toEqual([0, 1, 2]);
    expect(env.notices.find((n) => n.alarm)?.text).toMatch(/环境故障，测试没能跑完（安装\/下载失败：ConnectionRefused.*run 已被重跑过（第 2 次））/);
    const obs = make("observe");
    manualRerun(obs);
    obs.hub.log = () => ENV_LOG;
    expect(car0(await obs.firstVerdict()).status).toBe("split");
  });
  test("a rerun awaited behind checks that still show red (stale, or failed next to a hung job) ends at the car timeout as well", async () => {
    const env = make("on");
    env.hub.stale = true;
    const deps: TrainDeps = { ...env.deps, ciTimeout: { mode: () => "on", observe: () => {} } };
    let s = await env.firstVerdict(deps);
    const started = car0(s).startedAt, runId = env.hub.runs.at(-1)!.id;
    expect([car0(s).status, env.run(runId).shown, env.run(runId).status]).toEqual(["ci", "fail", "in_progress"]);
    env.clock.t = started + 60 * MIN;
    s = (await env.tick(deps))!;
    expect([car0(s).status, car0(s).timeout, env.hub.cancels]).toEqual(["ci", undefined, []]);
    env.clock.t = started + 61 * MIN;
    s = (await env.tick(deps))!;
    expect([car0(s).timeout?.cancel, car0(s).timeout?.checks.map((c) => c.name), env.hub.cancels, car0(s).startedAt]).toEqual(["pending", ["check"], [runId], started]);
    expect(env.run(90).status).toBe("in_progress");
    s = await env.drive((x) => car0(x).status !== "ci", deps);
    expect([car0(s).status, env.hub.reruns.length]).toEqual(["split", 1]); // TRAINHANG's own path: confirmed cancel, diagnosis, the same split

    // trainCiTimeout not on: nothing is cancelled, the wait just ends. Red → the first red stands (bisect); an unconfirmed green → PM.
    const off = make("on"), green = make("on");
    off.hub.stale = green.hub.stale = true;
    for (const e of [off, green]) { s = await e.firstVerdict(); e.clock.t = car0(s).startedAt + 61 * MIN; }
    expect([car0((await off.tick())!).status, off.hub.cancels]).toEqual(["split", []]);
    green.run(green.hub.runs.at(-1)!.id).shown = "pass";
    expect(shape((await green.tick())!)).toMatchObject({ cleared: [], bounced: [], outcome: "serial" });
  });
  test("TRAINHANG keeps its clock: a rerun that hangs is cancelled at the car timeout counted from the car's start, this car's run only", async () => {
    const env = make("on");
    const deps: TrainDeps = { ...env.deps, ciTimeout: { mode: () => "on", observe: () => {} } };
    let s = await env.firstVerdict(deps);
    const started = car0(s).startedAt, runId = env.hub.runs.at(-1)!.id;
    env.clock.t = started + 61 * MIN;
    s = (await env.tick(deps))!;
    expect(car0(s).timeout?.cancel).toBe("pending");
    expect([env.hub.cancels, car0(s).startedAt, s.startedAt]).toEqual([[runId], started, 1_000]);
    expect(env.run(90).status).toBe("in_progress"); // an author PR's run is never touched
    s = await env.drive((x) => car0(x).status !== "ci", deps);
    expect(car0(s).status).toBe("split"); // the timeout path itself is unchanged: confirmed cancel, then the same split
    expect(env.hub.reruns.length).toBe(1);
  });
  test("a red check while the run is still going: on waits for it only inside RUN_FINISH_WAIT_MS of the car's start, observe never waits", async () => {
    const env = make("on");
    env.hub.firstStatus = "in_progress";
    let s = await env.firstVerdict();
    expect([car0(s).status, env.hub.reruns.length]).toEqual(["ci", 0]);
    env.clock.t = car0(s).startedAt + RUN_FINISH_WAIT_MS;
    s = (await env.tick())!;
    expect([car0(s).status, env.hub.reruns.length]).toEqual(["split", 0]);
    const obs = make("observe");
    obs.hub.firstStatus = "in_progress";
    expect(car0(await obs.firstVerdict()).status).toBe("split");
  });
});

describe("PM 补: a missing port or a failing classification never stalls a car or changes off / observe", () => {
  const broken: [string, Partial<TrainCiClassPort>, (env: Env) => void][] = [
    ["the policy read throws", { mode: () => { throw new Error("policy"); } }, () => {}],
    ["the claim lookup throws", { claimOf: () => { throw new Error("db"); } }, () => {}],
    ["the budget read throws", { spent: () => { throw new Error("db"); } }, () => {}],
    ["the observe write throws", { observe: () => { throw new Error("db"); } }, () => {}],
    ["the manual rerun record throws", { seen: () => { throw new Error("db"); } }, manualRerun],
    ["the run cannot be read", {}, (env) => { env.hub.attemptFails = true; }],
    ["the failed log cannot be read", {}, (env) => { env.gh.failedLog = async () => { throw new Error("失败日志太长，可能被截断"); }; }],
    ["the gh has no run calls", {}, (env) => { delete (env.gh as Partial<TrainRerunGh>).rerunFailed; }],
  ];
  for (const mode of ["on", "observe", "off"] as const) {
    test.each(broken)(`${mode}: %s → the same bisect as without the port`, async (_name, over, arrange) => {
      const base = make(null), env = make(mode, 2, over);
      base.hub.red = env.hub.red = () => true;
      arrange(env);
      // on with a port that still works for a rerun (only its observe is broken) re-runs once; the rerun ends red like everything here
      const settled = (x: TrainState) => { env.settle(); return done(x); };
      const want = shape(await base.drive(done)), s = await env.drive(settled);
      expect(shape(s)).toEqual({ ...want, cars: want.cars.map((c) => c.replace(base.store.load("p")!.id, s.id)) });
      if (mode === "off" || over.mode) expect(env.hub.reruns).toEqual([]);
    });
  }
  test("off: nothing is read, written or sent", async () => {
    const env = make("off");
    let asked = 0;
    env.gh.runAttempt = async () => { asked++; throw new Error("never"); };
    expect(car0(await env.firstVerdict()).status).toBe("split");
    expect([asked, env.hub.reruns.length, env.events("recovery_observe").length]).toEqual([0, 0, 0]);
  });
});

describe("the gh calls stay on the car's own train branch", () => {
  const gh = (answer: (argv: string[]) => string) => {
    const seen: string[][] = [];
    return { seen, gh: trainGh((async (argv: string[]) => { seen.push(argv); return { code: 0, stdout: answer(argv), stderr: "", timedOut: false }; }) as never) };
  };
  const view = (over: object) => JSON.stringify({ id: 77, status: "completed", conclusion: "failure", head_branch: "train/1-abc", run_attempt: 1, ...over });
  test("runAttempt: the run's attempt, only for a run on that train branch", async () => {
    expect(await gh(() => view({})).gh.runAttempt(REPO, 77, "train/1-abc")).toEqual({ attempt: 1, status: "completed", conclusion: "failure" });
    await expect(gh(() => view({ head_branch: "feat/x" })).gh.runAttempt(REPO, 77, "train/1-abc")).rejects.toThrow("不在 train/1-abc 上");
    await expect(gh(() => view({ head_branch: "main" })).gh.runAttempt(REPO, 77, "main")).rejects.toThrow("拒绝操作非列车分支");
    await expect(gh(() => view({ run_attempt: null })).gh.runAttempt(REPO, 77, "train/1-abc")).rejects.toThrow("attempt / 状态输出无效");
  });
  test("rerunFailed re-runs the failed jobs of that run id; failedLog refuses a log that may be cut", async () => {
    const g = gh(() => "");
    await g.gh.rerunFailed(REPO, 77);
    expect(g.seen).toEqual([["gh", "run", "rerun", "77", "--failed", "-R", REPO]]);
    await expect(gh(() => "x".repeat(900 * 1024)).gh.failedLog(REPO, 77)).rejects.toThrow("可能被截断");
    expect(await gh(() => "job\tstep\tline").gh.failedLog(REPO, 77)).toBe("job\tstep\tline");
  });
});
