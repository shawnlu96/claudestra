/**
 * merge-arch-FULL1: scripts/ci-proof-artifact.ts, the full CI run writing its own coverage proof. Today's artifacts (four shard
 * logs, nothing else) are first shown passing the existing gate and yielding no proof (the red side); then a missed shard, a
 * failed typecheck / guard / entry build, artifacts left from an earlier attempt and the web build under off / observe / on.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_PROOF_POLICY_VERSION, PROOF_JOBS, WEB_BUILD_JOB, buildCiProof, proofRun, runWebBuild, sha256, shardFacts, webBuildNotice,
  type ProofInput, type RunCommand,
} from "../scripts/ci-proof-artifact.ts";
import { planShards, verifyShards } from "../scripts/ci-test-shard.ts";
import { type CiProofExpect, type CiRunEvidence, verifyCiProof } from "../src/lib/ci-proof.js";
import { parseCiProofManifest } from "../src/lib/ci-proof-manifest.js";
import { CI_WEB_BUILD_BUDGET, CI_WEB_BUILD_CHECK, type CiWebBuildMode, type CiWebBuildOutcome } from "../src/lib/ci-web-build-policy.js";

const sha = (c: string) => c.repeat(40);
const files = Array.from({ length: 23 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`);
const SHA = sha("a"), BUN = "1.3.14", LOCK = "lockfile v1\n";
const ENV = {
  GITHUB_REPOSITORY: "shawnlu96/claudestra", GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: SHA,
  GITHUB_WORKFLOW_REF: "shawnlu96/claudestra/.github/workflows/ci.yml@refs/pull/7/merge", GITHUB_WORKFLOW_SHA: sha("5"),
};
const PR_EVENT = { pull_request: { head: { sha: sha("1") }, base: { sha: sha("2") } } };
const plan = planShards(files, 4);
const logOf = (k: number, ran = plan[k - 1]!) =>
  [`shard=${k}/4`, `head=${SHA}`, `discovered=${files.length}`, `bun test v${BUN} (0d9b296a)`, "",
    ...ran.flatMap((f) => [`::group::${f}:`, "(pass) ok [1.00ms]", "::endgroup::"]), " 9 pass", " 0 fail"].join("\n");
const CORE_OK = { JOB_STATUS: "success", CORE_TYPECHECK: "success", CORE_GUARD: "success", CORE_BUILD: "success" };
const webFacts = (mode: CiWebBuildMode, outcome: CiWebBuildOutcome, over: Record<string, unknown> = {}) => ({
  version: 1, job: WEB_BUILD_JOB, runId: 900, attempt: 2, head: SHA, status: "success",
  webBuild: { mode, outcome, seconds: 41, depsCacheHit: false }, ...over,
});
const ALL_GREEN = { tests: "success", check: "success", web: "success", desktop: "success", [WEB_BUILD_JOB]: "success" };

/** A run where everything holds: four shard logs with their facts from this attempt and an observe web build that passed. */
function input(over: Partial<ProofInput> = {}): ProofInput {
  const shardLogs = new Map([1, 2, 3, 4].map((k) => [`test-shard-${k}`, logOf(k)]));
  const facts = new Map<string, unknown>([1, 2, 3, 4].map((k) => [`ci-facts-shard-${k}`, shardFacts({ ...ENV, ...CORE_OK }, k, logOf(k))]));
  facts.set("ci-facts-web-build", webFacts("observe", "success"));
  return {
    run: proofRun(ENV, PR_EVENT), checkout: { sha: SHA, tree: sha("4") }, bunVersion: BUN, lockfile: LOCK, files, needs: ALL_GREEN,
    shardLogs, facts, webBuildMode: "observe", ...over,
  };
}
const withFacts = (name: string, value: unknown, base = input()) => ({ ...base, facts: new Map(base.facts).set(name, value) });
const refused = (i: ProofInput) => {
  const r = buildCiProof(i);
  expect(r.manifest).toBeNull();
  expect(r.report).toMatchObject({ verdict: "refused", manifestDigest: null });
  expect(r.report.refusals.length).toBeGreaterThan(0);
  return r.report.refusals.join("\n");
};

