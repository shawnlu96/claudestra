/**
 * merge-arch-SELECT4: a train run that fails a test file a member's frozen read-map plan did not select lowers CI_IO_MAP from on to
 * observe. Real train engine (formTrain / stepTrain) and real wiring on a fake GitHub (train runs with attempts, PR runs with a
 * scope check, a plan artifact and the repository variable), a fake clock and a real ledger in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { planDigest, type CiPlan } from "../scripts/ci-related-plan.ts";
import { evidenceKey, type CiIoMapFuseGh, type FuseEvidence, type FuseJob, type FuseRun } from "../src/lib/ci-io-map-fuse.js";
import { fuseLedger } from "../src/lib/ci-io-map-fuse-ledger.js";
import { ciIoMapFuseHook, resetFuseMemory, type FusePort } from "../src/lib/ci-io-map-fuse-run.js";
import { ciIoMapFuse } from "../src/lib/ci-io-map-fuse-wiring.js";
import { getTask } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { RECOVERY_KEYS, recoveryPolicy, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { formTrain, stepTrain, type TrainCar, type TrainCheck, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";
import type { TrainRerunGh } from "../src/lib/scheduler-train-ci-rerun.js";
import { trainCiClassPort } from "../src/lib/scheduler-train-ci-rerun-state.js";
import { mergedCard } from "./deploy-test-kit.js";

const REPO = "example/repo", BASE = "f".repeat(40), MAP = "e".repeat(40), MIN = 60_000, CI = ".github/workflows/ci.yml";
const F = "tests/hole.test.ts", OTHER = "tests/a.test.ts";
const owner = { actor: "owner", now: 150 };
const runUrl = (id: number) => `https://github.com/${REPO}/actions/runs/${id}`;
const lines = (job: string, step: string, ls: string[]) => ls.map((l) => `${job}\t${step}\t2026-10-12T09:00:00.1234567Z ${l}`).join("\n");
const unit = (ls: string[]) => lines("test shard 1 of 8", "Unit tests", [...ls, " 1999 pass", " 1 fail", "##[error]Process completed with exit code 1."]);
const FAIL_LOG = unit([`##[group]${F}:`, "error: expect(received).toBe(expected)", "(fail) hole > case [0.40ms]", "##[endgroup]"]);
const TIMEOUT_LOG = unit([`##[group]${F}:`, "(fail) hole > case [5000.00ms]", "  ^ this test timed out after 5000ms.", "##[endgroup]"]);
const GUARD_LOG = lines("test shard 1 of 8", "Guard (ratchets)", ["guard red", "##[error]Process completed with exit code 1."]);

interface Attempt { status: string; conclusion: string }
interface TrainRun { id: number; branch: string; head: string; attempts: Attempt[] }
type Card = { taskId: string; prRef: string; head: string };
const plan = (head: string, over: Partial<CiPlan> = {}): CiPlan => ({ version: 1, event: "pull_request", sha: "9".repeat(40), mode: "on", scope: "related", reasons: [],
  tests: [OTHER], shards: [[OTHER]], proposed: 1, picked: 1, universe: 9,
  ioMap: { mode: "on", used: true, sha: MAP, generatedAt: "2026-10-12T00:00:00Z", proposed: 1, picked: 1, reasons: [] }, prHead: head, ...over });

/** GitHub: train drafts get one run whose first attempt is red when `red` says so; PR runs are registered by the test. */
function fakeHub() {
  const hub = {
    main: BASE, prs: new Map<string, string>(), branches: new Map<string, string[]>(), drafts: new Map<number, string>(), trainRuns: new Map<number, TrainRun>(),
    nextRun: 500, red: ((_heads) => true) as (heads: string[]) => boolean, log: ((_run, _attempt) => FAIL_LOG) as (run: number, attempt: number) => string,
    prRuns: [] as FuseRun[], jobs: new Map<number, FuseJob[]>(), jobLogs: new Map<number, string>(), plans: new Map<number, string>(),
    value: "on" as string | null, writes: 0, reads: [] as string[], reruns: [] as number[],
    lower: (async () => { hub.value = "observe"; }) as () => Promise<void>,
  };
  const trainRun = (id: number) => { const r = hub.trainRuns.get(id); if (!r) throw new Error("HTTP 404"); return r; };
  const asRun = (r: TrainRun, n = r.attempts.length): FuseRun => ({ id: r.id, attempt: n, ...r.attempts[n - 1]!, branch: r.branch, head: r.head, path: CI,
    event: "pull_request", repo: REPO, headRepo: REPO, prs: [] });
  const seen = <T>(name: string, v: T): T => { hub.reads.push(name); return v; };
  const fuse: CiIoMapFuseGh = {
    ciRun: async (_r, id, attempt) => seen("ciRun", asRun(trainRun(id), attempt)),
    headRuns: async (_r, head) => seen("headRuns", hub.prRuns.filter((r) => r.head === head)),
    attemptJobs: async (_r, id) => seen("attemptJobs", hub.jobs.get(id) ?? []),
    attemptFailedLog: async (_r, id, attempt) => seen("attemptFailedLog", hub.log(id, attempt)),
    jobLog: async (_r, job) => seen("jobLog", { text: hub.jobLogs.get(job) ?? "", truncated: false }),
    planArtifact: async (_r, id) => { hub.reads.push("planArtifact"); const t = hub.plans.get(id); if (t === undefined) throw new Error("no artifact found"); return t; },
    ioMapVar: async () => seen("ioMapVar", hub.value),
    lowerIoMapVar: async () => { hub.writes++; await hub.lower(); },
  };
  const gh: TrainGh & TrainRerunGh & CiIoMapFuseGh = {
    ...fuse,
    mainHead: async () => hub.main,
    prFiles: async (pr) => [`src/pr${pr.split("/").pop()}.ts`],
    prHead: async (pr) => hub.prs.get(pr)!,
    createBranch: async (_r, b) => { hub.branches.set(b, []); },
    mergeInto: async (_r, b, head) => { hub.branches.get(b)!.push(head); return "merged"; },
    openDraft: async (_r, b) => {
      const n = 1000 + hub.drafts.size, id = ++hub.nextRun, red = hub.red(hub.branches.get(b)!);
      hub.drafts.set(n, b);
      hub.trainRuns.set(id, { id, branch: b, head: "7".repeat(40), attempts: [{ status: "completed", conclusion: red ? "failure" : "success" }] });
      return n;
    },
    checks: async (_r, n): Promise<TrainCheck[]> => {
      const r = [...hub.trainRuns.values()].find((x) => x.branch === hub.drafts.get(n))!, last = r.attempts.at(-1)!;
      return [{ name: "check", bucket: last.status !== "completed" ? "pending" : last.conclusion === "success" ? "pass" : "fail", link: `${runUrl(r.id)}/job/${r.id}1` }];
    },
    failLog: async () => "FAIL boom",
    parents: async () => ["1".repeat(40)],
    mergeMatchHead: async () => "2".repeat(40),
    closePr: async () => {},
    deleteBranch: async () => {},
    runAttempt: async (_r, id) => { const r = trainRun(id); return { attempt: r.attempts.length, ...r.attempts.at(-1)! }; },
    failedLog: async (_r, id) => hub.log(id, trainRun(id).attempts.length),
    rerunFailed: async (_r, id) => { hub.reruns.push(id); trainRun(id).attempts.push({ status: "completed", conclusion: "success" }); },
  };
  /** A successful PR run of `card` on its head whose scope check printed the digest of `p` and whose artifact is `p` (or `artifact`). */
  const prRun = (card: Card, p: CiPlan, over: Partial<FuseRun> = {}, artifact: string | null = JSON.stringify(p, null, 1), scope = `ci scope ${p.scope}`) => {
    const id = ++hub.nextRun;
    hub.prRuns.push({ id, attempt: 1, status: "completed", conclusion: "success", branch: "task/x", head: card.head, path: CI, event: "pull_request", repo: REPO,
      headRepo: REPO, prs: [Number(card.prRef.split("/").pop())], ...over });
    hub.jobs.set(id, [{ id: id * 10, name: scope, status: "completed", conclusion: "success" }, { id: id * 10 + 1, name: "test shard 1 of 8", status: "completed", conclusion: "success" }]);
    hub.jobLogs.set(id * 10, `2026-10-12T09:00:00Z ##[group]Run echo "scope=${p.scope} plan=${planDigest(p)}"\n2026-10-12T09:00:01Z scope=${p.scope} plan=${planDigest(p)}`);
    if (artifact !== null) hub.plans.set(id, artifact);
    return id;
  };
  return { hub, gh, prRun };
}

