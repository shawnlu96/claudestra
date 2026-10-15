/**
 * merge-arch-CISEL1 [验收线 3]: the shard wiring and the gate of CI_SELECTED_GATE. The `Unit tests` step's own script is run under
 * bash -eo pipefail (as Actions does) with a stub bun, against main's version of the same step; the shard / gate subcommands of
 * scripts/ci-selected-verdict.ts are run for real in a throwaway repo whose HEAD is a test merge commit.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { responsibility } from "../src/lib/ci-selected-verdict.js";
import { gateVerdict, shardReceipt } from "../scripts/ci-selected-verdict.ts";
import { GATE, GATE_VERDICT } from "../src/lib/scheduler-merge-ci-rerun-log.js";

const ROOT = join(import.meta.dir, "..");
interface Step { name?: string; id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>;
  "continue-on-error"?: boolean | string }
const ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { name: string; steps: Step[] }> };
const steps = (job: string) => ci.jobs[job]!.steps;
const MODE = "${{ vars.CI_SELECTED_GATE == 'off' && 'off' || vars.CI_SELECTED_GATE == 'on' && 'on' || 'observe' }}";
const tmp = mkdtempSync(join(tmpdir(), "ci-selected-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** main 0062df47e's `Unit tests` script, verbatim (the one `\` + newline is a template-literal line continuation): what off must still behave like. */
const MAIN_UNIT = `if [ "\${{ needs.plan.outputs.scope }}" = related ] || [ "\${{ needs.plan.outputs.scope }}" = light ]; then
  bun scripts/ci-related-plan.ts files "$RUNNER_TEMP/ci-related-plan/plan.json" "\${{ needs.plan.outputs.digest }}" \${{ matrix.shard }} > "$RUNNER_TEMP/files.txt"
  mapfile -t files < "$RUNNER_TEMP/files.txt"
  printf 'shard=%s/%s\\nhead=%s\\nplan=%s\\n' \${{ matrix.shard }} "\${{ needs.plan.outputs.scope == 'light' && '1' || '8' }}" "$(git rev-parse HEAD)" \
"\${{ needs.plan.outputs.digest }}" > "$RUNNER_TEMP/shard.log"
  if [ \${#files[@]} -eq 0 ]; then echo zero=1 >> "$RUNNER_TEMP/shard.log"; exit 0; fi
  bun test "\${files[@]}" 2>&1 | tee -a "$RUNNER_TEMP/shard.log"
  exit 0
fi
bun run --silent test:shard \${{ matrix.shard }}/8 > "$RUNNER_TEMP/files.txt"
mapfile -t files < "$RUNNER_TEMP/files.txt"
discovered=$(bun test --shard=99999/99999 2>&1 | sed -n 's|.*: running 0/\\([0-9]*\\) test files.*|\\1|p')
printf 'shard=%s/8\\nhead=%s\\ndiscovered=%s\\n' \${{ matrix.shard }} "$(git rev-parse HEAD)" "$discovered" > "$RUNNER_TEMP/shard.log"
bun test "\${files[@]}" 2>&1 | tee -a "$RUNNER_TEMP/shard.log"
`;

/** A bun that runs nothing: `test` prints one red file and exits TEST_RC, the verdict script logs its call and exits VERDICT_RC. */
const BIN = join(tmp, "bin");
mkdirSync(BIN);
writeFileSync(join(BIN, "bun"), `#!/bin/bash
case "$1" in
  run) echo ./tests/a.test.ts ;;
  test) [[ "$2" == --shard=* ]] && { echo "x: running 0/1 test files"; exit 0; }
        printf '::group::tests/a.test.ts:\\n(fail) a\\n::endgroup::\\n 1 fail\\n'; exit "$TEST_RC" ;;
  scripts/ci-related-plan.ts) echo ./tests/a.test.ts ;;
  scripts/ci-selected-verdict.ts) echo "$CI_SELECTED_GATE $CORE_TYPECHECK $*" >> "$CALLS"; exit "$VERDICT_RC" ;;
esac
`);
chmodSync(join(BIN, "bun"), 0o755);

