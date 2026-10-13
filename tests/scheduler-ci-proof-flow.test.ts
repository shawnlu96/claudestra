/**
 * merge-arch-GATE1: the four entries of the CI proof gate, each through its real caller — the merge driver (ordinary, serial,
 * manual-queue and PM-repair runs are all MergeRuns on the same MergeExternal), the train hook, boarding (planner /
 * mergeCandidates) and the deploy tick. observe must leave every external action as it was; on only waits while the proof is
 * missing. The decision and the port are unit-tested in tests/scheduler-ci-proof-gate.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { CI_PROOF_MANIFEST_VERSION, ciProofManifestDigest, parseCiProofManifest } from "../src/lib/ci-proof-manifest.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import {
  CI_PROOF_POLICY, DEPLOY_PROOF_WAIT_MS, ciProofAdmits, ciProofTrain, openCiProofGate, setCiProofPortsForTest, withCiProofGate,
} from "../src/lib/scheduler-ci-proof-gate.js";
import { CI_SCOPE_RELATED, type FullRequestPort, type FullRunFact, fullRecheck, fullRequestId, fullRunTitle, resetFullDispatches } from "../src/lib/scheduler-ci-full-request.js";
import { runDeploySteps } from "../src/lib/scheduler-deploy-steps.js";
import { CI_PROOF_WORKFLOW, type CiProofCommit, type CiProofPort, type CiProofRead, type CiProofRunRow } from "../src/lib/scheduler-ci-proof-port.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { DeployJobs } from "../src/lib/scheduler-deploy-job.js";
import { getDeployRun } from "../src/lib/scheduler-deploy.js";
import { deployTick } from "../src/lib/scheduler-deploy-tick.js";
import { mainCiDrive } from "../src/lib/scheduler-main-ci-wiring-driver.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import type { TrainState } from "../src/lib/scheduler-merge-train.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";
import { ledgerAs, MERGE as MERGED, mergedCard } from "./deploy-test-kit.js";

const sha = (c: string) => c.repeat(40), digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const REPO = "example/repo", PR = "https://github.com/example/repo/pull/7", HEAD = sha("c"), MAIN = sha("1"), TEST_MERGE = sha("2"), TREE = sha("3");
const CAR_HEAD = sha("4"), CAR_MERGE = sha("5"), TRAIN_BASE = sha("6"), T8_HEAD = sha("8"), LOCK = "lock\n";
/** A train car's run: its manifest recorded the train's base (the car's PR was opened on it). */
const ON_TRAIN = ["completed", "success", { base: TRAIN_BASE }] as const;
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };
const P = config.projects.p!;

/** GitHub for the gate: PRs, commits, runs and what each run reads back as. `prove` adds a finished, fully proven run. */
function github() {
  const s = { main: MAIN, mainAfter: null as string | null, pulls: new Map<number, string>(), commits: new Map<string, CiProofCommit>(),
    rows: [] as CiProofRunRow[], reads: new Map<number, CiProofRead>(), down: false, calls: [] as string[],
    /** What the pulls API says now: the PR's base (it moves with main) and GitHub's test merge commit. */
    pullBase: new Map<number, string>(), testMerge: new Map<number, string>() };
  let ids = 100;
  const port: CiProofPort = {
    mainHead: async () => { s.calls.push("main"); if (s.down) throw new Error("gh down"); const m = s.main; if (s.mainAfter) { s.main = s.mainAfter; s.mainAfter = null; } return m; },
    pull: async (_r, pr) => {
      s.calls.push(`pull:${pr}`);
      const head = s.pulls.get(pr);
      if (!head) throw new Error(`no PR ${pr}`);
      return { head, base: s.pullBase.get(pr) ?? sha("9"), state: "open", merge: s.testMerge.get(pr) ?? null };
    },
    commit: async (_r, c) => { const hit = s.commits.get(c); if (!hit) throw new Error(`no commit ${c}`); return hit; },
    file: async (_r, _c, path) => (path === "bun.lock" ? LOCK : "      bun-version: 1.3.14\n"),
    runs: async (_r, head) => s.rows.filter((r) => r.headSha === head).sort((a, b) => b.id - a.id),
    read: async (_r, id) => s.reads.get(id)!,
  };
  /**
   * A run of `event` triggered for `head` that checked out `checkout` (parents = what that commit merged), finished with a manifest.
   * `o.base` = the base its manifest recorded (a PR: the pulls API base when it ran). A SELECT1 dispatch is triggered on main and
   * tests `o.tested` (the PR head) merged onto it; `o.title` names its request.
   */
  const prove = (event: "pull_request" | "push" | "workflow_dispatch", head: string, checkout: string, parents: string[], status = "completed", conclusion = "success",
    o: { base?: string; title?: string; tested?: string; scope?: "related" } = {}) => {
    const id = ++ids, base = o.base ?? (event === "pull_request" ? sha("9") : parents[0]!), workflow = event === "workflow_dispatch" ? head : checkout;
    const content = { version: CI_PROOF_MANIFEST_VERSION, repo: REPO, head: o.tested ?? head, base, checkout: { sha: checkout, tree: TREE },
      workflow: { path: CI_PROOF_WORKFLOW, sha: workflow }, policyVersion: CI_PROOF_POLICY, toolchain: { bun: "1.3.14", lockfileDigest: digest(LOCK) },
      tests: { universeDigest: digest("t"), selectedDigest: digest("t"), count: 1 }, scope: o.scope ?? "full", checks: ["ci"] };
    const parsed = parseCiProofManifest(content);
    s.commits.set(checkout, { sha: checkout, tree: TREE, parents });
    s.rows = [...s.rows.filter((r) => !(r.event === event && r.headSha === head)), { id, event, headSha: head, status, title: o.title ?? "" }];
    s.reads.set(id, { event, checkout, evidence: { origin: "actions-api", repo: REPO, runId: id, attempt: 1, latestAttempt: 1, workflow: { path: CI_PROOF_WORKFLOW, sha: workflow },
      headSha: head, status, conclusion, jobs: [{ name: "ci", attempt: 1, conclusion, checkoutSha: checkout, checkoutTree: TREE }],
      artifact: { runId: id, attempt: 1, digest: parsed.ok ? ciProofManifestDigest(parsed.manifest) : "", content } } });
  };
  s.pulls.set(7, HEAD);
  s.commits.set(MAIN, { sha: MAIN, tree: TREE, parents: [sha("0")] });
  return { s, port, prove };
}