function memStore(): TrainStore & { events: TrainEvent[] } {
  let state: TrainState | null = null, seq = 0;
  const events: TrainEvent[] = [];
  return { events, load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); seq = Math.max(seq, s.seq); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => seq + 1 };
}

/** Cards T9 (the kit's merge card) and T1..; `mode` null = the train without the hook (the wiring before this card). */
function setup(mode: RecoveryMode | null, count = 2) {
  const c = mergedCard(), f = fakeHub(), clock = { t: 1_000_000 }, policy = { mode: mode ?? "off" }, store = memStore();
  const cards: Card[] = Array.from({ length: count }, (_, i) => {
    const taskId = i ? `T${i}` : "T9", prRef = `https://github.com/${REPO}/pull/${i || 7}`, head = i ? String(i).repeat(40) : "c".repeat(40);
    if (i) createTask(c.db, owner, { project: "p", id: taskId, title: taskId, kind: "code" });
    f.hub.prs.set(prRef, head);
    return { taskId, prRef, head };
  });
  const notices: string[] = [], pmFails = { n: 0 };
  const io = { now: () => clock.t, notifyPm: async (task: { project: string }, text: string) => {
    if (pmFails.n-- > 0) throw new Error("bridge down");
    notices.push(`${task.project}|${text}`);
  } };
  const hook = ciIoMapFuse(c.db, f.gh, io, () => ({ mode: policy.mode, manualAfterMs: null, source: "config" }), () => REPO)!;
  const deps: TrainDeps = { gh: f.gh, store, now: () => clock.t, requiredChecks: ["check"], memberStatus: () => ({ kind: "waiting" }),
    notify: async () => {}, ...(mode ? { ioMapFuse: hook } : {}) };
  const tick = async (d: TrainDeps = deps) => {
    const live = store.load("p");
    return live && live.phase !== "done" ? stepTrain(live, d) : formTrain("p", cards, d);
  };
  const drive = async (d: TrainDeps = deps) => {
    for (let i = 0; i < 40; i++) { const s = await tick(d); if (s && s.phase !== "testing") return s; }
    throw new Error("train never stopped");
  };
  /** Ticks until the first car's checks were judged once. */
  const firstVerdict = async (d: TrainDeps = deps) => { await tick(d); await tick(d); return (await tick(d))!; };
  const events = (step?: string) => (c.db.query("SELECT text, data, dedupKey FROM events ORDER BY seq").all() as { text: string; data: string; dedupKey: string }[])
    .map((e) => ({ text: e.text, dedupKey: e.dedupKey, ...JSON.parse(e.data) })).filter((e) => (step ? e.op === "ci_io_map_fuse" && e.step === step : true));
  /** A red verdict of a car the test builds itself: the hook asked directly, as stepTesting asks it. */
  const direct = (members: Card[] = cards, runId = 900, h = hook) => {
    if (!f.hub.trainRuns.has(runId)) f.hub.trainRuns.set(runId, { id: runId, branch: `train/d${runId}`, head: "7".repeat(40), attempts: [{ status: "completed", conclusion: "failure" }] });
    const s = { id: `d${runId}`, project: "p", repo: REPO, base: BASE, members: members.map((m) => ({ ...m, files: ["src/x.ts"] })) } as unknown as TrainState;
    const car = { id: `d${runId}`, members: members.map((m) => m.taskId), branch: `train/d${runId}` } as TrainCar;
    return h(s, car, [{ name: "check", bucket: "fail", link: `${runUrl(runId)}/job/1` }]);
  };
  return { ...c, ...f, cards, clock, policy, store, deps, notices, pmFails, hook, io, tick, drive, firstVerdict, events, direct };
}
type Env = ReturnType<typeof setup>;
const shape = (s: TrainState) => ({ cars: s.cars.map((c) => `${c.id.replace(s.id, "")}:${c.status}`), bounced: s.bounced.map((b) => b.taskId).sort(), outcome: s.outcome, ciRuns: s.ciRuns });
const envs: Env[] = [];
const make = (...a: Parameters<typeof setup>) => { const e = setup(...a); envs.push(e); return e; };
/** T1's frozen read-map plan on its exact head does not select F. */
const hole = (env: Env, card = env.cards[1]!) => env.prRun(card, plan(card.head));

