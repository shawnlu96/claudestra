/**
 * merge-arch-FULL1: src/lib/ci-web-build-policy.ts (the off / observe / on switch of the web production build and what a build
 * result does to the full proof), plus what ci.yml must keep while the new jobs sit beside it: the required check names, the
 * always() gate, fail-fast:false, the Guard wiring, the log markers the rerun parser reads and a finite timeout on every job.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CI_WEB_BUILD_BUDGET, CI_WEB_BUILD_CHECK, CI_WEB_BUILD_OUTCOMES, ciWebBuildMode, ciWebBuildPolicyMode, ciWebBuildRequiredChecks, judgeCiWebBuild,
} from "../src/lib/ci-web-build-policy.js";
import { RECOVERY_KEYS, recoveryPolicy } from "../src/lib/recovery-policy.js";

const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
const jobs = new Map([...`${ci.slice(ci.indexOf("\njobs:\n"))}\n`.matchAll(/^  ([\w-]+):\n((?:    .*\n|\n)*)/gm)].map((m) => [m[1]!, m[2]!]));
/** The train car's CI timeout (scheduler-merge-train.ts TRAIN_CI_TIMEOUT_MS, not exported): every job must end before it. */
const TRAIN_CI_TIMEOUT_MINUTES = 60;
const timeoutOf = (body: string) => Number(/^    timeout-minutes: (\d+)$/m.exec(body)?.[1] ?? NaN);

describe("[验收线 2] the switch and what a build result does", () => {
  test("the mode is off / observe / on; absent or anything else reads observe", () => {
    for (const m of ["off", "observe", "on"] as const) expect(ciWebBuildMode(m)).toBe(m);
    expect(ciWebBuildMode(" on\n")).toBe("on");
    for (const raw of [undefined, null, "", "ON", "true", "enabled", 1, {}, ["on"]]) expect(ciWebBuildMode(raw)).toBe("observe");
  });

  test("observe never blocks and never joins the proof: a build that did not succeed is a would-reject only", () => {
    expect(judgeCiWebBuild("observe", "success")).toEqual({ inProof: false, blocksProof: false, wouldReject: null });
    for (const outcome of ["failure", "timeout", "skipped"] as const) {
      expect(judgeCiWebBuild("observe", outcome)).toEqual({ inProof: false, blocksProof: false, wouldReject: `web 生产构建结果 ${outcome}` });
    }
    expect(judgeCiWebBuild("observe", null)).toEqual({ inProof: false, blocksProof: false, wouldReject: "web 生产构建没有本次运行的结果" });
  });

  test("on needs a success: every other result, or none, blocks the full proof", () => {
    expect(judgeCiWebBuild("on", "success")).toEqual({ inProof: true, blocksProof: false, wouldReject: null });
    for (const outcome of [...CI_WEB_BUILD_OUTCOMES.filter((o) => o !== "success"), null]) {
      expect(judgeCiWebBuild("on", outcome)).toEqual({ inProof: false, blocksProof: true, wouldReject: null });
    }
  });

  test("off is the path before this card: whatever the result, nothing joins, blocks or is recorded", () => {
    for (const outcome of [...CI_WEB_BUILD_OUTCOMES, null]) {
      expect(judgeCiWebBuild("off", outcome)).toEqual({ inProof: false, blocksProof: false, wouldReject: null });
    }
  });

  test("the merge side asks for the build's check only under on, once", () => {
    const required = ["typecheck + test + guard", "web typecheck + lint"];
    expect(ciWebBuildRequiredChecks("off", required)).toEqual(required);
    expect(ciWebBuildRequiredChecks("observe", required)).toEqual(required);
    expect(ciWebBuildRequiredChecks("on", required)).toEqual([...required, CI_WEB_BUILD_CHECK]);
    expect(ciWebBuildRequiredChecks("on", [...required, CI_WEB_BUILD_CHECK])).toEqual([...required, CI_WEB_BUILD_CHECK]);
  });

  test("the merge side's switch is the recovery key ciWebBuild, observe by default", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "ciWebBuild")).toHaveLength(1);
    const missing = join(import.meta.dir, "no-such-dir", "recovery-policy.json");
    expect(ciWebBuildPolicyMode("p", (project, key) => recoveryPolicy(project, key, missing))).toBe("observe");
    const asked: string[] = [];
    const port = (project: string, key: string) => { asked.push(`${project}:${key}`); return { mode: "on" as const, manualAfterMs: null, source: "config" as const }; };
    expect(ciWebBuildPolicyMode("claudestra", port)).toBe("on");
    expect(asked).toEqual(["claudestra:ciWebBuild"]);
  });
});