let card: ReturnType<typeof mergedCard> | null = null;
/** Opens this pass's gate on a real ledger (the observe notes are ledger events) with the given mode and GitHub. */
function gate(mode: RecoveryMode, gh: ReturnType<typeof github>, clock = { now: 1_000 }): Database {
  card ??= mergedCard();
  setCiProofPortsForTest({ port: gh.port, now: () => clock.now });
  const policy: RecoveryPolicyPort = (_p, key) => ({ mode: key === "ciCoverageGate" ? mode : "off", manualAfterMs: null, source: "config" });
  openCiProofGate(card.db, config, policy);
  return card.db;
}
afterEach(() => { setCiProofPortsForTest(null); card?.close(); card = null; });
const notes = (db: Database) => (db.query("SELECT text, data FROM events WHERE kind='note' AND json_extract(data,'$.mechanism')='ciCoverageGate' ORDER BY seq")
  .all() as { text: string; data: string }[]).map((e) => ({ text: e.text, ...(JSON.parse(e.data) as { stage: string; reasons: string[] }) }));

const run0: MergeRun = { intentId: "i", taskId: "T9", project: "p", prRef: PR, reviewedHead: HEAD, expectedBranch: "feat/t9", requiredChecks: "ci",
  phase: "await_ci", rev: 1, mergeSha: null, reason: null, createdAt: 1, updatedAt: 1 };