beforeEach(() => { setTrainModeSource(() => "on"); resetFuseMemory(); });
afterEach(() => { setTrainModeSource(null); for (const e of envs.splice(0)) e.close(); });

describe("[验收线 1] a real red train car with a read-map omission lowers CI_IO_MAP once, confirms it and tells PM", () => {
  test("先红: the train without the hook bisects the same red and never touches the variable", async () => {
    const env = make(null);
    hole(env);
    expect((await env.firstVerdict()).cars[0]!.status).toBe("split");
    expect([env.hub.writes, env.hub.value, env.hub.reads, env.notices]).toEqual([0, "on", [], []]);
  });
  test("on, multi-member car: one write to observe, read back, one notice with the chain and no culprit; the train goes on as without the hook", async () => {
    const bare = make(null), env = make("on");
    for (const e of [bare, env]) { hole(e); e.hub.red = (heads) => heads.includes(e.cards[1]!.head); }
    const prRunId = env.hub.prRuns[0]!.id;
    await env.firstVerdict();
    expect([env.hub.writes, env.hub.value, env.notices.length]).toEqual([1, "observe", 1]);
    const text = env.notices[0]!, trainRunId = [...env.hub.trainRuns.keys()][0]!;
    for (const part of ["p|[CI_IO_MAP 熔断]", `${REPO} 的 CI_IO_MAP 已从 on 退回 observe`, "前值 on，后值 observe，写后读回确认", `${runUrl(trainRunId)}/attempts/1`, F,
      env.cards[1]!.prRef, env.cards[1]!.head.slice(0, 12), `${runUrl(prRunId)}/attempts/1`, planDigest(plan(env.cards[1]!.head)).slice(0, 19), MAP.slice(0, 12),
      "不指认是哪张卡造成的", "没有改 CI_RELATED_CHECKS", "不会自动再开 on"]) expect(text).toContain(part);
    expect(text).not.toMatch(/定位到|造成失败的是/);
    const done = env.events("done");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ result: "lowered", before: "on", after: "observe", evidence: { repo: REPO, project: "p", members: ["T9", "T1"], files: [F],
      run: { id: trainRunId, attempt: 1, head: "7".repeat(40) },
      omissions: [{ taskId: "T1", pr: 1, head: env.cards[1]!.head, runId: prRunId, attempt: 1, digest: planDigest(plan(env.cards[1]!.head)), mapSha: MAP, tests: [OTHER], omitted: [F] }] } });
    expect(env.events("sent")).toHaveLength(1);
    // the bisect, the bounce and the CI count are what they are without the hook; the halves find the variable already safe
    expect(shape(await env.drive())).toEqual(shape(await bare.drive()));
    expect([env.hub.writes, env.notices.length, env.events("done").map((e) => e.result).sort()]).toEqual([1, 1, ["already_safe", "lowered"]]);
  });
  test("on, single-member car: the half that holds the card is the one that proves it", async () => {
    const env = make("on");
    hole(env);
    env.hub.red = (heads) => heads.includes(env.cards[1]!.head);
    env.hub.log = (run) => (env.hub.trainRuns.get(run)!.branch.endsWith("b") ? FAIL_LOG : GUARD_LOG); // the full car's log names no test file
    const s = await env.drive();
    expect(s.bounced.map((b) => b.taskId)).toEqual(["T1"]);
    expect([env.hub.writes, env.hub.value, env.notices.length]).toEqual([1, "observe", 1]);
    expect(env.events("done")[0]).toMatchObject({ result: "lowered", evidence: { members: ["T1"], car: `${s.id}b` } });
    expect(env.events("skip")[0]!.why).toContain("定位不到失败的测试文件");
  });
  test("a red attempt that the classified re-run turns green is still judged, and the re-run budget is spent exactly once", async () => {
    const env = make("on");
    hole(env);
    env.hub.log = () => TIMEOUT_LOG;
    const d = { ...env.deps, ciClass: trainCiClassPort(env.db, () => env.clock.t, () => ({ mode: "on" as const, manualAfterMs: null, source: "config" as const })) };
    const s = await env.drive(d);
    expect(shape(s)).toMatchObject({ cars: [":green"], bounced: [], ciRuns: 1 });
    expect([env.hub.reruns.length, env.hub.writes, env.hub.value, env.notices.length]).toEqual([1, 1, "observe", 1]);
    expect(env.events("done")[0]).toMatchObject({ result: "lowered", evidence: { run: { attempt: 1 } } });
  });
});

