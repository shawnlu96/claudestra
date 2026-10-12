/**
 * merge-arch-CISHARD1：慢清单（tests/slow-tests.txt）只在夜间跑。这里锁住两个 workflow 里的这一段——nightly.yml 只跑慢清单，
 * ci.yml 的分片（PR 与 push main）排除慢清单——以及这两条命令实际打印的清单。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCiProof, proofRun, sha256, shardFacts, type ProofInput } from "../scripts/ci-proof-artifact.ts";
import { SLOW_MAX_FILES, parseSlowList, planShards, slowProblems, testFiles, withoutSlow } from "../scripts/ci-test-shard.ts";

const root = join(import.meta.dir, "..");
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8");
type Step = { name?: string; uses?: string; run?: string; shell?: string };
type Job = { name: string; if?: string; needs?: unknown; "timeout-minutes": number; strategy?: { matrix: Record<string, number[]> }; steps: Step[] };
type Workflow = { name: string; on: Record<string, unknown>; concurrency?: { group: string }; jobs: Record<string, Job> };
const ci = Bun.YAML.parse(read(".github", "workflows", "ci.yml")) as Workflow;
const nightly = Bun.YAML.parse(read(".github", "workflows", "nightly.yml")) as Workflow;
const slow = parseSlowList(read("tests", "slow-tests.txt"));
const all = testFiles(Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString());
/** What `bun run test:shard <args>` prints: one ./path per line. */
const listed = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", "scripts/ci-test-shard.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString().trim().split("\n").map((f) => f.replace(/^\.\//, ""));
};
const step = (job: Job, name: string) => job.steps.find((s) => s.name === name)!;

describe("[验收线 3] the slow list runs at night and only at night", () => {
  test("the slow list is real files, each once, within the cap, each with its measured seconds", () => {
    expect(slow.length).toBeGreaterThan(0);
    expect(slow.length).toBeLessThanOrEqual(SLOW_MAX_FILES);
    expect(slowProblems(slow, all)).toEqual([]);
    const rows = read("tests", "slow-tests.txt").split("\n").filter((l) => l && !l.startsWith("#"));
    for (const row of rows) expect(row).toMatch(/^tests\/[\w.-]+\.test\.ts # \d+(\.\d+)?$/);
  });

  test("nightly.yml: 18:00 UTC and manual, two parts, the test step runs only what `test:shard slow` prints", () => {
    expect(Object.keys(nightly.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(nightly.on.schedule).toEqual([{ cron: "0 18 * * *" }]);
    expect(Object.keys(nightly.jobs)).toEqual(["slow"]);
    const job = nightly.jobs.slow!;
    expect(job.strategy!.matrix).toEqual({ part: [1, 2] });
    const runs = job.steps.filter((s) => s.run?.includes("bun test"));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      name: "Slow tests", shell: "bash",
      run: [
        'bun run --silent test:shard slow ${{ matrix.part }}/2 > "$RUNNER_TEMP/files.txt"', 'mapfile -t files < "$RUNNER_TEMP/files.txt"',
        '[ "${#files[@]}" -gt 0 ]', 'bun test "${files[@]}"', "",
      ].join("\n"),
    });
    expect([...listed("slow", "1/2"), ...listed("slow", "2/2")].sort()).toEqual([...slow].sort());
  });

  test("nightly.yml is no PR's check: its own triggers, its own concurrency group, no proof artifact, none of CI's check names", () => {
    expect(nightly.name).not.toBe(ci.name);
    expect(nightly.concurrency!.group).toBe("nightly-slow-tests-${{ github.ref }}");
    expect(nightly.concurrency!.group).not.toContain("github.workflow");
    for (const s of nightly.jobs.slow!.steps) {
      expect(s.uses ?? "").not.toContain("upload-artifact");
      expect(s.run ?? "").not.toContain("ci-proof");
    }
    const ciNames = Object.values(ci.jobs).map((j) => j.name);
    for (const j of Object.values(nightly.jobs)) expect(ciNames).not.toContain(j.name);
  });

  test("ci.yml: PR and push run eight shards, none of them prints a slow file, together they print every other test file once", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]); // dispatch = the serial full re-check (SELECT1)
    const tests = ci.jobs.tests!;
    expect(tests.name).toBe("test shard ${{ matrix.shard }} of 8");
    expect(tests.strategy!.matrix).toEqual({ shard: [1, 2, 3, 4, 5, 6, 7, 8] });
    const unit = step(tests, "Unit tests").run!;
    expect(unit).toContain('bun run --silent test:shard ${{ matrix.shard }}/8 > "$RUNNER_TEMP/files.txt"\n');
    expect(unit).toContain("printf 'shard=%s/8\\n");
    expect(unit).toContain('bun test "${files[@]}" 2>&1 | tee -a "$RUNNER_TEMP/shard.log"');
    expect(unit).not.toContain("slow");
    // full runs (push / train / dispatch / a PR not under on) keep the whole-suite check; a dispatch checks out the request's merge commit
    const full = step(ci.jobs.check!, "Shards cover every test file exactly once") as { run?: string; if?: string; env?: Record<string, string> };
    expect(full).toMatchObject({ run: 'bun run --silent test:shard verify shards 8 "$CHECKOUT_SHA"', if: "needs.plan.outputs.scope != 'related'",
      env: { CHECKOUT_SHA: "${{ inputs.merge || github.sha }}" } });
    expect((step(ci.jobs.check!, "Shards cover the related selection exactly once") as { if?: string }).if).toBe("needs.plan.outputs.scope == 'related'");
    for (const j of Object.values(ci.jobs)) for (const s of j.steps) expect(s.run ?? "").not.toContain("test:shard slow");
    const ran = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => listed(`${k}/8`));
    for (const f of slow) expect(ran).not.toContain(f);
    expect([...ran].sort()).toEqual(all.filter((f) => !slow.includes(f)));
  });

  test("typecheck, guard and the entry build stay on shard 1", () => {
    for (const name of ["Typecheck (tsc --noEmit)", "Guard (ratchets)", "Build entrypoints"]) {
      expect((step(ci.jobs.tests!, name) as { if?: string }).if).toBe("matrix.shard == 1");
    }
  });
});