/** The runner's bash 5 has mapfile; a developer's macOS bash 3.2 does not, so the harness (never the step) brings an equivalent. */
const MAPFILE = `type mapfile >/dev/null 2>&1 || mapfile() { local l; local -a a=(); while IFS= read -r l; do a+=("$l"); done; eval "$2=(\\"\\\${a[@]}\\")"; }\n`;

function runStep(script: string, o: { mode: string; scope: string; testRc: number; verdictRc?: number }) {
  const dir = mkdtempSync(join(tmp, "run-")), calls = join(dir, "calls");
  const exprs: Record<string, string> = { [MODE.slice(4, -3)]: o.mode, "steps.typecheck.outcome": "success", "matrix.shard": "2",
    "needs.plan.outputs.scope": o.scope, "needs.plan.outputs.digest": "sha256:plan", "needs.plan.outputs.scope == 'light' && '1' || '8'": "8" };
  const text = script.replace(/\$\{\{ (.*?) \}\}/g, (_, e: string) => { if (!(e in exprs)) throw new Error(`unknown expression ${e}`); return exprs[e]!; });
  writeFileSync(join(dir, "step.sh"), MAPFILE + text);
  const r = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], { cwd: ROOT, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, RUNNER_TEMP: dir, CALLS: calls, TEST_RC: String(o.testRc), VERDICT_RC: String(o.verdictRc ?? 1) } });
  return { code: r.exitCode, calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [], log: readFileSync(join(dir, "shard.log"), "utf8")
    .replace(/head=\w+/, "head=H") };
}
const unit = steps("tests").find((s) => s.name === "Unit tests")!;

describe("[验收线 3] the shard step: off is main's step, observe stays red with a receipt, on releases only on an allow", () => {
  test("red first: main's step has no verdict; the new one reads the trusted variable once, normalised to three literals", () => {
    expect(MAIN_UNIT).not.toContain("ci-selected-verdict");
    expect(unit.run!.split("\n")[0]).toBe(`gate="${MODE}"`);
    expect(unit.run!.match(/\|\| selected \$\?/g)).toHaveLength(2);
    expect(unit["continue-on-error"]).toBeUndefined();
    expect(unit.env).toEqual({ CI_IO_TRACE: "${{ github.event_name == 'push' && format('{0}/io-trace.jsonl', runner.temp) || '' }}" });
    // the only reads of the variable: the step literal, the plan download and the gate's env, each normalised or compared to off
    const text = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(text.match(/vars\.CI_SELECTED_GATE/g)!.length).toBe(5);
  });

  test("off: the same exit code and the same shard.log as main's step for a red, a crashed and a green run; the verdict never runs", () => {
    for (const scope of ["full", "related"]) {
      for (const testRc of [1, 137, 0]) {
        const now = runStep(unit.run!, { mode: "off", scope, testRc, verdictRc: 0 }), before = runStep(MAIN_UNIT, { mode: "off", scope, testRc });
        expect(`${scope}/${testRc}:${now.code}:${now.log}`).toBe(`${scope}/${testRc}:${before.code}:${before.log}`);
        expect(now.calls).toEqual([]);
      }
    }
  });

  test("observe: the verdict runs on a red shard and the shard stays red with bun's own exit code", () => {
    const r = runStep(unit.run!, { mode: "observe", scope: "full", testRc: 1 });
    expect([r.code, r.calls]).toEqual([1, [expect.stringContaining("observe success scripts/ci-selected-verdict.ts shard 2 1 ") as unknown as string]]);
    expect(runStep(unit.run!, { mode: "observe", scope: "full", testRc: 0 })).toMatchObject({ code: 0, calls: [] });
  });

  test("on: the shard ends green only when the verdict exits 0; a refusal keeps bun's exit code", () => {
    expect(runStep(unit.run!, { mode: "on", scope: "full", testRc: 1, verdictRc: 0 }).code).toBe(0);
    expect(runStep(unit.run!, { mode: "on", scope: "related", testRc: 1, verdictRc: 0 }).code).toBe(0);
    expect(runStep(unit.run!, { mode: "on", scope: "full", testRc: 1, verdictRc: 1 }).code).toBe(1);
    expect(runStep(unit.run!, { mode: "on", scope: "related", testRc: 2, verdictRc: 1 }).code).toBe(2);
  });

  test("the receipt is uploaded per shard without tolerance; the job facts carry it; the plan is fetched only when not off", () => {
    const up = steps("tests").find((s) => s.name === "Upload selected receipt")!;
    expect(up).toMatchObject({ if: "always()", with: { name: "ci-selected-shard-${{ matrix.shard }}", "if-no-files-found": "ignore" } });
    expect(up["continue-on-error"]).toBeUndefined();
    expect(steps("tests").find((s) => s.name === "Record job facts")!.env!.SELECTED_RECEIPT).toBe("${{ runner.temp }}/ci-selected/receipt.json");
    expect(steps("tests").find((s) => s.with?.path === "${{ runner.temp }}/ci-selected-plan")).toMatchObject({ if: "vars.CI_SELECTED_GATE != 'off'",
      "continue-on-error": true, with: { name: "ci-related-plan" } });
  });
});