describe("[验收线 1] only a complete run of one attempt writes a full proof", () => {
  test("red first: today's artifacts (four covering shard logs, green jobs) pass the existing gate and carry no proof", () => {
    const today = input({ facts: new Map() });
    expect(verifyShards(today.shardLogs, { n: 4, head: SHA, bunVersion: BUN, files })).toEqual([]);
    expect(refused(today)).toContain("缺少工件 ci-facts-shard-1");
  });

  test("a complete run writes a manifest the CIPROOF1 verifier accepts as a merge-authorising full proof", () => {
    const { manifest, report } = buildCiProof(input());
    expect(report).toMatchObject({ verdict: "full", refusals: [], runId: 900, attempt: 2 });
    expect(parseCiProofManifest(JSON.parse(JSON.stringify(manifest)))).toMatchObject({ ok: true });
    expect(manifest).toMatchObject({
      repo: "shawnlu96/claudestra", head: sha("1"), base: sha("2"), checkout: { sha: SHA, tree: sha("4") }, scope: "full",
      workflow: { path: ".github/workflows/ci.yml", sha: sha("5") }, policyVersion: CI_PROOF_POLICY_VERSION,
      toolchain: { bun: BUN, lockfileDigest: sha256(LOCK) }, tests: { count: files.length, universeDigest: sha256(files.join("\n")) },
    });
    expect(manifest!.tests.selectedDigest).toBe(manifest!.tests.universeDigest);
    expect(manifest!.checks).toEqual(Object.values(PROOF_JOBS).flat());
    const expectSubject: CiProofExpect = {
      repo: manifest!.repo, head: sha("1"), base: sha("2"), checkout: { sha: SHA, tree: sha("4") }, workflow: manifest!.workflow,
      policyVersion: CI_PROOF_POLICY_VERSION, toolchain: manifest!.toolchain, testsUniverseDigest: sha256(files.join("\n")),
      requiredChecks: ["typecheck + test + guard", "web typecheck + lint"],
    };
    const jobs = manifest!.checks.map((name) => ({ name, attempt: 2, conclusion: "success", checkoutSha: SHA, checkoutTree: sha("4") }));
    const evidence: CiRunEvidence = {
      origin: "actions-api", repo: manifest!.repo, runId: 900, attempt: 2, latestAttempt: 2, workflow: manifest!.workflow, headSha: sha("1"),
      status: "completed", conclusion: "success", jobs, artifact: { runId: 900, attempt: 2, digest: report.manifestDigest!, content: manifest },
    };
    expect(verifyCiProof(expectSubject, evidence)).toMatchObject({ ok: true, scope: "full", mergeAuthorized: true });
  });

  test("a push run binds the pushed commit and the commit before it", () => {
    const run = proofRun(ENV, { before: sha("9") });
    expect(buildCiProof(input({ run })).manifest).toMatchObject({ head: SHA, base: sha("9") });
    expect(refused(input({ run: proofRun(ENV, {}) }))).toContain("repo/head/base");
  });

  test("a missed shard: its log gone, one of its files not run, or its job not green", () => {
    const gone = input();
    gone.shardLogs.delete("test-shard-3");
    expect(refused(gone)).toContain("缺少工件 test-shard-3");
    const short = input();
    short.shardLogs.set("test-shard-2", logOf(2, plan[1]!.slice(1)));
    short.facts.set("ci-facts-shard-2", shardFacts({ ...ENV, ...CORE_OK }, 2, short.shardLogs.get("test-shard-2")!));
    expect(refused(short)).toContain("没跑到分给它的");
    for (const result of ["failure", "cancelled", "skipped"]) expect(refused(input({ needs: { ...ALL_GREEN, tests: result } }))).toContain(`tests 结果 ${result}`);
    const { tests: _dropped, ...noTests } = ALL_GREEN;
    expect(refused(input({ needs: noTests }))).toContain("tests 结果 未知");
  });

  test("typecheck, guard or the entry build not successful in shard 1, each on its own", () => {
    const steps = [["CORE_TYPECHECK", "typecheck"], ["CORE_GUARD", "guard"], ["CORE_BUILD", "入口构建"]] as const;
    for (const [key, label] of steps) {
      for (const outcome of ["failure", "skipped", "cancelled", ""]) {
        const facts = shardFacts({ ...ENV, ...CORE_OK, [key]: outcome }, 1, logOf(1));
        expect(refused(withFacts("ci-facts-shard-1", facts))).toContain(`${label} 步骤结果 ${outcome || "未知"}`);
      }
    }
    const { core: _core, ...noCore } = shardFacts({ ...ENV, ...CORE_OK }, 1, logOf(1));
    expect(refused(withFacts("ci-facts-shard-1", noCore))).toContain("typecheck 步骤结果 未知");
    expect(refused(withFacts("ci-facts-shard-1", shardFacts({ ...ENV, ...CORE_OK, JOB_STATUS: "failure" }, 1, logOf(1))))).toContain("作业状态 failure");
  });

  test("the other required jobs: check, web and desktop must each be green", () => {
    for (const job of ["check", "web", "desktop"]) {
      expect(refused(input({ needs: { ...ALL_GREEN, [job]: "failure" } }))).toContain(`${PROOF_JOBS[job]![0]} 结果 failure`);
    }
  });

  test("artifacts across attempts: a shard not re-run keeps the earlier attempt's facts and is refused", () => {
    const stale = shardFacts({ ...ENV, ...CORE_OK, GITHUB_RUN_ATTEMPT: "1" }, 4, logOf(4));
    expect(refused(withFacts("ci-facts-shard-4", stale))).toContain("来自 run 900 attempt 1，不是本次 run 900 attempt 2");
    const otherRun = shardFacts({ ...ENV, ...CORE_OK, GITHUB_RUN_ID: "899" }, 4, logOf(4));
    expect(refused(withFacts("ci-facts-shard-4", otherRun))).toContain("来自 run 899 attempt 2");
    const otherHead = shardFacts({ ...ENV, ...CORE_OK, GITHUB_SHA: sha("b") }, 4, logOf(4));
    expect(refused(withFacts("ci-facts-shard-4", otherHead))).toContain("≠ 本次检出");
  });

  test("this attempt's facts beside an earlier attempt's log, another shard's facts, junk or an extra facts artifact", () => {
    const oldLog = input();
    oldLog.shardLogs.set("test-shard-2", `${logOf(2)}\n(rerun residue)`);
    expect(refused(oldLog)).toContain("日志不是这次 attempt 的");
    expect(refused(withFacts("ci-facts-shard-2", shardFacts({ ...ENV, ...CORE_OK }, 3, logOf(2))))).toContain("不是 test-shard-2 的事实");
    for (const junk of [null, "success", [], { version: 2 }, { ...shardFacts({ ...ENV, ...CORE_OK }, 2, logOf(2)), attempt: "2" }]) {
      expect(refused(withFacts("ci-facts-shard-2", junk)).length).toBeGreaterThan(0);
    }
    expect(refused(withFacts("ci-facts-shard-5", shardFacts({ ...ENV, ...CORE_OK }, 4, logOf(4))))).toContain("多出来的事实工件：ci-facts-shard-5");
    expect(refused(input({ checkout: { sha: sha("c"), tree: sha("4") } }))).toContain("证明作业检出");
  });

  test("facts cannot be written without a trusted run id, attempt and head", () => {
    for (const bad of [{ GITHUB_RUN_ID: "" }, { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_SHA: "main" }]) {
      expect(() => shardFacts({ ...ENV, ...CORE_OK, ...bad }, 1, "")).toThrow("不是合法值");
    }
  });
});