describe("[验收线 2] anything short of an exact, trusted read-map omission writes nothing and says why", () => {
  const cases: [string, (env: Env, c: Card) => void, RegExp][] = [
    ["F was selected", (env, c) => env.prRun(c, plan(c.head, { tests: [OTHER, F] })), /都选了失败文件|全量|没有实际使用/],
    ["the PR plan was full", (env, c) => env.prRun(c, plan(c.head, { scope: "full", tests: [] })), /都选了失败文件|全量/],
    ["CI_IO_MAP was observe in the plan", (env, c) => env.prRun(c, plan(c.head, { ioMap: { ...plan(c.head).ioMap!, mode: "", used: false } })), /没有实际使用/],
    ["the map fell back to the old rules", (env, c) => env.prRun(c, plan(c.head, { ioMap: { ...plan(c.head).ioMap!, used: false, sha: null } })), /没有实际使用/],
    ["the plan is bound to another head", (env, c) => env.prRun(c, plan("d".repeat(40))), /不是成员的 head/],
    ["the plan carries no PR head (the synthetic merge sha is not one)", (env, c) => env.prRun(c, plan(c.head, { prHead: undefined, sha: c.head })), /没有绑定 PR head/],
    ["the run belongs to another PR", (env, c) => env.prRun(c, plan(c.head), { prs: [99] }), /没有绑定到 PR #1/],
    ["the run is a fork's", (env, c) => env.prRun(c, plan(c.head), { headRepo: "evil/repo" }), /没有绑定到 PR #1/],
    ["the run is another repository's", (env, c) => env.prRun(c, plan(c.head), { repo: "other/repo" }), /没有绑定到 PR #1/],
    ["the run is of another workflow", (env, c) => env.prRun(c, plan(c.head), { path: ".github/workflows/nightly.yml" }), /没有绑定到 PR #1/],
    ["the run did not succeed", (env, c) => env.prRun(c, plan(c.head), { conclusion: "failure" }), /没有绑定到 PR #1/],
    ["only the PR's newest head has a plan", (env, c) => env.prRun({ ...c, head: "d".repeat(40) }, plan("d".repeat(40))), /没有绑定到 PR #1/],
    ["the artifact is not the plan the run froze", (env, c) => env.prRun(c, plan(c.head), {}, JSON.stringify(plan(c.head, { tests: [] }))), /digest .* 不是该次运行冻结的/],
    ["the scope check is missing", (env, c) => env.prRun(c, plan(c.head), {}, undefined, "something else"), /ci scope 检查有 0 个/],
  ];
  for (const [name, arrange, why] of cases) {
    test(`${name}: no write, no notice, the reason is on record or in the clean verdict`, async () => {
      const env = make("on"), logged: string[] = [], real = console.log;
      arrange(env, env.cards[1]!);
      console.log = (m: string) => { logged.push(m); };
      try { await env.direct([env.cards[1]!]); } finally { console.log = real; }
      expect([env.hub.writes, env.hub.value, env.notices, env.events("done"), env.events("try")]).toEqual([0, "on", [], [], []]);
      expect(logged.join("\n")).toMatch(why);
      const clean = /都选了失败文件/.test(logged.join("\n"));
      expect(env.events("skip").map((e) => why.test(e.why))).toEqual(clean ? [] : [true]);
    });
  }
  test("a cut log, a log without a test file, a missing artifact: no write; the reason is recorded once the case is given up", async () => {
    const cut = make("on"), guard = make("on"), gone = make("on");
    for (const e of [cut, guard]) hole(e);
    gone.prRun(gone.cards[1]!, plan(gone.cards[1]!.head), {}, null);
    cut.hub.log = () => { throw new Error("失败日志太长，可能被截断"); };
    guard.hub.log = () => GUARD_LOG;
    for (const e of [cut, guard, gone]) {
      resetFuseMemory(); // each env is its own process: the same run id must not read as settled
      for (let i = 0; i < 3; i++) { await e.direct([e.cards[1]!]); e.clock.t += 11 * MIN; }
      expect([e.hub.writes, e.hub.value, e.notices]).toEqual([0, "on", []]);
    }
    expect(cut.events("skip")[0]!.why).toContain("可能被截断");
    expect(guard.events("skip")[0]!.why).toContain("定位不到失败的测试文件");
    expect(gone.events("skip")[0]!.why).toContain("no artifact found");
    expect(gone.events("closed")).toHaveLength(1);
  });
  test("the run of the check is not this car's ci.yml run, or the train is not in the project's repository: nothing is read past it", async () => {
    const env = make("on");
    hole(env);
    env.hub.trainRuns.set(900, { id: 900, branch: "train/other", head: "7".repeat(40), attempts: [{ status: "completed", conclusion: "failure" }] });
    await env.direct();
    expect(env.hub.reads).toEqual(["ciRun"]);
    const foreign = ciIoMapFuse(env.db, env.gh, env.io, () => ({ mode: "on", manualAfterMs: null, source: "config" }), () => "example/elsewhere")!;
    env.hub.reads.length = 0;
    await env.direct(env.cards, 901, foreign);
    expect([env.hub.reads, env.hub.writes]).toEqual([[], 0]);
  });
  test("CI_IO_MAP already off / observe / unset: never set again, only recorded as already safe", async () => {
    for (const value of ["off", "observe", null]) {
      const env = make("on");
      hole(env);
      env.hub.value = value;
      resetFuseMemory();
      await env.direct();
      expect([env.hub.writes, env.hub.value, env.notices]).toEqual([0, value, []]);
      expect(env.events("done")).toMatchObject([{ result: "already_safe", before: value }]);
    }
  });
});

describe("[验收线 3] modes, repeats, two processes and crashes", () => {
  test("off (and an unreadable policy) reads nothing; observe records once what on would do and neither writes nor notifies", async () => {
    const off = make("off"), obs = make("observe");
    for (const e of [off, obs]) { hole(e); resetFuseMemory(); await e.direct([e.cards[1]!]); resetFuseMemory(); await e.direct([e.cards[1]!]); }
    expect([off.hub.reads, off.hub.writes, off.events().filter((e) => /熔断|ciIoMapFuse/.test(e.text))]).toEqual([[], 0, []]);
    expect([obs.hub.writes, obs.hub.value, obs.notices, obs.events("done"), obs.events("pending")]).toEqual([0, "on", [], [], []]);
    expect(obs.hub.reads).not.toContain("ioMapVar");
    const notes = obs.events().filter((e) => e.op === "recovery_observe" && e.mechanism === "ciIoMapFuse");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain(`本会 把 ${REPO} 的 CI_IO_MAP 从 on 退回 observe`);
    expect(notes[0]!.evidence.omissions[0]).toMatchObject({ taskId: "T1", omitted: [F] });
    expect(RECOVERY_KEYS.filter((k) => k === "ciIoMapFuse")).toHaveLength(1);
    expect(recoveryPolicy("p", "ciIoMapFuse", "/nonexistent/recovery-policy.json").mode).toBe("observe");
    // an observation of the same evidence does not stand in for the action: switched on, the same case still lowers
    obs.policy.mode = "on";
    await obs.direct([obs.cards[1]!]);
    expect([obs.hub.writes, obs.hub.value, obs.notices.length]).toEqual([1, "observe", 1]);
  });
  test("a repeated tick and a second process on the same evidence: one write, one notice", async () => {
    const env = make("on");
    hole(env);
    await env.direct(); await env.direct();
    resetFuseMemory(); // another process: nothing remembered, only the ledger
    await env.direct();
    expect([env.hub.writes, env.notices.length, env.events("done").length, env.events("sent").length]).toEqual([1, 1, 1, 1]);
  });
  test("two processes racing past the same `on`: the second write is the same safe value and only one notice goes out", async () => {
    const env = make("on");
    hole(env);
    const lower = env.hub.lower;
    env.hub.lower = async () => { env.hub.lower = lower; resetFuseMemory(); await env.direct(); await lower(); };
    env.hub.value = "on";
    await env.direct();
    expect([env.hub.value, env.notices.length, env.events("done").length]).toEqual(["observe", 1, 1]);
  });
  test("a crash after the write and before the record: the next pass reads observe, settles it and does not write again", async () => {
    const env = make("on");
    hole(env);
    env.hub.lower = async () => { env.hub.value = "observe"; throw new SchedulerStopped("lease lost"); };
    await expect(env.direct()).rejects.toBeInstanceOf(SchedulerStopped);
    expect([env.hub.writes, env.notices, env.events("done"), env.events("try").length]).toEqual([1, [], [], 1]);
    resetFuseMemory();
    await env.direct();
    expect([env.hub.writes, env.notices.length]).toEqual([1, 1]);
    expect(env.events("done")).toMatchObject([{ result: "settled", before: "on", after: "observe" }]);
    expect(env.notices[0]).toContain("此前已发出写入，这次读到 observe 结清");
  });
  test("the success record fails to land: the case stays open and a later red verdict of the project settles it", async () => {
    const env = make("on");
    hole(env);
    const ledger = fuseLedger(env.db, env.io.now), fails = { n: 1 };
    const port: FusePort = { gh: env.gh, ledger: { ...ledger, done: (...a) => { if (fails.n-- > 0) throw new Error("database is locked"); return ledger.done(...a); } },
      now: env.io.now, projectRepo: () => REPO, mode: () => "on", pm: async (_p, members, text) => env.io.notifyPm(getTask(env.db, members[0]!)!, text) };
    await env.direct(env.cards, 900, ciIoMapFuseHook(port));
    expect([env.hub.writes, env.hub.value, env.notices, env.events("done"), env.events("pending").length]).toEqual([1, "observe", [], [], 1]);
    env.clock.t += 11 * MIN;
    await env.direct([env.cards[0]!], 901); // another car turns red later: the open case is taken up first
    expect([env.hub.writes, env.notices.length, env.events("done").map((e) => e.result), env.events("closed").length]).toEqual([1, 1, ["settled"], 1]);
  });
  test("the notice fails: the record stands, nothing is written again, and a later pass sends it exactly once", async () => {
    const env = make("on");
    hole(env);
    env.pmFails.n = 1;
    await env.direct();
    expect([env.hub.writes, env.notices, env.events("done").length, env.events("sent")]).toEqual([1, [], 1, []]);
    env.clock.t += 2 * MIN;
    await env.direct([env.cards[0]!], 901);
    await env.direct([env.cards[0]!], 902);
    expect([env.hub.writes, env.notices.length, env.events("sent").length]).toEqual([1, 1, 1]);
    expect(env.notices[0]).toContain("已从 on 退回 observe");
  });
  test("PM switches it on again: a new train's omission lowers it again", async () => {
    const env = make("on");
    hole(env);
    await env.direct();
    env.hub.value = "on";
    await env.direct(); // the same evidence is done: a repeat of it never undoes PM's choice
    expect([env.hub.writes, env.hub.value]).toEqual([1, "on"]);
    await env.direct(env.cards, 901);
    expect([env.hub.writes, env.hub.value, env.notices.length, env.events("done").length]).toEqual([2, "observe", 2, 2]);
  });
});

describe("[验收线 4] an unconfirmed write is reported as exactly that; a lost lease writes nothing more; the train never notices", () => {
  const denied = [
    ["no permission", async (env: Env) => { env.hub.lower = async () => { throw new Error("HTTP 403: Resource not accessible"); }; }, /写变量失败：HTTP 403/, "on"],
    ["the read-back is not observe", async (env: Env) => { env.hub.lower = async () => {}; }, /写后读回的不是 observe/, "on"],
  ] as const;
  for (const [name, arrange, why, after] of denied) {
    test(`${name}: one failure notice, no success record, the case stays open`, async () => {
      const env = make("on");
      hole(env);
      await arrange(env);
      await env.direct();
      expect([env.hub.value, env.notices.length, env.events("done"), env.events("failed").length]).toEqual(["on", 1, [], 1]);
      expect(env.notices[0]).toMatch(/\[CI_IO_MAP 熔断\] 未确认/);
      expect(env.notices[0]).toMatch(why);
      expect(env.notices[0]).toContain(`写后读到 ${after}`);
      expect(env.notices[0]).not.toContain("已从 on 退回");
      env.clock.t += 11 * MIN;
      env.hub.lower = async () => { env.hub.value = "observe"; };
      await env.direct(); // retried, not suppressed by the failure record
      expect([env.hub.value, env.notices.length, env.events("done").map((e) => e.result)]).toEqual(["observe", 2, ["lowered"]]);
    });
  }
  test("the read-back itself fails: unconfirmed, with both reasons kept apart from a success", async () => {
    const env = make("on");
    hole(env);
    const read = env.gh.ioMapVar;
    let n = 0;
    env.gh.ioMapVar = async (r) => { if (++n === 2) throw new Error("gh: timeout"); return read(r); };
    const hook = ciIoMapFuse(env.db, env.gh, env.io, () => ({ mode: "on", manualAfterMs: null, source: "config" }), () => REPO)!;
    await env.direct(env.cards, 900, hook);
    expect([env.notices.length, env.events("done"), env.events("failed")[0]!.why]).toEqual([1, [], "写后读回失败：gh: timeout"]);
    expect(env.notices[0]).toContain("写后读到 （没读到）");
  });
  test("the lease is lost before the write: no write, no record, no notice, and the stop reaches the pass", async () => {
    const env = make("on");
    hole(env);
    env.gh.lowerIoMapVar = async () => { throw new SchedulerStopped("lease lost"); };
    const hook = ciIoMapFuse(env.db, env.gh, env.io, () => ({ mode: "on", manualAfterMs: null, source: "config" }), () => REPO)!;
    await expect(env.direct(env.cards, 900, hook)).rejects.toBeInstanceOf(SchedulerStopped);
    expect([env.hub.writes, env.hub.value, env.notices, env.events("done"), env.events("failed")]).toEqual([0, "on", [], [], []]);
  });
  test("whatever breaks inside the hook, the red car is bisected exactly as without it", async () => {
    const bare = make(null), env = make("on");
    hole(env);
    env.gh.ciRun = async () => { throw new Error("HTTP 502"); };
    const hook = ciIoMapFuse(env.db, env.gh, env.io, () => { throw new Error("policy exploded"); }, () => REPO)!;
    expect(shape(await env.drive({ ...env.deps, ioMapFuse: hook }))).toEqual(shape(await bare.drive()));
    expect(shape(await make("on").drive())).toEqual(shape(await make(null).drive())); // no plan at all: same train
    expect(env.hub.writes).toBe(0);
  });
  test("a gh port without the fuse's calls gets no hook; the evidence key binds repo, run, attempt, digests and files", () => {
    const env = make("on");
    expect(ciIoMapFuse(env.db, { mainHead: async () => BASE }, env.io)).toBeUndefined();
    const e: FuseEvidence = { repo: REPO, project: "p", train: "t", car: "t", members: ["T1"], run: { id: 1, attempt: 1, head: "7".repeat(40) }, files: [F],
      omissions: [{ taskId: "T1", prRef: "", pr: 1, head: "1".repeat(40), runId: 2, attempt: 1, digest: "sha256:a", mapSha: MAP, tests: [], testCount: 0, omitted: [F] }] };
    const keys = [e, { ...e, repo: "x/y" }, { ...e, run: { ...e.run, id: 9 } }, { ...e, run: { ...e.run, attempt: 2 } }, { ...e, files: [F, OTHER] },
      { ...e, omissions: [{ ...e.omissions[0]!, digest: "sha256:b" }] }].map(evidenceKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(evidenceKey({ ...e, repo: REPO.toUpperCase() })).toBe(keys[0]!);
  });
});
