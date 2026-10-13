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
const CAR_HEAD = sha("4"), CAR_MERGE = sha("5"), TRAIN_BASE = sha("6"), LOCK = "lock\n";
const config: SchedulerConfig = { enabled: true, pollMs: 5000, autoDispatch: true,
  projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/repo", deploy: { restartLabels: ["x.fake"], timeoutMs: 60_000 } } } };
const P = config.projects.p!;

/** GitHub for the gate: PRs, commits, runs and what each run reads back as. `prove` adds a finished, fully proven run. */
function github() {
  const s = { main: MAIN, mainAfter: null as string | null, pulls: new Map<number, string>(), commits: new Map<string, CiProofCommit>(),
    runs: new Map<string, CiProofRunRow>(), reads: new Map<number, CiProofRead>(), down: false, calls: [] as string[] };
  let ids = 100;
  const port: CiProofPort = {
    mainHead: async () => { s.calls.push("main"); if (s.down) throw new Error("gh down"); const m = s.main; if (s.mainAfter) { s.main = s.mainAfter; s.mainAfter = null; } return m; },
    pull: async (_r, pr) => { s.calls.push(`pull:${pr}`); const head = s.pulls.get(pr); if (!head) throw new Error(`no PR ${pr}`); return { head, base: sha("9"), state: "open" }; },
    commit: async (_r, c) => { const hit = s.commits.get(c); if (!hit) throw new Error(`no commit ${c}`); return hit; },
    file: async (_r, _c, path) => (path === "bun.lock" ? LOCK : "      bun-version: 1.3.14\n"),
    runs: async (_r, head) => { const row = s.runs.get(head); return row ? [row] : []; },
    read: async (_r, id) => s.reads.get(id)!,
  };
  /** A run of `event` for `head` that checked out `checkout` (parents = what that commit merged), finished with a full manifest. */
  const prove = (event: "pull_request" | "push", head: string, checkout: string, parents: string[], status = "completed", conclusion = "success") => {
    const id = ++ids, base = event === "push" ? parents[0]! : sha("9");
    const content = { version: CI_PROOF_MANIFEST_VERSION, repo: REPO, head, base, checkout: { sha: checkout, tree: TREE }, workflow: { path: CI_PROOF_WORKFLOW, sha: checkout },
      policyVersion: CI_PROOF_POLICY, toolchain: { bun: "1.3.14", lockfileDigest: digest(LOCK) }, tests: { universeDigest: digest("t"), selectedDigest: digest("t"), count: 1 },
      scope: "full", checks: ["ci"] };
    const parsed = parseCiProofManifest(content);
    s.commits.set(checkout, { sha: checkout, tree: TREE, parents });
    s.runs.set(head, { id, event, headSha: head, status });
    s.reads.set(id, { event, checkout, evidence: { origin: "actions-api", repo: REPO, runId: id, attempt: 1, latestAttempt: 1, workflow: { path: CI_PROOF_WORKFLOW, sha: checkout },
      headSha: head, status, conclusion, jobs: [{ name: "ci", attempt: 1, conclusion, checkoutSha: checkout, checkoutTree: TREE }],
      artifact: { runId: id, attempt: 1, digest: parsed.ok ? ciProofManifestDigest(parsed.manifest) : "", content } } });
  };
  s.pulls.set(7, HEAD);
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
function driver(extra: Partial<MergeExternal> = {}) {
  let row = run0, merged = false;
  const calls: string[] = [];
  const snap = (): PrSnapshot => ({ state: merged ? "MERGED" : "OPEN", head: HEAD, branch: "feat/t9", base: "main", draft: false, crossRepository: false,
    mergeState: "CLEAN", mergeSha: merged ? MERGED : null, checks: [{ name: "ci", bucket: "pass" }] });
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
    expect(d.row.reason).toMatch(/合并未发出：full 证明绑定的 main 111111111111 已变成 000000000000/);
    expect(d.calls.some((c) => c.startsWith("merge:"))).toBe(false);
    const bare = driver(), unproven = github();
    gate("on", unproven);
    await expect(bare.gated().merge(PR, HEAD)).rejects.toThrow(/合并未发出：缺 full 证明/);
    expect(bare.calls).toEqual([]);
    unproven.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    expect(await bare.gated().merge(PR, HEAD)).toBe(MERGED);
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
    gate("observe", down);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.calls).toEqual(plain.calls);
    const off = github(), o = driver();
    gate("off", off);
    await driveMerge(o.row, o.gated(), o.advance);
    expect([o.calls, off.s.calls]).toEqual([plain.calls, []]);
    const proven = github(), p = driver(), db = gate("observe", proven);
    proven.prove("pull_request", HEAD, TEST_MERGE, [MAIN, HEAD]);
    await driveMerge(p.row, p.gated(), p.advance);
    expect([p.calls, notes(db)]).toEqual([plain.calls, []]);
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

describe("[验收线 3] train members: boarding needs no proof; a cleared member merges on the full proof of the car that carried it", () => {
  const train = (cars: Partial<TrainState["cars"][number]>[] = [{ status: "green", pr: 90, members: ["T8", "T9"] }]): TrainState => ({
    v: 1, id: "train-1", seq: 1, project: "p", repo: REPO, base: TRAIN_BASE, phase: "settling", outcome: null, reason: null, members: [], cleared: ["T9"], merged: [], bounced: [],
    serial: [], dropped: [], ciRuns: 1, startedAt: 1, updatedAt: 1, skip: [],
    cars: cars.map((c, i) => ({ id: `c${i}`, level: 0, parent: null, members: [], branch: `train/c${i}`, created: true, assembled: [], pr: null, status: "ci", startedAt: 1, ...c })),
  });

  test("on: cleared → wait until the car's PR (combined head merged onto the train's base) has its full proof; every other answer passes untouched", async () => {
    const gh = github();
    gh.s.pulls.set(90, CAR_HEAD);
    gate("on", gh);
    expect(await ciProofTrain("cleared", train(), run0)).toBe("wait");
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [MAIN, CAR_HEAD]); // tested on main, not on the train's base: not this train's combination
    expect(await ciProofTrain("cleared", train(), run0)).toBe("wait");
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [TRAIN_BASE, CAR_HEAD]);
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
    gh.prove("pull_request", CAR_HEAD, CAR_MERGE, [TRAIN_BASE, CAR_HEAD]);
    await driveMerge(d.row, d.gated(), d.advance);
    expect(d.row.phase).toBe("merged");
    expect(gh.s.calls).not.toContain("pull:7");
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
    expect(src("scheduler-pass.ts")).toContain("openCiProofGate(db, config, opts.recoveryPolicy, guard(active, runBounded));");
    for (const f of ["scheduler-plan.ts", "scheduler-pass.ts", "scheduler-merge-external.ts", "scheduler-merge-train-tick.ts"]) {
      expect(src(f).split("\n").filter((l) => /ciProof|CiProof/.test(l)).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("[验收线 1][验收线 3] deploy tick: the main commit that would be deployed needs its own full proof", () => {
  const LABEL = `com.claudestra.scheduler.deploy.${"f".repeat(32)}`;
  function jobs() {
    const log: string[] = [];
    const j: DeployJobs = { label: () => LABEL, observe: async () => null, remove: async () => true,
      submit: async () => { log.push("submit"); return LABEL; } };
    return { log, j };
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

  test("observe deploys exactly as before and records the would-wait; off reads nothing", async () => {
    const gh = merged(), { log, j } = jobs(), db = gate("observe", gh);
    await tick(db, j);
    expect([log, getDeployRun(db, "m9")?.phase]).toEqual([["submit"], "running"]);
    expect(notes(db)).toMatchObject([{ stage: "deploy", reasons: [expect.stringMatching(/还没有 main push 的 CI run/)] }]);
    setCiProofPortsForTest(null); card!.close(); card = null;
    const quiet = merged(), off = jobs(), db2 = gate("off", quiet);
    await tick(db2, off.j);
    expect([off.log, quiet.s.calls]).toEqual([["submit"], []]);
  });
});