/** A green, clean, up-to-date PR and a journal; `calls` is every external action and journal step in order. */
function driver(extra: Partial<MergeExternal> = {}, checks: PrSnapshot["checks"] = [{ name: "ci", bucket: "pass" }]) {
  let row = run0, merged = false;
  const calls: string[] = [];
  const snap = (): PrSnapshot => ({ state: merged ? "MERGED" : "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: merged ? MERGED : null, checks });
  const base: MergeExternal = {
    inspect: async () => { calls.push("inspect"); return snap(); },
    freshness: async () => { calls.push("freshness"); return { behindBy: 0, mainHead: MAIN }; },
    carryReview: async () => ({ ok: false, reason: "unused" }), updateBranch: async () => { calls.push("update-branch"); },
    merge: async (_p, head) => { calls.push(`merge:${head.slice(0, 4)}`); merged = true; return MERGED; }, ...extra,
  };
  const advance = async (_f: MergeRun["phase"], to: MergeRun["phase"], _r: number, receipt?: string) => {
    calls.push(`journal:${to}`);
    return (row = { ...row, phase: to, rev: row.rev + 1, reason: receipt ?? null });
  };
  return { get row() { return row; }, calls, base, advance, gated: () => withCiProofGate(base, P) };
}

describe("[验收线 1][验收线 3] merge driver: a green PR without the full proof of its merge onto main", () => {
  test("red side: today's bucket check merges it; on waits in await_ci (no fix, no freeze, no slot change) and merges once the exact proof exists", async () => {
    const plain = driver();
    await driveMerge(plain.row, plain.base, plain.advance);
    expect(plain.row.phase).toBe("merged"); // no proof anywhere: the name / bucket check let it through
    const gh = github(), d = driver();
    gate("on", gh);
    for (let tick = 0; tick < 3; tick++) await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row).toMatchObject({ phase: "await_ci", rev: 1 });
    expect(d.calls.filter((c) => c.startsWith("journal:") || c.startsWith("merge") || c === "update-branch")).toEqual([]);
    gh.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("merged");
    expect(d.calls.slice(-4)).toEqual(["journal:merging", "merge:cccc", "inspect", "journal:merged"]);
  });

  test("on: a run still in progress, a proof for the old main and an unreadable GitHub all only wait", async () => {
    const gh = github(), d = driver();
    gate("on", gh);
    gh.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD], "in_progress");
    await driveMerge(d.row, d.gated(), d.advance);
    gh.prove("pull_request", HEAD, TEST_MERGE, [sha("0"), HEAD]); // tested on a main that is not the main of now
    await driveMerge(d.row, d.gated(), d.advance);
    gh.s.down = true;
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("await_ci");
    expect(d.calls.some((c) => c.startsWith("journal:") || c.startsWith("merge"))).toBe(false);
  });

  test("on: main moving between the proof and the merge call sends no merge; a merge call with no proof at all is refused too (no bypass)", async () => {
    const gh = github(), d = driver();
    gate("on", gh);
    gh.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    gh.s.mainAfter = sha("0"); // the proof binds MAIN; the next main read (right before the merge API) sees it moved
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("unknown");
    expect(d.row.reason).toMatch(/合并未发出：缺 full 证明（run \d+ 测的集成提交 2{12} 不是 main 0{12} \+ head c{12}/);
    expect(d.calls.some((c) => c.startsWith("merge:"))).toBe(false);
    const bare = driver(), unproven = github();
    gate("on", unproven);
    await expect(bare.gated().merge(PR, HEAD)).rejects.toThrow(/合并未发出：缺 full 证明/);
    expect(bare.calls).toEqual([]);
    unproven.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    expect(await bare.gated().merge(PR, HEAD)).toBe(MERGED);
  });

  test("[验收线 2] on: a proof that is gone after the pass saw it (artifact deleted; main, head and the green checks unchanged) sends no merge", async () => {
    const gh = github(), d = driver(), ext = d.gated(), inspect = ext.inspect, recheck = ext.fullRecheck!;
    const drop = () => { for (const [id, r] of gh.s.reads) gh.s.reads.set(id, { ...r, checkout: null, evidence: { ...r.evidence, artifact: null } }); };
    let passed = false;
    gate("on", gh);
    gh.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    ext.fullRecheck = async (run, pr) => { const own = await recheck(run, pr); passed = own === null; return own; };
    ext.inspect = async (p) => { if (passed) drop(); return inspect(p); }; // deleted during the last inspect, before the merging claim
    await driveMerge(d.row, ext, d.advance);
    expect(passed).toBe(true);
    expect([d.row.phase, d.calls.some((c) => c.startsWith("merge:"))]).toEqual(["unknown", false]);
    expect(d.row.reason).toMatch(/合并未发出：缺 full 证明（run \d+ 没有留下本次 attempt 的证明工件/);
    // a train member: the car's proof is deleted after the train hook's last answer, right at the claim
    const car = github(), state = train1(), t = driver({ train: (run) => ciProofTrain("cleared", state, run) });
    car.s.pulls.set(90, CAR_HEAD);
    gate("on", car);
    car.prove("pull_request", CAR_HEAD, CAR_MERGE, [TRAIN_BASE, CAR_HEAD], ...ON_TRAIN);
    const gone = car.s.reads;
    await driveMerge(t.row, t.gated(), async (f, to, r, receipt) => {
      if (to === "merging") for (const [id, x] of gone) gone.set(id, { ...x, checkout: null, evidence: { ...x.evidence, artifact: null } });
      return t.advance(f, to, r, receipt);
    });
    expect([t.row.phase, t.calls.some((c) => c.startsWith("merge:"))]).toEqual(["unknown", false]);
    expect(t.row.reason).toMatch(/合并未发出：缺 full 证明/);
    expect(car.s.calls).not.toContain("main"); // the car is asked again as the car: main stays the train's own recheck
  });

  test("the path's own full re-check answers first: its wait / failure is returned untouched and the proof is not read", async () => {
    for (const own of ["wait", "串行 full 补验失败（timeout，责任人 PM）：x"] as const) {
      const gh = github(), d = driver({ fullRecheck: async () => own });
      gate("on", gh);
      await driveMerge(d.row, d.gated(), d.advance);
      expect(d.row.phase).toBe(own === "wait" ? "await_ci" : "unknown");
      expect(gh.s.calls).toEqual([]);
    }
  });

  test("serial / manual queue with a related-only PR run: SELECT1 dispatches once, and its re-check run of this exact binding is the proof that merges", async () => {
    resetFullDispatches();
    const gh = github(), sent: string[] = [], listed: FullRunFact[] = [];
    const binding = { repo: REPO, pr: 7, head: HEAD, base: MAIN, merge: TEST_MERGE, tree: TREE }, id = fullRequestId(binding);
    const select: FullRequestPort = { subject: async () => binding, runs: async () => listed, dispatch: async (_s, i) => { sent.push(i); } };
    const d = driver({ train: async () => null, fullRecheck: (run, pr) => fullRecheck(run, pr, select) }, [{ name: "ci", bucket: "pass" }, { name: CI_SCOPE_RELATED, bucket: "pass" }]);
    gate("on", gh);
    gh.s.testMerge.set(7, TEST_MERGE);
    gh.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD], "completed", "success", { scope: "related" });
    await driveMerge(d.row, d.gated(), d.advance);
    expect([d.row.phase, sent]).toEqual(["await_ci", [id]]); // SELECT1's own wait: the gate has not been asked
    listed.push({ id: 900, title: fullRunTitle(id), status: "completed", conclusion: "success", createdAt: new Date().toISOString() });
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("await_ci"); // SELECT1 passed, but the run left no proof the gate can read: wait, and no second dispatch
    gh.prove("workflow_dispatch", MAIN, TEST_MERGE, [MAIN, HEAD], "completed", "failure", { title: fullRunTitle(id), tested: HEAD });
    await driveMerge(d.row, d.gated(), d.advance);
    gh.prove("workflow_dispatch", MAIN, TEST_MERGE, [MAIN, HEAD], "completed", "success", { title: fullRunTitle("cifull-another-binding"), tested: HEAD });
    await driveMerge(d.row, d.gated(), d.advance);
    expect([d.row.phase, d.calls.some((c) => c.startsWith("merge:"))]).toEqual(["await_ci", false]);
    gh.prove("workflow_dispatch", MAIN, TEST_MERGE, [MAIN, HEAD], "completed", "success", { title: fullRunTitle(id), tested: HEAD });
    await driveMerge(d.row, d.gated(), d.advance);
    expect([d.row.phase, sent]).toEqual(["merged", [id]]);
  });

  const kinds: [string, Partial<MergeExternal>, (d: ReturnType<typeof driver>) => Promise<unknown>][] = [
    ["普通卡", {}, (d) => driveMerge(d.row, d.gated(), d.advance)],
    ["串行卡（列车关 / 不在车上：train 钩子答 null）", { train: async () => null }, (d) => driveMerge(d.row, d.gated(), d.advance)],
    ["人工队列（manual 卡的合并运行，同一个 external）", { train: async () => null, fullRecheck: async () => null },
      (d) => driveMerge({ ...d.row, taskId: "T9" }, d.gated(), d.advance)],
    ["PM 修复绑定（主线 CI 红时放行的修复卡，经 mainCiDrive）", { mainCi: async () => "go" as const }, (d) => mainCiDrive(d.row, d.gated(), d.advance)],
  ];
  for (const [kind, extra, drive] of kinds) {
    test(`${kind}: on waits without the proof and merges with it; main itself needs no proof for the merge (a repair is never locked out)`, async () => {
      const gh = github(), d = driver(extra);
      gate("on", gh);
      await drive(d);
      expect(d.row.phase).toBe("await_ci");
      expect(d.calls.some((c) => c.startsWith("merge:") || c.startsWith("journal:"))).toBe(false);
      gh.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]); // only the PR's own merge onto main; main's push run has no proof
      await drive(d);
      expect(d.row.phase).toBe("merged");
    });
  }
});