/** A throwaway repo whose HEAD is a two-parent test merge: the PR changed src/lib/mine.ts. */
function mergeRepo(): string {
  const dir = mkdtempSync(join(tmp, "repo-")), git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1");
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "pr"); mkdirSync(join(dir, "src/lib"), { recursive: true }); writeFileSync(join(dir, "src/lib/mine.ts"), "x");
  git("add", "."); git("commit", "-qm", "pr");
  git("checkout", "-q", "main"); writeFileSync(join(dir, "b.txt"), "2"); git("add", "."); git("commit", "-qm", "main");
  git("merge", "-q", "--no-ff", "-m", "merge", "pr");
  return dir;
}
const LOG = ["shard=1/8", "head=x", "discovered=2", "bun test v1.3.14 (0d9b296a)", "::group::tests/a.test.ts:", "(pass) a [1.00ms]", "::endgroup::",
  "::group::tests/flaky.test.ts:", "(fail) under load [5001.00ms]", "  ^ this test timed out after 5000ms.", "::endgroup::", " 1 pass", " 1 fail",
  "Ran 2 tests across 2 files. [5.10s]"].join("\n");

function shardRun(repo: string, mode: string, plan: unknown, digest?: string) {
  const out = mkdtempSync(join(tmp, "out-")), planText = JSON.stringify(plan, null, 1);
  writeFileSync(join(out, "shard.log"), LOG); writeFileSync(join(out, "files.txt"), "./tests/a.test.ts\n./tests/flaky.test.ts\n");
  writeFileSync(join(out, "plan.json"), planText);
  const d = digest ?? `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
  const r = Bun.spawnSync(["bun", join(ROOT, "scripts", "ci-selected-verdict.ts"), "shard", "1", "1", join(out, "shard.log"), join(out, "files.txt"),
    join(out, "plan.json"), d, join(out, "selected")], { cwd: repo, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, CI_SELECTED_GATE: mode, CORE_TYPECHECK: "success", GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1" } });
  const receiptPath = join(out, "selected", "receipt.json");
  return { code: r.exitCode, stdout: r.stdout.toString(), out, receipt: existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null };
}
function gateRun(repo: string, mode: string, shardOut: string, withReceipt: boolean) {
  const g = mkdtempSync(join(tmp, "gate-"));
  mkdirSync(join(g, "shards", "test-shard-1"), { recursive: true }); writeFileSync(join(g, "shards", "test-shard-1", "shard.log"), LOG);
  if (withReceipt) {
    mkdirSync(join(g, "selected", "ci-selected-shard-1"), { recursive: true });
    writeFileSync(join(g, "selected", "ci-selected-shard-1", "receipt.json"), readFileSync(join(shardOut, "selected", "receipt.json")));
  }
  const r = Bun.spawnSync(["bun", join(ROOT, "scripts", "ci-selected-verdict.ts"), "gate", join(g, "shards"), join(g, "selected"), join(g, "out")],
    { cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI_SELECTED_GATE: mode, GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1" } });
  const v = join(g, "out", "verdict.json");
  return { code: r.exitCode, stdout: r.stdout.toString(), verdict: existsSync(v) ? JSON.parse(readFileSync(v, "utf8")) : null };
}

describe("[验收线 3] the script for real: exit codes, receipts, the `ci-selected:` line and the gate", () => {
  const repo = mergeRepo(), plan = { scope: "full", tests: [], responsibility: responsibility(["tests/a.test.ts"]) };

  test("on + a failure outside the responsibility and the changes: exit 0, an applied receipt, one ci-selected line", () => {
    const r = shardRun(repo, "on", plan);
    expect(r.code).toBe(0);
    expect(r.receipt).toMatchObject({ mode: "on", allow: true, applied: true, shard: 1, runId: 9, attempt: 1,
      outOfScope: [{ file: "tests/flaky.test.ts", name: "under load" }], responsibilityDigest: plan.responsibility.digest });
    expect(r.stdout).toContain(`ci-selected: shard=1 mode=on allow=1 applied=1 responsibility=${plan.responsibility.digest} out_of_scope=1`);
    const g = gateRun(repo, "on", r.out, true);
    expect([g.code, g.verdict?.outOfScope, g.verdict?.mode]).toEqual([0, [{ file: "tests/flaky.test.ts", name: "under load" }], "on"]);
    expect(g.stdout).toContain("ci-selected: allow=1 out_of_scope=1");
  });

  test("on: a released shard whose receipt is missing turns the gate red", () => {
    const g = gateRun(repo, "on", shardRun(repo, "on", plan).out, false);
    expect(g.code).toBe(1);
    expect(g.stdout).toContain("第 1 片走了放行却缺回执 ci-selected-shard-1");
  });

  test("observe (and unset): the receipt and the line are there, the exit code stays red", () => {
    for (const mode of ["observe", ""]) {
      const r = shardRun(repo, mode, plan);
      expect([r.code, r.receipt?.allow, r.receipt?.applied, r.receipt?.mode]).toEqual([1, true, false, "observe"]);
      expect(r.stdout).toContain("ci-selected: shard=1 mode=observe allow=1 applied=0");
    }
  });

  test("on but refused: responsibility \"all\", the failing file in it, or a plan that is not the frozen one", () => {
    expect(shardRun(repo, "on", { ...plan, responsibility: responsibility("all", ["x"]) })).toMatchObject({ code: 1, receipt: { allow: false, applied: false } });
    expect(shardRun(repo, "on", { ...plan, responsibility: responsibility(["tests/flaky.test.ts"]) }).code).toBe(1);
    expect(shardRun(repo, "on", plan, "sha256:other").receipt).toMatchObject({ allow: false, reason: "没有可核对的责任选集" });
  });

  test("the gate with no released shard (off's only case): exit 0, no artifact; off prints nothing", () => {
    const g = mkdtempSync(join(tmp, "quiet-"));
    mkdirSync(join(g, "test-shard-1")); writeFileSync(join(g, "test-shard-1", "shard.log"), LOG.replace(" 1 fail", " 0 fail"));
    for (const mode of ["off", "observe"]) {
      const r = Bun.spawnSync(["bun", join(ROOT, "scripts", "ci-selected-verdict.ts"), "gate", g, join(g, "none"), join(g, "out")], { cwd: repo,
        stdout: "pipe", env: { ...process.env, CI_SELECTED_GATE: mode, GITHUB_RUN_ID: "9", GITHUB_RUN_ATTEMPT: "1" } });
      expect([mode, r.exitCode, existsSync(join(g, "out"))]).toEqual([mode, 0, false]);
      if (mode === "off") expect(r.stdout.toString()).toBe("");
    }
  });
});

describe("[验收线 3] gateVerdict: what counts as released and what a receipt must match", () => {
  const head = "a".repeat(40), run = { runId: 9, attempt: 2, head };
  const receipt = (over = {}) => ({ ...shardReceipt({ mode: "on", shard: 3, exitCode: 1, log: LOG, assigned: ["./tests/a.test.ts", "./tests/flaky.test.ts"],
    planText: JSON.stringify({ responsibility: responsibility([]) }), planDigest: `sha256:${createHash("sha256").update(JSON.stringify({ responsibility:
    responsibility([]) })).digest("hex")}`, changed: [], typecheck: "skipped", run }), ...over });
  const input = (receipts: Map<number, unknown>, mode: "on" | "off" | "observe" = "on") => ({ mode, run, logs: new Map([[3, LOG], [4, "ok\n 0 fail"]]), receipts });

  test("a matching applied receipt passes and is summarised; another attempt, head or log does not", () => {
    expect(receipt().applied).toBe(true);
    expect(gateVerdict(input(new Map([[3, receipt()]])))).toMatchObject({ problems: [], verdict: { shards: { "3": expect.any(String) } } });
    expect(gateVerdict(input(new Map([[3, receipt({ attempt: 1 })]]))).problems.join()).toContain("不是本次 run 9 attempt 2");
    expect(gateVerdict(input(new Map([[3, receipt({ head: "b".repeat(40) })]]))).problems.join()).toContain("head");
    expect(gateVerdict(input(new Map([[3, receipt({ logDigest: `sha256:${"0".repeat(64)}` })]]))).problems.join()).toContain("日志摘要");
  });

  test("a released shard outside on (a switch mid-run) is red too; nothing released is no verdict and no problem", () => {
    expect(gateVerdict(input(new Map([[3, receipt()]]), "off")).problems.join()).toContain("CI_SELECTED_GATE=off");
    expect(gateVerdict({ mode: "off", run, logs: new Map([[4, "ok\n 0 fail"]]), receipts: new Map() })).toEqual({ verdict: null, problems: [] });
  });

  test("off: a green shard whose passing test printed \" 1 fail\" is not a release — no receipt needed, the gate stays green", () => {
    const green = LOG.replace("(fail) under load [5001.00ms]\n  ^ this test timed out after 5000ms.", "  1 fail\n 1 fail\n(pass) prints [1.00ms]")
      .replace(" 1 pass\n 1 fail", " 2 pass\n 0 fail");
    expect(green).toContain("\n 1 fail\n(pass)");
    for (const mode of ["off", "observe", "on"] as const) expect(gateVerdict({ mode, run, logs: new Map([[1, green]]), receipts: new Map() }))
      .toEqual({ verdict: null, problems: [] });
  });
});

describe("[验收线 5] the check job keeps its name, its first step and the wording the scheduler reads", () => {
  test("job and step names, the verdict line, always(); the new gate step comes after every existing check and before the io map", () => {
    const check = ci.jobs.check! as { name: string; if?: string; steps: Step[] };
    expect([check.name, check.if, check.steps[0]!.name]).toEqual([GATE.job, "always()", GATE.step]);
    expect(check.steps[0]!.run).toBe('[ "${{ needs.tests.result }}" = success ] || { echo "::error::分片没有全部成功：${{ needs.tests.result }}"; exit 1; }\n');
    expect(GATE_VERDICT.test("##[error]分片没有全部成功：failure")).toBe(true);
    const names = check.steps.map((s) => s.name ?? s.with?.pattern ?? s.with?.name);
    const at = names.indexOf("Released shards carry receipts");
    expect(names.slice(at - 1, at + 2)).toEqual(["ci-selected-shard-*", "Released shards carry receipts", "ci-selected-verdict"]);
    expect(at).toBeGreaterThan(names.indexOf("Reused checks verify against their original runs"));
    expect(at).toBeLessThan(names.indexOf("ci-io-trace-*"));
    expect(check.steps[at]!.env).toEqual({ CI_SELECTED_GATE: MODE });
  });
});