describe("[验收线 3] the existing paths keep what they read", () => {
  test("the required check names, the always() gate and fail-fast:false are as before", () => {
    expect(jobs.get("check")).toContain("    name: typecheck + test + guard\n    needs: tests\n    if: always()\n");
    expect(jobs.get("tests")).toContain("    name: test shard ${{ matrix.shard }} of 4\n");
    expect(jobs.get("tests")).toContain("      fail-fast: false\n");
    expect(jobs.get("web")).toContain("    name: web typecheck + lint\n");
    expect(jobs.get("desktop")).toContain("    name: desktop typecheck + cargo test\n");
    expect([...jobs.keys()]).toEqual(["tests", "check", "web", "web-build", "desktop", "proof"]);
  });

  test("the Guard step keeps GUARD_BASE and GUARD_STRICT, and the gate keeps the verdict line the rerun parser reads", () => {
    expect(jobs.get("tests")).toContain([
      "        run: bun run guard", "        env:",
      "          GUARD_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}", '          GUARD_STRICT: "1"', "",
    ].join("\n"));
    expect(jobs.get("check")).toContain([
      "      - name: All shards succeeded", "        run: |",
      '          [ "${{ needs.tests.result }}" = success ] || { echo "::error::分片没有全部成功：${{ needs.tests.result }}"; exit 1; }', "",
    ].join("\n"));
    expect(jobs.get("check")).toContain('        run: bun run --silent test:shard verify shards 4 "$GITHUB_SHA"\n');
    expect(jobs.get("tests")).toContain("          name: test-shard-${{ matrix.shard }}\n          path: ${{ runner.temp }}/shard.log\n");
  });

  test("runs of different PRs, main, train and manual PRs stay in their own groups; only a PR's own older run is cancelled", () => {
    expect(ci).toContain([
      "concurrency:", "  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}", "",
    ].join("\n"));
    expect(ci.match(/^ *concurrency:/gm)).toHaveLength(1);
    expect(ci.match(/cancel-in-progress/g)).toHaveLength(1);
  });

  test("the new build is not a dependency of any existing job", () => {
    const needs = (id: string) => /^    needs: (.+)$/m.exec(jobs.get(id)!)?.[1] ?? null;
    expect(["tests", "check", "web", "desktop"].map(needs)).toEqual([null, "tests", null, null]);
    expect(jobs.get("web-build")).not.toMatch(/^    needs:/m);
  });
});

describe("[验收线 4] every job has a finite timeout", () => {
  test("the timeouts set before this card are still there", () => {
    expect([...jobs].map(([id, body]) => [id, timeoutOf(body)])).toEqual(expect.arrayContaining([["tests", 35], ["check", 10], ["web", 15], ["desktop", 30]]));
  });

  test("each job states its own timeout-minutes, an integer below the train car's CI timeout", () => {
    expect(jobs.size).toBe(6);
    for (const [id, body] of jobs) {
      const minutes = timeoutOf(body);
      expect(`${id}:${Number.isInteger(minutes) && minutes > 0 && minutes < TRAIN_CI_TIMEOUT_MINUTES}`).toBe(`${id}:true`);
    }
  });

  test("the build's budget is finite and nested: the script's own bounds fit in the step's, the step's in the job's", () => {
    const b = CI_WEB_BUILD_BUDGET;
    for (const minutes of Object.values(b)) expect(Number.isInteger(minutes) && minutes > 0 && minutes <= 30).toBe(true);
    expect(b.installMinutes + b.buildMinutes).toBeLessThan(b.stepMinutes);
    expect(b.stepMinutes).toBeLessThan(b.jobMinutes);
    expect(timeoutOf(jobs.get("web-build")!)).toBe(b.jobMinutes);
    expect(jobs.get("web-build")).toContain(`      - name: Web production build\n        timeout-minutes: ${b.stepMinutes}\n`);
  });
});