describe("[验收线 4] observe changes no external action: it only records that on would wait", () => {
  test("the same external calls and journal steps as without the gate, plus one ledger note per distinct would-wait", async () => {
    const plain = driver();
    await driveMerge(plain.row, plain.base, plain.advance);
    const gh = github(), d = driver(), db = gate("observe", gh);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.calls).toEqual(plain.calls);
    expect(d.row).toEqual(plain.row);
    const text = expect.stringMatching(/^恢复观察（ciCoverageGate）：本会 on 会等待 full 证明（merge，head c{12}）：head c{12} 还没有 pull_request 的 CI run/);
    expect(notes(db)).toMatchObject([{ stage: "merge", text }]);
    const again = driver();
    await driveMerge(again.row, again.gated(), again.advance); // the same would-wait: no second note
    expect(notes(db)).toHaveLength(1);
  });

  test("observe with an unreadable GitHub, and off, still merge exactly as before; off reads nothing; a proven run leaves no note", async () => {
    const plain = driver();
    await driveMerge(plain.row, plain.base, plain.advance);
    const down = github(), d = driver();
    down.s.down = true;
    const db = gate("observe", down);
    for (let tick = 0; tick < 2; tick++) await driveMerge(tick ? driver().row : d.row, tick ? driver().gated() : d.gated(), d.advance);
    expect(d.calls.slice(0, plain.calls.length)).toEqual(plain.calls);
    expect(notes(db)).toMatchObject([{ stage: "merge", reasons: ["证据读取失败：gh down"] }]); // one note however the failure is worded or repeated
    const off = github(), o = driver();
    gate("off", off);
    await driveMerge(o.row, o.gated(), o.advance);
    expect([o.calls, off.s.calls]).toEqual([plain.calls, []]);
    const proven = github(), p = driver();
    gate("observe", proven);
    proven.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    await driveMerge(p.row, p.gated(), p.advance);
    expect([p.calls, notes(db).length]).toEqual([plain.calls, 1]); // nothing added for the proven run
  });

  test("in the service the note goes through the pass manager (its ledger connection is query_only); a refused note changes nothing", async () => {
    const plain = driver();
    await driveMerge(plain.row, plain.base, plain.advance);
    for (const answer of [{ ok: true, recorded: true }, { ok: false, error: "本项目未启用自动调度" }]) {
      const gh = github(), d = driver(), argv: string[][] = [];
      setCiProofPortsForTest({ port: gh.port });
      openCiProofGate(null as unknown as Database, config, () => ({ mode: "observe", manualAfterMs: null, source: "config" }), undefined,
        async (...a) => { argv.push(a); return answer; });
      for (let tick = 0; tick < 2; tick++) await driveMerge(run0, d.gated(), d.advance);
      expect(d.calls.slice(0, plain.calls.length)).toEqual(plain.calls);
      expect(argv).toHaveLength(1); // the same would-wait is not sent again
      expect(argv[0]!.slice(0, 8)).toEqual(["ledger", "scheduler-recovery-observe", "T9", "--mechanism", "ciCoverageGate", "--action-key",
        expect.stringMatching(/^merge:c{12}:[0-9a-f]{12}$/), "--action"]);
      expect(JSON.parse(argv[0]!.at(-1)!)).toMatchObject({ stage: "merge", head: HEAD, runId: null, pending: true });
    }
  });

  test("no gate was opened for the project (a test process, a project outside the config): every entry is the path as it was", async () => {
    const gh = github(), d = driver();
    setCiProofPortsForTest(null);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("merged");
    expect(await ciProofTrain("cleared", null, run0)).toBe("cleared");
    gate("on", gh);
    const stranger = driver();
    await driveMerge(stranger.row, withCiProofGate(stranger.base, { ...P }), stranger.advance); // a policy object the pass never registered
    expect(stranger.row.phase).toBe("merged");
    expect(gh.s.calls).toEqual([]);
  });
});

