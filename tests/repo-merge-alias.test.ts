/** rename-floka-REPOMERGE1 · the merge train, hand-over clone check and private gate with the renamed repository's old and new name. */
import { afterEach, describe, expect, test } from "bun:test";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { isMemberRun, trainRunProblem } from "../src/lib/ci-io-map-fuse.js";
import { OFFICIAL_REPO, PROPOSED_REPO } from "../src/lib/floka-repo/migrate.js";
import { privateMergeVerdict, setPrivateMergePortsForTest } from "../src/lib/private-merge-gate.js";
import { setRepoAliasForTest } from "../src/lib/repo-alias.js";
import { handoffFiles } from "../src/lib/scheduler-merge-handoff-tick.js";
import { formTrain, trainGate, type TrainDeps, type TrainEvent, type TrainGh, type TrainState, type TrainStore } from "../src/lib/scheduler-merge-train.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { trainGh } from "../src/lib/scheduler-merge-train-gh.js";
import { setTrainModeSource } from "../src/lib/scheduler-merge-train-switch.js";

const OLD = OFFICIAL_REPO, NEW = PROPOSED_REPO;
const MODES: RecoveryMode[] = ["off", "observe", "on"];
const H1 = "a".repeat(40), H2 = "b".repeat(40), BASE = "f".repeat(40);
const pr = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const ok = (stdout = ""): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false });

const observed: string[] = [];
const alias = (mode: RecoveryMode) => setRepoAliasForTest({ mode, sink: (a) => observed.push(a.actionKey) });
afterEach(() => {
  setRepoAliasForTest({ mode: null, sink: null }); observed.length = 0;
  setPrivateMergePortsForTest(null); setTrainModeSource(null);
});

function trainEnv(cards: { taskId: string; prRef: string; head: string }[]) {
  let state: TrainState | null = null;
  const events: TrainEvent[] = [];
  const store: TrainStore = { load: () => state && structuredClone(state), all: () => (state ? [structuredClone(state)] : []),
    save: (s) => { state = structuredClone(s); }, event: (_p, ev) => { events.push(ev); }, nextSeq: () => 1 };
  const gh = { mainHead: async () => BASE, prFiles: async (p: string) => [`src/${p.split("/").pop()}.ts`],
    createBranch: async () => {}, mergeInto: async () => "merged", openDraft: async () => 1000, checks: async () => [] } as unknown as TrainGh;
  const deps: TrainDeps = { gh, store, now: () => 1_000, requiredChecks: ["check"], memberStatus: () => ({ kind: "waiting" }), notify: async () => {} };
  return { deps, form: () => formTrain("p", cards, deps) };
}

describe("[验收线 1] one train group across the old and new name", () => {
  const cards = [{ taskId: "T1", prRef: pr(OLD, 1), head: H1 }, { taskId: "T2", prRef: pr(NEW, 2), head: H2 }];
  test("on: an old-name and a new-name card form one train; off / observe: as before, no group of two", async () => {
    setTrainModeSource(() => "on");
    alias("on");
    expect((await trainEnv(cards).form())?.members.map((m) => m.taskId)).toEqual(["T1", "T2"]);
    for (const mode of ["off", "observe"] as const) {
      alias(mode);
      expect(await trainEnv(cards).form()).toBeNull();
    }
    expect(observed).toContain("scheduler-merge-train.formTrain");
  });
  test("another org's floka and a fork never join the group", async () => {
    setTrainModeSource(() => "on");
    alias("on");
    for (const other of ["someone/floka", "someone/claudestra", "floka-ai/floka-fork"]) {
      expect(await trainEnv([cards[0]!, { taskId: "T2", prRef: pr(other, 2), head: H2 }]).form()).toBeNull();
    }
  });
  test("on: the merge driver's run under the other name is the saved member, not an outsider", async () => {
    setTrainModeSource(() => "on");
    alias("on");
    const env = trainEnv(cards), s = (await env.form())!;
    const run = { intentId: "m-T1", taskId: "T1", project: "p", prRef: pr(NEW, 1), reviewedHead: H1, phase: "ready" } as MergeRun;
    expect(await trainGate(s, run, env.deps)).toBe("wait");
  });
});

