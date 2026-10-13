/**
 * CARRY2: an update-branch where main and the card touched the same file without conflict keeps the review under
 * mainCarryMerge=on (await_ci), goes back to review under observe (one "on 会沿用" note) and off (unchanged refusal);
 * a hand-edited merge, a changed card side, a conflict resolution and binary / mode / gitlink changes always go back to review.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryMode, RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { mainCarryMergeMode, sameCardChange } from "../src/lib/review-main-carry-merge-proof.js";
import { reviewMainCarryProof } from "../src/lib/review-main-carry-proof.js";
import { runBounded } from "../src/lib/run-bounded.js";
import { parseSchedulerConfig, SCHEDULER_CONFIG_PATH, type SchedulerConfig } from "../src/lib/scheduler-config.js";
import { driveMerge, type MergeExternal, type PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeExternal } from "../src/lib/scheduler-merge-external.js";
import type { MergeRun } from "../src/lib/scheduler-merge.js";

const PR = "https://github.com/example/carry2/pull/1";
const VERBATIM = "合并 main 后 PR 对 main 的净 diff 变了";
const lines = (over: Record<number, string> = {}, insertAfter2?: string) => {
  const out: string[] = [];
  for (let i = 1; i <= 20; i++) { out.push(over[i] ?? `line ${i}`); if (i === 2 && insertAfter2) out.push(insertAfter2); }
  return `${out.join("\n")}\n`;
};

describe("CARRY2 clean-merge main carry", () => {
  let root = "", work = "", base = "", oldHead = "", mainA = "", mainB = "", mainC = "";
  const heads: Record<string, string> = {};
  const sh = async (...args: string[]) => {
    const r = await runBounded(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: work, timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${args[0]}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim();
  };
  const file = (path: string, value: string | Buffer) => writeFileSync(join(work, path), value);
  const commit = async (message: string) => { await sh("add", "-A"); await sh("commit", "-qm", message); return sh("rev-parse", "HEAD"); };
  const at = async (head: string) => { await sh("reset", "--hard", "-q"); await sh("checkout", "-q", "--detach", head); };
  const merge = async (head: string, mainParent: string) => { await at(head); await sh("merge", "-q", "--no-edit", mainParent); return sh("rev-parse", "HEAD"); };
  /** a card branched from base: shared lines 5 and 15 changed plus `extra` applied */
  const card = async (name: string, extra: () => Promise<void> = async () => {}) => {
    await at(base); file("shared", lines({ 5: "card five", 15: "card fifteen" })); file(`card-${name}`, `${name}\n`);
    await extra(); return commit(`card ${name}`);
  };
  const gitCommand: typeof runBounded = async (argv, opts) => {
    if (argv[0] !== "git") throw new Error("Only local git is allowed");
    if (argv.includes("fetch")) return { code: 0, stdout: "", stderr: "", timedOut: false }; // objects already in this temporary repo
    return runBounded(argv, opts);
  };
  const prove = (newHead: string, mode: RecoveryMode, reviewed = oldHead) =>
    reviewMainCarryProof({ repoDir: work, repository: "example/carry2", base: "main", mainHead: mainC, oldHead: reviewed, newHead }, undefined, () => mode);
  const project = () => parseSchedulerConfig({ enabled: true, projects: { p: { repoDir: work, maxActiveWorkers: 2, requiredChecks: ["test"] } } }).projects.p;
  const policy = (mode?: RecoveryMode) => {
    writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { repoDir: work, maxActiveWorkers: 2, requiredChecks: ["test"] } } }));
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: mode ? { p: { keys: { mainCarryMerge: mode } } } : {} }));
  };
  /** The real driver after update-branch: carry → await_ci, refusal → await_review; every step it asks for is recorded. */
  const drive = async (newHead: string, reviewed = oldHead) => {
    const steps: { to: string; receipt?: string; newHead?: string }[] = [];
    let run = { intentId: "i", taskId: "t", project: "p", prRef: PR, expectedBranch: "card", reviewedHead: reviewed, requiredChecks: "[\"test\"]",
      phase: "updating", rev: 1, mergeSha: null, reason: null, unknownSince: null } as unknown as MergeRun;
    const pr: PrSnapshot = { state: "OPEN", head: newHead, branch: "card", crossRepository: false, base: "main", draft: false,
      mergeState: "CLEAN", mergeSha: null, checks: [{ name: "test", bucket: "pending" }] };
    const real = mergeExternal(project(), gitCommand);
    const external: MergeExternal = { inspect: async () => pr, freshness: async () => ({ behindBy: 0, mainHead: mainC }),
      carryReview: (p, o, n) => real.carryReview(p, o, n), updateBranch: async () => {}, merge: async () => { throw new Error("no merge"); } };
    const final = await driveMerge(run, external, async (_from, to, _rev, receipt, _sha, head) => {
      steps.push({ to, receipt, newHead: head });
      run = { ...run, phase: to, rev: run.rev + 1, ...(to === "await_ci" && head ? { reviewedHead: head } : {}) };
      return run;
    });
    return { phase: final.phase, steps };
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "carry2-")); work = join(root, "repo"); mkdirSync(work);
    await sh("init", "-q", "-b", "main");
    await sh("remote", "add", "origin", "https://github.com/example/carry2.git");
    file("shared", lines()); file("blob", Buffer.from([0, 1, 2, 255])); file("run.sh", "echo run\n");
    base = await commit("base");
    oldHead = await card("clean");
    // main: A inserts a line near the top of the same file (shifts the card's hunks), B makes the card's line-15 change too,
    // C changes line 5 differently (conflicts with the card)
    await at(base); file("shared", lines({}, "main inserted")); mainA = await commit("main A");
    file("shared", lines({ 15: "card fifteen" }, "main inserted")); mainB = await commit("main B");
    file("shared", lines({ 5: "main five", 15: "card fifteen" }, "main inserted")); mainC = await commit("main C");
    await sh("update-ref", "refs/remotes/origin/main", mainC);
    heads.clean = await merge(oldHead, mainA);
    // a merge commit with the clean merge's parents but one hand-edited line
    await at(heads.clean); file("shared", lines({ 5: "card five", 15: "card fifteen", 18: "sneaked in" }, "main inserted"));
    await sh("add", "-A"); heads.hand = await sh("commit-tree", await sh("write-tree"), "-p", oldHead, "-p", mainA, "-m", "hand edit");
    heads.cardSide = await merge(oldHead, mainB); // clean, but the card's own line-15 change is now on main
    await at(oldHead);
    const conflicted = await runBounded(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "merge", "-q", "--no-edit", mainC], { cwd: work, timeoutMs: 30_000 });
    expect(conflicted.code).not.toBe(0);
    file("shared", lines({ 5: "card five", 15: "card fifteen" }, "main inserted"));
    await sh("add", "-A"); await sh("commit", "-qm", "resolved"); heads.resolved = await sh("rev-parse", "HEAD");
    heads.binaryOld = await card("binary", async () => file("blob", Buffer.from([0, 9, 8, 254])));
    heads.binary = await merge(heads.binaryOld, mainA);
    heads.modeOld = await card("mode", async () => chmodSync(join(work, "run.sh"), 0o755));
    heads.mode = await merge(heads.modeOld, mainA);
    await card("gitlink"); await sh("update-index", "--add", "--cacheinfo", `160000,${base},sub`); await sh("commit", "-qm", "gitlink");
    heads.gitlinkOld = await sh("rev-parse", "HEAD");
    heads.gitlink = await merge(heads.gitlinkOld, mainA);
  });
  afterEach(() => { rmSync(SCHEDULER_CONFIG_PATH, { force: true }); rmSync(RECOVERY_POLICY_PATH, { force: true }); });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  test("fixture: the byte-exact proof alone refuses the clean co-edit (index lines and hunk headers moved)", async () => {
    expect(await sh("diff", `${mainC}...${oldHead}`)).not.toBe(await sh("diff", `${mainC}...${heads.clean}`));
    expect(await prove(heads.clean, "off")).toEqual({ ok: false, reason: VERBATIM, mainParent: mainA, mainHead: mainC });
  });

  test("[验收线 1] on: a clean co-edit carries through the real carryReview and the driver goes to await_ci", async () => {
    const r = await prove(heads.clean, "on");
    expect(r).toMatchObject({ ok: true, oldHead, newHead: heads.clean, mainHead: mainC, mainParent: mainA,
      chain: [{ head: heads.clean, previousHead: oldHead, mainParent: mainA }] });
    expect(r.reason).toContain("干净合并");
    policy("on");
    const d = await drive(heads.clean);
    expect(d.phase).toBe("await_ci");
    expect(d.steps[0]).toMatchObject({ to: "await_ci", newHead: heads.clean });
    expect(d.steps[0]!.receipt).toStartWith(`沿用审查：原 head ${oldHead} → 新 head ${heads.clean}，main 父提交 ${mainA}，main 头 ${mainC}`);
  });

  test("[验收线 1] observe records only 'on 会沿用' and acts exactly like off; off adds nothing", async () => {
    const observed = await prove(heads.clean, "observe");
    expect(observed.ok).toBe(false);
    expect(observed.reason).toStartWith(`${VERBATIM}；mainCarryMerge=observe：on 会沿用（干净合并`);
    policy("observe");
    const o = await drive(heads.clean);
    policy("off");
    const f = await drive(heads.clean);
    expect(o.phase).toBe("await_review"); expect(f.phase).toBe("await_review");
    expect(o.steps.map((s) => [s.to, s.newHead])).toEqual(f.steps.map((s) => [s.to, s.newHead]));
    expect(o.steps.filter((s) => s.receipt?.includes("on 会沿用"))).toHaveLength(1);
    expect(f.steps[0]!.receipt).toBe(`update-branch 改了 head：原 head ${oldHead} → 新 head ${heads.clean}，main 父提交 ${mainA}，${VERBATIM}，旧审查失效`);
    policy(); // no key: default observe
    expect((await drive(heads.clean)).steps[0]!.receipt).toContain("on 会沿用");
  });

  test("[验收线 2] on: hand edit, changed card side, conflict resolution, binary / mode / gitlink all go back to review", async () => {
    const cases: [string, string, RegExp][] = [
      [heads.hand!, oldHead, /手改/], [heads.cardSide!, oldHead, /卡侧/], [heads.resolved!, oldHead, /冲突/],
      [heads.binary!, heads.binaryOld!, /binary/], [heads.mode!, heads.modeOld!, /mode/], [heads.gitlink!, heads.gitlinkOld!, /gitlink/],
    ];
    policy("on");
    for (const [head, reviewed, why] of cases) {
      const r = await prove(head, "on", reviewed);
      expect([String(why), r.ok]).toEqual([String(why), false]);
      expect(r.reason).toStartWith(`${VERBATIM}；干净合并证明不成立：`);
      expect(r.reason).toMatch(why);
      const d = await drive(head, reviewed);
      expect(d.phase).toBe("await_review");
      expect(d.steps.map((s) => s.to)).toEqual(["await_review"]);
    }
  });

  test("[验收线 3] the byte-exact path is untouched: a pure main merge still carries as 净 diff 一致 under every mode", async () => {
    const pure = await card("pure", async () => file("shared", lines()));
    const merged = await merge(pure, mainA);
    for (const mode of ["off", "observe", "on"] as const) {
      expect(await prove(merged, mode, pure)).toMatchObject({ ok: true, reason: "净 diff 一致" });
    }
  });

  test("a git error or an unreadable object is a failure, never a pass", async () => {
    const r = await reviewMainCarryProof({ repoDir: work, repository: "example/carry2", base: "main", mainHead: mainC, oldHead, newHead: heads.clean! },
      async (argv, opts) => argv.includes("merge-tree") ? { code: 128, stdout: "", stderr: "fatal", timedOut: false } : runBounded(argv, opts), () => "on");
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toContain("干净合并证明读取失败");
  });

  test("mode: weakest project on the repoDir wins; unknown repoDir / unreadable policy is off", () => {
    const cfg = (dirs: Record<string, string>) => () => ({ projects: Object.fromEntries(Object.entries(dirs).map(([id, repoDir]) => [id, { repoDir }])) }) as unknown as SchedulerConfig;
    const port = (modes: Record<string, RecoveryMode | "error">) => (id: string): RecoveryPolicy =>
      modes[id] === "error" ? { mode: "off", manualAfterMs: null, source: "error" } : { mode: modes[id] as RecoveryMode, manualAfterMs: null, source: "config" };
    expect(mainCarryMergeMode("/r", cfg({ a: "/r", b: "/r" }), port({ a: "on", b: "on" }))).toBe("on");
    expect(mainCarryMergeMode("/r", cfg({ a: "/r", b: "/r" }), port({ a: "on", b: "observe" }))).toBe("observe");
    expect(mainCarryMergeMode("/r", cfg({ a: "/r", b: "/x" }), port({ a: "on", b: "off" }))).toBe("on");
    expect(mainCarryMergeMode("/r", cfg({ a: "/r" }), port({ a: "error" }))).toBe("off");
    expect(mainCarryMergeMode("/r", cfg({ a: "/x" }), port({ a: "on" }))).toBe("off");
    expect(mainCarryMergeMode("/r", () => { throw new Error("bad"); }, port({}))).toBe("off");
  });

  test("patch normalization drops only index lines and hunk-header numbers", () => {
    const patch = (index: string, hunk: string, plus: string) =>
      `diff --git a/f b/f\nindex ${index} 100644\n--- a/f\n+++ b/f\n@@ ${hunk} @@ ctx\n a\n-b\n+${plus}\n c\n`;
    expect(sameCardChange(patch("1..2", "-1,3 +1,3", "x"), patch("3..4", "-9,3 +9,3", "x")).ok).toBe(true);
    expect(sameCardChange(patch("1..2", "-1,3 +1,3", "x"), patch("1..2", "-1,3 +1,3", "y")).ok).toBe(false);
    expect(sameCardChange("", "").ok).toBe(true);
  });
});