describe("[验收线 2] the web production build under off / observe / on", () => {
  const observeFail = () => withFacts("ci-facts-web-build", webFacts("observe", "failure"));

  test("observe: a failed or timed-out build is only a would-reject; the proof is the same one a passing build gives", () => {
    const pass = buildCiProof(input());
    expect(pass.report.webBuild).toEqual({ mode: "observe", outcome: "success", seconds: 41, depsCacheHit: false, wouldReject: null });
    for (const outcome of ["failure", "timeout"] as const) {
      const r = buildCiProof(withFacts("ci-facts-web-build", webFacts("observe", outcome)));
      expect(r.report).toMatchObject({ verdict: "full", refusals: [], manifestDigest: pass.report.manifestDigest });
      expect(r.report.webBuild).toMatchObject({ outcome, wouldReject: `web 生产构建结果 ${outcome}` });
      expect(r.manifest!.checks).not.toContain(CI_WEB_BUILD_CHECK);
    }
  });

  test("observe: a missing, stale or malformed build result is also only a would-reject", () => {
    const none = input();
    none.facts.delete("ci-facts-web-build");
    const stale = withFacts("ci-facts-web-build", webFacts("observe", "success", { attempt: 1 }));
    const junk = withFacts("ci-facts-web-build", { ...webFacts("observe", "success"), webBuild: { mode: "observe", outcome: "great" } });
    const redJob = input({ needs: { ...ALL_GREEN, [WEB_BUILD_JOB]: "failure" } });
    for (const i of [none, stale, junk, redJob]) {
      const r = buildCiProof(i);
      expect(r.report.verdict).toBe("full");
      expect(r.report.webBuild.wouldReject).toContain("web 生产构建");
    }
  });

  test("on: a successful build of this attempt joins the proof's checks", () => {
    const r = buildCiProof(withFacts("ci-facts-web-build", webFacts("on", "success"), input({ webBuildMode: "on" })));
    expect(r.report).toMatchObject({ verdict: "full", refusals: [] });
    expect(r.manifest!.checks).toEqual([...Object.values(PROOF_JOBS).flat(), CI_WEB_BUILD_CHECK]);
  });

  test("on: a failed, timed-out, skipped, missing, stale or other-mode build blocks the full proof", () => {
    const on = () => input({ webBuildMode: "on" });
    for (const outcome of ["failure", "timeout", "skipped"] as const) {
      expect(refused(withFacts("ci-facts-web-build", webFacts("on", outcome), on()))).toContain(`${CI_WEB_BUILD_CHECK}（on）：结果 ${outcome}`);
    }
    const none = on();
    none.facts.delete("ci-facts-web-build");
    expect(refused(none)).toContain("缺少工件 ci-facts-web-build");
    expect(refused(withFacts("ci-facts-web-build", webFacts("on", "success", { attempt: 1 }), on()))).toContain("attempt 1，不是本次");
    expect(refused(withFacts("ci-facts-web-build", webFacts("observe", "success"), on()))).toContain("按 observe 模式跑的");
    const redJob = withFacts("ci-facts-web-build", webFacts("on", "success"), input({ webBuildMode: "on", needs: { ...ALL_GREEN, [WEB_BUILD_JOB]: "failure" } }));
    expect(refused(redJob)).toContain("作业结果 failure");
  });

  test("off: the build result is not read at all and the proof is the pre-build one", () => {
    const observed = buildCiProof(input()).report.manifestDigest;
    const noBuild = input({ webBuildMode: "off", needs: { tests: "success", check: "success", web: "success", desktop: "success" } });
    noBuild.facts.delete("ci-facts-web-build");
    for (const i of [noBuild, input({ webBuildMode: "off" }), { ...observeFail(), webBuildMode: "off" as const }]) {
      const r = buildCiProof(i);
      expect(r.report).toMatchObject({ verdict: "full", manifestDigest: observed });
      expect(r.report.webBuild).toEqual({ mode: "off", outcome: null, seconds: null, depsCacheHit: null, wouldReject: null });
    }
  });

  describe("runWebBuild", () => {
    const deps = (results: { code: number | null; timedOut: boolean }[], exported = true) => {
      const calls: { cmd: string; cwd: string; timeoutMs: number }[] = [];
      let t = 0;
      const run: RunCommand = async (cmd, cwd, timeoutMs) => { calls.push({ cmd: cmd.join(" "), cwd, timeoutMs }); t += 30_000; return results[calls.length - 1]!; };
      return { calls, run, now: () => t, exported: () => exported, webDir: "/repo/web" };
    };
    const ok = { code: 0, timedOut: false };

    test("off runs nothing; observe and on run the user's install and build in web/, each under its finite budget", async () => {
      const off = deps([]);
      expect(await runWebBuild("off", off)).toEqual({ outcome: "skipped", seconds: 0, failed: null });
      expect(off.calls).toEqual([]);
      for (const mode of ["observe", "on"] as const) {
        const d = deps([ok, ok]);
        expect(await runWebBuild(mode, d)).toEqual({ outcome: "success", seconds: 60, failed: null });
        expect(d.calls).toEqual([
          { cmd: "npm install --ignore-scripts --no-audit --no-fund", cwd: "/repo/web", timeoutMs: CI_WEB_BUILD_BUDGET.installMinutes * 60_000 },
          { cmd: "npm run build", cwd: "/repo/web", timeoutMs: CI_WEB_BUILD_BUDGET.buildMinutes * 60_000 },
        ]);
      }
    });

    test("a failing install stops before the build; a non-zero build, a timeout and a build with no export are not successes", async () => {
      const install = deps([{ code: 1, timedOut: false }]);
      expect(await runWebBuild("observe", install)).toMatchObject({ outcome: "failure", failed: "npm install --ignore-scripts --no-audit --no-fund 退出码 1" });
      expect(install.calls).toHaveLength(1);
      expect(await runWebBuild("on", deps([ok, { code: 2, timedOut: false }]))).toMatchObject({ outcome: "failure", failed: "npm run build 退出码 2" });
      expect(await runWebBuild("on", deps([ok, { code: null, timedOut: true }]))).toMatchObject({ outcome: "timeout", seconds: 60 });
      expect(await runWebBuild("on", deps([ok, { code: null, timedOut: false }]))).toMatchObject({ outcome: "failure" });
      expect(await runWebBuild("observe", deps([ok, ok], false))).toMatchObject({ outcome: "failure", failed: "构建后没有 web/out/index.html" });
    });

    test("the sample line PM reads: mode, outcome, seconds, cold or warm dependencies, would-reject only under observe", () => {
      expect(webBuildNotice("observe", { outcome: "failure", seconds: 75 }, false))
        .toBe("::notice title=ci-web-build::mode=observe outcome=failure seconds=75 deps-cache=miss would-reject=1");
      expect(webBuildNotice("observe", { outcome: "success", seconds: 40 }, true)).toContain("deps-cache=hit would-reject=0");
      expect(webBuildNotice("on", { outcome: "failure", seconds: 75 }, false)).toContain("mode=on outcome=failure seconds=75 deps-cache=miss would-reject=0");
      expect(webBuildNotice("off", { outcome: "skipped", seconds: 0 }, false)).toContain("mode=off outcome=skipped seconds=0");
    });
  });
});