/** A settling train whose green car (PR 90) carried T8 and T9, both cleared. */
function train1(cars: Partial<TrainState["cars"][number]>[] = [{ status: "green", pr: 90, members: ["T8", "T9"] }]): TrainState {
  return {
    v: 1, id: "train-1", seq: 1, project: "p", repo: REPO, base: TRAIN_BASE, phase: "settling", outcome: null, reason: null, cleared: ["T8", "T9"], merged: [], bounced: [],
    members: [{ taskId: "T8", prRef: "https://github.com/example/repo/pull/8", head: T8_HEAD, files: [] }, { taskId: "T9", prRef: PR, head: HEAD, files: [] }],
    serial: [], dropped: [], ciRuns: 1, startedAt: 1, updatedAt: 1, skip: [],
    cars: cars.map((c, i) => ({ id: `c${i}`, level: 0, parent: null, members: [], branch: `train/c${i}`, created: true, assembled: [], pr: null, status: "ci", startedAt: 1, ...c })),
  };
}

describe("[验收线 3] train members: boarding needs no proof; a cleared member merges on the full proof of the car that carried it", () => {
  const train = train1;

  test("on: cleared → wait until the car's PR (combined head merged onto the train's base) has its full proof; every other answer passes untouched", async () => {
    const gh = github();
    gh.s.pulls.set(90, CAR_HEAD);
    gate("on", gh);
    expect(await ciProofTrain("cleared", train(), run0)).toBe("wait");
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [MAIN, CAR_HEAD]); // tested on main, not on the train's base: not this train's combination
    expect(await ciProofTrain("cleared", train(), run0)).toBe("wait");
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [TRAIN_BASE, CAR_HEAD], ...ON_TRAIN);
    expect(await ciProofTrain("cleared", train(), run0)).toBe("cleared");
    expect(gh.s.calls.filter((c) => c === "main")).toEqual([]); // the train rechecks main itself (recheckCleared): untouched here
    const before = gh.s.calls.length, bounce = { bounce: "culprit" };
    expect([await ciProofTrain("wait", train(), run0), await ciProofTrain(null, train(), run0), await ciProofTrain(bounce, train(), run0)]).toEqual(["wait", null, bounce]);
    expect(gh.s.calls.length).toBe(before);
    expect(await ciProofTrain("cleared", train([{ status: "red", pr: 90, members: ["T9"] }, { status: "green", pr: 91, members: ["T8"] }]), run0)).toBe("wait");
  });

  test("through the driver: the member's own PR has no proof and main has moved on, yet the car's proof merges it; without it the member waits", async () => {
    const gh = github(), state = train(), d = driver({ train: (run) => ciProofTrain("cleared", state, run) });
    gh.s.pulls.set(90, CAR_HEAD);
    gh.s.main = sha("0");
    gate("on", gh);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("await_ci");
    expect(d.calls.some((c) => c.startsWith("merge:"))).toBe(false);
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [TRAIN_BASE, CAR_HEAD], ...ON_TRAIN);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("merged");
    expect(gh.s.calls).not.toContain("pull:7");
  });

  test("[验收线 4] two members, real base movement: after the first one merges (main and the car PR's API base move on) the second still merges on the car's proof", async () => {
    const gh = github(), state = train(), AFTER_T8 = sha("a");
    gh.s.pulls.set(90, CAR_HEAD);
    gate("on", gh);
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [TRAIN_BASE, CAR_HEAD], ...ON_TRAIN);
    const t8 = { ...run0, intentId: "i8", taskId: "T8", prRef: "https://github.com/example/repo/pull/8", reviewedHead: T8_HEAD };
    expect(await ciProofTrain("cleared", state, t8)).toBe("cleared");
    // T8 merged: main = base + T8, and GitHub now reports that main as the open car PR's base
    gh.s.main = AFTER_T8; gh.s.pullBase.set(90, AFTER_T8);
    gh.s.commits.set(AFTER_T8, { sha: AFTER_T8, tree: TREE, parents: [TRAIN_BASE, T8_HEAD] });
    state.merged.push({ taskId: "T8", sha: AFTER_T8 });
    const d = driver({ train: (run) => ciProofTrain("cleared", state, run) });
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("merged");
    // a car run that sat on base + T8 is the same train's combination; on base + a commit that is not a cleared member it is not
    const LATER = sha("b");
    gh.prove("pull_request", CAR_HEAD, LATER, [AFTER_T8, CAR_HEAD], "completed", "success", { base: AFTER_T8 });
    expect(await ciProofTrain("cleared", state, run0)).toBe("cleared");
    gh.s.commits.set(AFTER_T8, { sha: AFTER_T8, tree: TREE, parents: [TRAIN_BASE, sha("e")] });
    expect(await ciProofTrain("cleared", state, run0)).toBe("wait");
    expect(gh.s.calls.filter((c) => c === "main")).toEqual([]); // what main is now stays the train's own recheckCleared
  });

  test("observe: the cleared member merges as before and the would-wait is recorded once", async () => {
    const plain = driver({ train: async () => "cleared" });
    await driveMerge(plain.row, plain.base, plain.advance);
    const gh = github(), state = train(), d = driver({ train: (run) => ciProofTrain("cleared", state, run) }), db = gate("observe", gh);
    gh.s.pulls.set(90, CAR_HEAD);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.calls).toEqual(plain.calls);
    expect(notes(db).map((n) => n.stage)).toEqual(["merge"]);
  });

  test("boarding and planning share the decision's admit stage, which never asks for a proof (thin wiring, checked in the source)", () => {
    expect(ciProofAdmits()).toBe(true);
    const src = (f: string) => readFileSync(join(import.meta.dir, "../src/lib", f), "utf8");
    expect(src("scheduler-merge-train-tick.ts")).toContain("if (!ciProofAdmits()) continue;");
    expect(src("scheduler-merge-train-tick.ts")).toContain("gate = await ciProofTrain(await trainGate(state, run, io), state, run);");
    expect(src("scheduler-plan.ts")).toContain('if (!ciProofAdmits()) return wait("ci_proof"');
    expect(src("scheduler-merge-external.ts")).toContain("withMainCi(withCiProofGate(withCiFullRequest(");
    expect(src("scheduler-pass.ts")).toContain("openCiProofGate(db, config, opts.recoveryPolicy, opts.external ? undefined : guard(active, runBounded), manager, active);");
    for (const f of ["scheduler-plan.ts", "scheduler-pass.ts", "scheduler-merge-external.ts", "scheduler-merge-train-tick.ts"]) {
      expect(src(f).split("\n").filter((l) => /ciProof|CiProof/.test(l)).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("[验收线 1][验收线 3] deploy tick: the main commit that would be deployed needs its own full proof", () => {
  const LABEL = `com.claudestra.scheduler.deploy.${"f".repeat(32)}`;
  function jobs() {
    const log: string[] = [], sent: unknown[][] = [];
    const j: DeployJobs = { label: () => LABEL, observe: async () => null, remove: async () => true,
      submit: async (...args) => { log.push("submit"); sent.push(args.slice(3)); return LABEL; } }; // sent = what follows (run, repoDir, target)
    return { log, sent, j };
  }
  const tick = (db: Database, j: DeployJobs, now = 1_000) => deployTick(db, config, { manager: ledgerAs(db, "scheduler", () => now), jobs: j, assertActive: () => {}, now: () => now });
  const intent = (db: Database) => db.query("SELECT status FROM scheduler_intents WHERE id='m9'").get() as { status: string };
  const receipt = (db: Database) => (db.query("SELECT json_extract(data,'$.receipt') AS r FROM events WHERE target='T9' AND kind='scheduler' ORDER BY seq DESC LIMIT 1").get() as { r: string }).r;
  /** main's tip is the card's merge commit; its push run is added by the test. */
  const merged = () => { const gh = github(); gh.s.main = MERGED; return gh; };

  test("on: no deploy while main's run for that commit is unfinished (merge slot kept, nothing settled); it deploys once the proof exists", async () => {
    const gh = merged(), { log, j } = jobs(), db = gate("on", gh);
    gh.prove("push", MERGED, MERGED, [MAIN, HEAD], "in_progress");
    await tick(db, j);
    await tick(db, j);
    expect([log, getDeployRun(db, "m9"), intent(db).status]).toEqual([[], null, "submitted"]);
    expect(db.query("SELECT 1 FROM scheduler_resources WHERE resource='merge:p' AND taskId='T9'").get()).toBeTruthy();
    gh.prove("push", MERGED, MERGED, [MAIN, HEAD]);
    await tick(db, j);
    expect(log).toEqual(["submit"]);
    expect(getDeployRun(db, "m9")?.phase).toBe("running");
  });

  test("[验收线 1] on: a push that brought several commits is proven by its run (manifest base = the push's before, not the tip's first parent) and deploys", async () => {
    const gh = merged(), { sent, j } = jobs(), db = gate("on", gh);
    gh.prove("push", MERGED, MERGED, [sha("b"), HEAD], "completed", "success", { base: MAIN }); // MAIN → b → MERGED in one push
    await tick(db, j);
    expect([sent, getDeployRun(db, "m9")?.phase, intent(db).status]).toEqual([[[MERGED]], "running", "submitted"]);
  });

  test("[验收线 2] on: the job is fixed to the commit that was proven — main moving on after the proof is not deployed (the real steps, fake git)", async () => {
    const gh = merged(), { sent, j } = jobs(), db = gate("on", gh), LATER = sha("7");
    gh.prove("push", MERGED, MERGED, [MAIN, HEAD]);
    await tick(db, j);
    expect(sent).toEqual([[MERGED]]); // deploySha in the request = the main commit whose full proof was read
    expect(receipt(db)).toMatch(/固定部署 main d{12}/);
    // someone pushes LATER (no proof) before the job fetches: origin/main is LATER, the tree still goes to MERGED and no further
    let tree = MAIN;
    const calls: string[][] = [];
    const git = async (argv: string[]) => {
      calls.push(argv);
      const ff = argv.indexOf("--ff-only");
      if (ff > 0) tree = argv.at(-1) === "origin/main" ? LATER : argv.at(-1)!;
      return { code: 0, timedOut: false, stderr: "", stdout: argv.includes("--abbrev-ref") ? "main" : argv.includes("rev-parse") ? tree : "" };
    };
    const input = { repoDir: "/repo", mergeSha: MERGED, relayArgv: null, restartLabels: ["x.fake"], env: {}, uid: 501, deadline: Date.now() + 60_000 };
    expect(await runDeploySteps({ ...input, deploySha: sent[0]![0] as string }, git, () => true)).toMatchObject({ ok: true, head: MERGED });
    expect(calls.filter((a) => a.includes("--ff-only")).map((a) => a.at(-1))).toEqual([MERGED]);
    tree = MAIN; // the same race without the pin (what a request written under off / observe does): LATER is deployed
    expect(await runDeploySteps(input, git, () => true)).toMatchObject({ ok: true, head: LATER });
  });

  test("[验收线 2] on: a claim left by an earlier pass is proven again before it is submitted; without a proof it waits as claimed, then ends unsubmitted", async () => {
    const gh = merged(), { log, sent, j } = jobs(), clock = { now: 1_000 }, db = gate("on", gh, clock);
    await ledgerAs(db, "scheduler")("ledger", "scheduler-deploy-begin", "m9"); // claimed, then the service restarted
    gh.s.main = sha("7"); // main moved while it was down: that tip has no run yet
    await tick(db, j);
    expect([log, getDeployRun(db, "m9")?.phase]).toEqual([[], "claimed"]);
    gh.prove("push", sha("7"), sha("7"), [MERGED, sha("8")]);
    await tick(db, j);
    expect([sent, getDeployRun(db, "m9")?.phase]).toEqual([[[sha("7")]], "running"]);
  });

  test("on: a claim whose main run finished without a proof is never submitted", async () => {
    const gh = merged(), { log, j } = jobs(), db = gate("on", gh);
    await ledgerAs(db, "scheduler")("ledger", "scheduler-deploy-begin", "m9");
    gh.prove("push", MERGED, MERGED, [MAIN, HEAD], "completed", "failure");
    await tick(db, j);
    expect([log, getDeployRun(db, "m9")]).toMatchObject([[], { phase: "unknown", outcome: "failed" }]);
  });

  test("on: the proof must be the deployed commit's own — main moved past the merge, and that tip has no proof: no deploy", async () => {
    const gh = merged(), { log, j } = jobs(), db = gate("on", gh);
    gh.prove("push", MERGED, MERGED, [MAIN, HEAD]);
    gh.s.main = sha("7"); // someone merged after this card: the job would fast-forward to this tip
    await tick(db, j);
    expect([log, getDeployRun(db, "m9")]).toEqual([[], null]);
    gh.prove("push", sha("7"), sha("7"), [MERGED, sha("8")]);
    await tick(db, j);
    expect(log).toEqual(["submit"]);
  });

  test("on: a finished main run without a proof never deploys; the merge is settled for PM so the slot is not held forever (a repair can merge)", async () => {
    const gh = merged(), { log, j } = jobs(), db = gate("on", gh);
    gh.prove("push", MERGED, MERGED, [MAIN, HEAD], "completed", "failure");
    await tick(db, j);
    expect([log, getDeployRun(db, "m9"), intent(db).status]).toEqual([[], null, "done"]);
    expect(receipt(db)).toMatch(new RegExp(`^merge:${MERGED}; 不自动部署（main d{12} 没有全量证明：.*run 结论 failure.*），待 PM 部署$`));
    expect(db.query("SELECT 1 FROM scheduler_resources WHERE resource='merge:p'").get()).toBeNull();
  });

  test("on: a proof that never arrives stops waiting after DEPLOY_PROOF_WAIT_MS and goes to PM the same way", async () => {
    const gh = merged(), { log, j } = jobs(), clock = { now: 1_000 }, db = gate("on", gh, clock);
    await tick(db, j);
    clock.now += DEPLOY_PROOF_WAIT_MS;
    await tick(db, j);
    expect(intent(db).status).toBe("submitted");
    clock.now += 1;
    await tick(db, j);
    expect([log, intent(db).status]).toEqual([[], "done"]);
    expect(receipt(db)).toMatch(/不自动部署（main d{12} 没有全量证明：head d{12} 还没有 main push 的 CI run），待 PM 部署/);
  });

  test("main is red (what MAINCIW pauses on) with a merged card waiting to deploy: on submits nothing, observe submits once and records the would-wait", async () => {
    const red = () => { const gh = merged(); gh.prove("push", MERGED, MERGED, [MAIN, HEAD], "completed", "failure"); return gh; };
    const on = red(), a = jobs(), db = gate("on", on);
    for (let i = 0; i < 3; i++) await tick(db, a.j);
    // not claimed, not submitted: settled for PM, and the merge slot is free again so a main-CI repair can merge (PM 定 5)
    expect([a.log, getDeployRun(db, "m9"), intent(db).status]).toEqual([[], null, "done"]);
    expect(receipt(db)).toMatch(/不自动部署（main d{12} 没有全量证明：.*run 结论 failure.*），待 PM 部署$/);
    expect(db.query("SELECT 1 FROM scheduler_resources WHERE resource='merge:p'").get()).toBeNull();
    setCiProofPortsForTest(null); card!.close(); card = null;
    const claimed = red(), c = jobs(), db1 = gate("on", claimed);
    await ledgerAs(db1, "scheduler")("ledger", "scheduler-deploy-begin", "m9");
    for (let i = 0; i < 3; i++) await tick(db1, c.j);
    expect(c.log).toEqual([]);
    setCiProofPortsForTest(null); card!.close(); card = null;
    const seen = red(), o = jobs(), db2 = gate("observe", seen);
    for (let i = 0; i < 3; i++) await tick(db2, o.j);
    expect([o.log, o.sent]).toEqual([["submit"], [[]]]);
    expect(notes(db2)).toMatchObject([{ stage: "deploy", text: expect.stringMatching(/本会 on 会等待 full 证明（deploy，head d{12}）：.*run 结论 failure/) }]);
  });

  test("observe deploys exactly as before (the request carries no deploySha) and records what on would wait for or pin; off reads nothing", async () => {
    const gh = merged(), { log, sent, j } = jobs(), db = gate("observe", gh);
    await tick(db, j);
    expect([log, sent, getDeployRun(db, "m9")?.phase]).toEqual([["submit"], [[]], "running"]);
    expect(receipt(db)).not.toContain("固定部署");
    expect(notes(db)).toMatchObject([{ stage: "deploy", reasons: [expect.stringMatching(/还没有 main push 的 CI run/)] }]);
    setCiProofPortsForTest(null); card!.close(); card = null;
    const proven = merged(), p = jobs(), db1 = gate("observe", proven);
    proven.prove("push", MERGED, MERGED, [MAIN, HEAD]);
    await tick(db1, p.j);
    expect([p.log, p.sent]).toEqual([["submit"], [[]]]);
    expect(notes(db1).map((n) => n.text)).toEqual([expect.stringMatching(/本会 on 会固定部署到 main d{12}（已有 full 证明）/)]);
    setCiProofPortsForTest(null); card!.close(); card = null;
    const quiet = merged(), off = jobs(), db2 = gate("off", quiet);
    await tick(db2, off.j);
    expect([off.log, off.sent, quiet.s.calls]).toEqual([["submit"], [[]], []]);
  });
});