describe("the coverage proof counts what the shards cover: every test file minus the slow list", () => {
  const SHA = "a".repeat(40), KS = [1, 2, 3, 4, 5, 6, 7, 8];
  const ENV = {
    GITHUB_REPOSITORY: "shawnlu96/claudestra", GITHUB_RUN_ID: "900", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: SHA, GITHUB_WORKFLOW_SHA: "5".repeat(40),
    GITHUB_WORKFLOW_REF: "shawnlu96/claudestra/.github/workflows/ci.yml@refs/heads/main",
    JOB_STATUS: "success", CORE_TYPECHECK: "success", CORE_GUARD: "success", CORE_BUILD: "success",
  };
  const files = Array.from({ length: 30 }, (_, i) => `tests/f${String(i).padStart(2, "0")}.test.ts`), late = [files[3]!, files[17]!];
  const proofOf = (slowList: string[], planned: string[]) => {
    const plan = planShards(planned, 8);
    const logOf = (k: number) => [`shard=${k}/8`, `head=${SHA}`, `discovered=${files.length}`, "bun test v1.3.14 (0d9b296a)", "",
      ...plan[k - 1]!.flatMap((f) => [`::group::${f}:`, "::endgroup::"])].join("\n");
    const input: ProofInput = {
      run: proofRun(ENV, { before: "2".repeat(40) }), checkout: { sha: SHA, tree: "4".repeat(40) }, bunVersion: "1.3.14", lockfile: "lock", files, slow: slowList,
      needs: { tests: "success", check: "success", web: "success", desktop: "success", "web-build": "success" }, webBuildMode: "off",
      shardLogs: new Map(KS.map((k) => [`test-shard-${k}`, logOf(k)])),
      facts: new Map<string, unknown>(KS.map((k) => [`ci-facts-shard-${k}`, shardFacts(ENV, k, logOf(k))])),
    };
    return buildCiProof(input);
  };
  test("shards that ran everything but the slow files: a full proof whose selected set is its universe", () => {
    const { manifest, report } = proofOf(late, withoutSlow(files, late));
    expect(report.refusals).toEqual([]);
    expect(manifest!.tests).toEqual({ universeDigest: sha256(withoutSlow(files, late).join("\n")), selectedDigest: manifest!.tests.universeDigest, count: 28 });
  });
  test("shards that also ran the slow files, or a slow list naming a missing file: no proof", () => {
    expect(proofOf(late, files).manifest).toBeNull();
    expect(proofOf([...late, "tests/gone.test.ts"], withoutSlow(files, late)).report.refusals).toContain("慢清单里有不存在的测试文件：tests/gone.test.ts");
  });
});