describe("[验收线 1/4] a CI run GitHub reports under the new name", () => {
  const runJson = (repo: string, headRepo: string) => JSON.stringify({ id: 5, status: "completed", conclusion: "success", head_branch: "train/1-abc",
    head_sha: H1, run_attempt: 1, path: ".github/workflows/ci.yml", event: "pull_request", repo, head_repo: headRepo, prs: [7] });
  const gh = (repo: string, headRepo: string) => trainGh((async () => ok(runJson(repo, headRepo))) as never);
  const ghList = (repo: string, headRepo: string) => trainGh((async () => ok(`[${runJson(repo, headRepo)}]`)) as never);
  const kase = { repo: OLD, runId: 5, attempt: 1, branch: "train/1-abc" } as Parameters<typeof trainRunProblem>[1];
  test("on: an old-name train member claims it; off / observe: it stays another repository's, as before", async () => {
    for (const mode of MODES) {
      alias(mode);
      const run = await gh(NEW, NEW).ciRun(OLD, 5);
      const [listed] = await ghList(NEW, NEW).headRuns(OLD, H1);
      expect([isMemberRun(run, OLD, H1, 7), isMemberRun(listed!, OLD, H1, 7), trainRunProblem(run, kase)])
        .toEqual(mode === "on" ? [true, true, null] : [false, false, "run 不属于本仓"]);
    }
  });
  test("a fork's head repo is never claimed, in any mode", async () => {
    for (const mode of MODES) {
      alias(mode);
      for (const fork of ["someone/claudestra", "someone/floka"]) {
        expect(isMemberRun(await gh(NEW, fork).ciRun(OLD, 5), OLD, H1, 7)).toBe(false);
        expect(isMemberRun(await gh(OLD, fork).ciRun(OLD, 5), OLD, H1, 7)).toBe(false);
      }
    }
  });
  test("another org's floka stays foreign", async () => {
    alias("on");
    expect(trainRunProblem(await gh("someone/floka", "someone/floka").ciRun(OLD, 5), kase)).toBe("run 不属于本仓");
  });
});

describe("[验收线 2] the hand-over clone check with origin on the new name", () => {
  const files = (origin: string) => handoffFiles("/nonexistent", (async (argv: string[]) => {
    if (argv[1] === "config") return ok(`https://github.com/${origin}.git\n`);
    if (argv[1] === "diff") return ok("src/a.ts\0");
    return ok();
  }) as never);
  test("on: an old-name PR in a new-name clone passes; off / observe: refused as before", async () => {
    for (const mode of MODES) {
      alias(mode);
      expect(await files(NEW)(pr(OLD, 3), H1)).toEqual(mode === "on" ? ["src/a.ts"] : null);
    }
  });
  test("a clone of a fork or another org's floka is never the PR's repository", async () => {
    alias("on");
    for (const origin of ["someone/claudestra", "someone/floka"]) expect(await files(origin)(pr(OLD, 3), H1)).toBeNull();
    expect(await files(OLD)(pr(OLD, 3), H1)).toEqual(["src/a.ts"]);
  });
});

describe("[验收线 2/4] the private merge gate", () => {
  const task = (repo: string, prRepo: string) => ({ project: "p", pr: pr(prRepo, 4), extra: { fileGlobs: [`repo:${repo}/src/**`] } });
  const ports = (project: string, checkout: string) => setPrivateMergePortsForTest({ projectRepo: () => project, handoff: () => false,
    repoDirs: { dirs: () => ["/c"], origin: () => checkout, exists: () => true } });
  test("on: an old-name card of the project (origin on the new name) is not a private card; off / observe: verdict as before", () => {
    ports(NEW, NEW);
    for (const mode of MODES) {
      alias(mode);
      expect(privateMergeVerdict(task(OLD, OLD))).toEqual(mode === "on" ? null : { repo: OLD, refused: `本机没有 ${OLD} 的检出` });
    }
  });
  test("on: a declaration under the other name still binds to its PR", () => {
    ports("example/project", NEW);
    for (const mode of MODES) {
      alias(mode);
      expect(privateMergeVerdict(task(OLD, NEW))).toEqual(mode === "on" ? { repo: NEW, dir: "/c" } : { repo: NEW, refused: `PR 不在卡的私仓 ${OLD}` });
    }
  });
  test("a real private card keeps the private path; a fork or another org's floka is never aliased", () => {
    ports(NEW, "owner/secret");
    for (const mode of MODES) {
      alias(mode);
      expect(privateMergeVerdict(task("owner/secret", "owner/secret"))).toEqual({ repo: "owner/secret", dir: "/c" });
      // a PR in the project's own repository under its other name: on, like the same spelling, it is not a private card (old path)
      expect(privateMergeVerdict(task("owner/secret", OLD))).toEqual(mode === "on" ? null : { repo: OLD, refused: "PR 不在卡的私仓 owner/secret" });
      expect(privateMergeVerdict(task("owner/secret", "owner/other"))).toEqual({ repo: "owner/other", refused: "PR 不在卡的私仓 owner/secret" });
      expect(privateMergeVerdict(task("someone/floka", "someone/floka"))).toEqual({ repo: "someone/floka", refused: "本机没有 someone/floka 的检出" });
      expect(privateMergeVerdict(task(OLD, "someone/claudestra"))).toEqual({ repo: "someone/claudestra", refused: `PR 不在卡的私仓 ${OLD}` });
    }
  });
});