describe("[验收线 3] the proof job is wired beside the existing paths, not into them", () => {
  const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
  const job = (id: string) => new RegExp(`^  ${id}:\\n((?:    .*\\n|\\n)*)`, "m").exec(`${ci}\n`)?.[1] ?? "";

  test("every job the proof names exists under that check name, and the proof waits for all of them", () => {
    const names = [...ci.matchAll(/^    name: (.+)$/gm)].map((m) => m[1]!);
    for (const name of Object.values(PROOF_JOBS).flat()) expect(names).toContain(name.replace(/shard \d of/, "shard ${{ matrix.shard }} of"));
    expect(job(WEB_BUILD_JOB)).toContain(`    name: ${CI_WEB_BUILD_CHECK}\n`);
    expect(job("proof")).toContain(`    needs: [${[...Object.keys(PROOF_JOBS).filter((j) => j !== "desktop"), WEB_BUILD_JOB, "desktop"].join(", ")}]\n`);
    expect(job("proof")).toContain("    if: always()\n");
  });

  test("the proof reuses the existing artifacts and both it and the build read the same mode variable", () => {
    expect(job("proof")).toContain("bun scripts/ci-proof-artifact.ts prove shards facts");
    expect(job("proof")).toContain("NEEDS: ${{ toJSON(needs) }}");
    expect(job("tests")).toContain("bun scripts/ci-proof-artifact.ts shard-facts ${{ matrix.shard }}");
    for (const key of ["typecheck", "guard", "build"]) {
      expect(job("tests")).toContain(`        id: ${key}\n`);
      expect(job("tests")).toContain(`CORE_${key.toUpperCase()}: \${{ steps.${key}.outcome }}`);
    }
    for (const id of ["proof", WEB_BUILD_JOB]) expect(job(id)).toContain("CI_WEB_BUILD: ${{ vars.CI_WEB_BUILD }}");
  });

  test("neither new job can turn a run red on its own: no step of theirs exits non-zero outside the on build", () => {
    // the train bounces a car on any failed check (scheduler-merge-train.ts ciVerdict), so only the on-mode build may fail
    expect(job("proof").match(/continue-on-error: true/g)).toHaveLength(3);
    expect([...job(WEB_BUILD_JOB).matchAll(/^ +run: (.+)$/gm)].map((m) => m[1])).toEqual(['bun scripts/ci-proof-artifact.ts web-build "$RUNNER_TEMP/job-facts.json"']);
    expect([...job("proof").matchAll(/^ +run: (.+)$/gm)].map((m) => m[1])).toEqual(['bun scripts/ci-proof-artifact.ts prove shards facts "$RUNNER_TEMP/ci-proof"']);
    expect(job("check")).not.toContain("ci-proof-artifact");
    expect(job("check")).not.toContain("web-build");
  });
});
