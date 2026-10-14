/**
 * merge-arch-CIDESK1: scripts/ci-desktop-scope.ts (does an ordinary PR touch what the desktop job reads) and the ci.yml shape that
 * lets the desktop check stay one check of one name, a success on both paths: macOS when it has to run, a one-line Ubuntu job when not.
 * The proof side (proofNeeds) is in tests/ci-proof-artifact.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangedFile, parseNameStatus } from "../src/lib/ci-impact-select.js";
import { type CiDesktopScopeMode, ciDesktopScopeMode, decideDesktopScope, DESKTOP_INPUTS, type DesktopScopeFacts } from "../scripts/ci-desktop-scope.ts";

const M = (path: string): ChangedFile => ({ status: "M", path });
const decide = (changes: readonly ChangedFile[] | null, over: Partial<DesktopScopeFacts> = {}) =>
  decideDesktopScope({ event: "pull_request", headRef: "lend/some-card", mode: "on", changes, bad: [], ...over });
const MODES: CiDesktopScopeMode[] = ["off", "observe", "on"];

/** The changed files of three PRs merged on 10-13 / 10-14 and of the one PR in 14 days that touched desktop/ (gh pr view --json files). */
const PR_1420_SLA1 = [
  "src/lib/ledger-audit-stall.ts", "src/lib/manual-case-sla-compat.ts", "src/lib/manual-case-sla-tick.ts", "src/lib/manual-case-sla-write.ts",
  "src/lib/recovery-keys.ts", "src/lib/recovery-manual.ts", "src/lib/scheduler-recovery-ports.ts", "src/lib/scheduler-v2-ledger-cmds-args.ts",
  "src/lib/scheduler-v2-skip-effects.ts", "src/lib/scheduler-v2-skip-paths.ts", "src/lib/shared-ledger-gate-cli-services.ts",
  "src/manager/ledger-manual-case-cmds.ts", "tests/manual-case-sla-coexist.test.ts", "tests/manual-case-sla.test.ts",
  "tests/review-converge-notice-readonly.test.ts",
];
const PR_1424_EFFAUTO1 = [
  "src/lib/effect-count-refresh-git.ts", "src/lib/effect-count-refresh.ts", "src/lib/recovery-keys.ts", "src/lib/scheduler-merge-ci-rerun.ts",
  "src/lib/scheduler-service.ts", "src/lib/scheduler-v2-skip-effects.ts", "tests/effect-count-refresh-git.test.ts", "tests/effect-count-refresh.test.ts",
];
const PR_1428_MQ1P2 = [
  "docs/design/manual-merge-queue.md", "src/lib/manual-merge-queue-facts.ts", "src/lib/manual-merge-queue.ts",
  "tests/manual-merge-queue-replay.test.ts", "tests/scheduler-merge-reclaim-world.ts",
];
const PR_237_T18B = [
  ".github/workflows/ci.yml", "desktop/README.md", "desktop/src-tauri/Cargo.lock", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/src/cli.rs",
  "desktop/src-tauri/src/commands.rs", "desktop/src-tauri/src/env.rs", "desktop/src-tauri/src/env_tests.rs", "desktop/src-tauri/src/main.rs",
  "desktop/ui/types.ts", "src/desktop-cli.ts", "src/lib/desktop-status.ts", "src/lib/doctor.ts", "src/lib/launchd-status.ts",
  "tests/desktop-status.test.ts", "tests/doctor.test.ts",
];

describe("[验收线 1] real PRs as fixed data", () => {
  test("three ordinary PRs of tonight could each skip: run=false under on, still run under observe with 本可跳过 on the line", () => {
    for (const [files, count] of [[PR_1420_SLA1, 15], [PR_1424_EFFAUTO1, 8], [PR_1428_MQ1P2, 5]] as const) {
      expect(files).toHaveLength(count);
      const changes = files.map(M);
      expect(decide(changes, { mode: "on" })).toEqual({
        run: false, wouldSkip: true, reasons: [`未改 desktop 输入（改动 ${count} 个）`],
        line: `desktop 范围：mode=on 结论=跳过 原因=未改 desktop 输入（改动 ${count} 个）`,
      });
      const observe = decide(changes, { mode: "observe" });
      expect(observe).toMatchObject({ run: true, wouldSkip: true });
      expect(observe.line).toBe(`desktop 范围：mode=observe 结论=本可跳过 原因=未改 desktop 输入（改动 ${count} 个），mode=observe 照旧跑`);
      expect(decide(changes, { mode: "off" })).toMatchObject({ run: true, wouldSkip: true });
      expect(decide(changes, { mode: "off" }).line).toContain("mode=off 结论=本可跳过");
    }
  });

  test("#237 (desktop/src-tauri/**, ci.yml, …) must run under every mode, and the reason names the files that hit", () => {
    expect(PR_237_T18B).toHaveLength(16);
    for (const mode of MODES) {
      const d = decide(PR_237_T18B.map(M), { mode });
      expect(d).toMatchObject({ run: true, wouldSkip: false });
      expect(d.reasons).toEqual([
        "改了 desktop 输入 10 个：.github/workflows/ci.yml, desktop/README.md, desktop/src-tauri/Cargo.lock, desktop/src-tauri/Cargo.toml, desktop/src-tauri/src/cli.rs …",
      ]);
      expect(d.line).toBe(`desktop 范围：mode=${mode} 结论=必须跑 原因=${d.reasons[0]}`);
    }
  });
});

describe("[验收线 2] one changed file at a time", () => {
  test("each input of the desktop job, the decider itself and what it imports: must run", () => {
    for (const path of ["package.json", "bun.lock", "bunfig.toml", ".github/workflows/ci.yml", "desktop/src-tauri/Cargo.lock", "scripts/ci-desktop-scope.ts",
      "src/lib/ci-impact-select.ts", "src/lib/ci-impact-inputs.ts", ".github/actions/x/action.yml", "desktop/package.json", "desktop/ui/main.ts"]) {
      expect(decide([M("src/lib/a.ts"), M(path)])).toMatchObject({ run: true, wouldSkip: false, reasons: [`改了 desktop 输入 1 个：${path}`] });
    }
  });

  test("a rename out of desktop/ still counts: the old path is an input", () => {
    const changes: ChangedFile[] = [{ status: "R", from: "desktop/ui/x.ts", path: "misc/x.ts" }];
    expect(decide(changes)).toMatchObject({ run: true, wouldSkip: false, reasons: ["改了 desktop 输入 1 个：desktop/ui/x.ts"] });
    expect(decide([{ status: "R", from: "misc/x.ts", path: "desktop/ui/x.ts" }]).wouldSkip).toBe(false);
    expect(decide([{ status: "D", path: "desktop/ui/gone.ts" }]).wouldSkip).toBe(false);
    // read through the same parser the workflow uses (git diff -z --name-status -M)
    const parsed = parseNameStatus("M\0src/lib/a.ts\0R100\0desktop/ui/x.ts\0misc/x.ts\0");
    expect(decide(parsed.changes, { bad: parsed.bad })).toMatchObject({ run: true, wouldSkip: false });
  });

  test("files that only look related could skip: other package.json files and the CLI contract the app calls at run time", () => {
    for (const path of ["web/package.json", "src/desktop-cli.ts", "src/lib/desktop-status.ts", "web/bun.lock", "docs/desktop/notes.md", "tests/desktop-status.test.ts",
      "scripts/ci-desktop-scope.test.ts", "src/lib/ci-proof.ts", "desktop.md"]) {
      expect(decide([M(path)])).toMatchObject({ run: false, wouldSkip: true });
    }
    expect(decide([])).toMatchObject({ run: false, wouldSkip: true });
  });

  test("changes that cannot be read must run, whatever else the diff says", () => {
    const harmless = [M("src/lib/a.ts")];
    expect(decide(harmless, { bad: ["X\tsrc/lib/a.ts"] })).toMatchObject({ run: true, wouldSkip: false, reasons: ["改动读不出：X\tsrc/lib/a.ts"] });
    expect(decide(null, { bad: ["PR 检出不是合并提交"] })).toMatchObject({ run: true, wouldSkip: false, reasons: ["改动读不出：PR 检出不是合并提交"] });
    expect(decide(null, { bad: ["git diff 失败：fatal: bad revision"] }).line).toContain("结论=必须跑 原因=改动读不出：git diff 失败");
    expect(decide(null)).toMatchObject({ run: true, wouldSkip: false, reasons: ["改动读不出"] });
    const junk = parseNameStatus("Z\0what\0");
    expect(junk.bad).toHaveLength(1);
    expect(decide(junk.changes, { bad: junk.bad }).wouldSkip).toBe(false);
  });

  test("the input list is the approved one", () => {
    expect(DESKTOP_INPUTS).toEqual(["desktop/**", "package.json", "bun.lock", "bunfig.toml", ".github/**", "scripts/ci-desktop-scope.ts", "src/lib/ci-impact-*.ts"]);
  });
});

describe("[验收线 3] mode and event", () => {
  test("unset, empty and observe read observe; off and on as written; anything else is off", () => {
    for (const raw of [undefined, null, "", "observe"]) expect(ciDesktopScopeMode(raw)).toBe("observe");
    expect(ciDesktopScopeMode("off")).toBe("off");
    expect(ciDesktopScopeMode("on")).toBe("on");
    for (const raw of ["ON", "yes", "1", "On", " on", "on\n", "true", "OBSERVE", "skip", 1, true, {}, ["on"]]) expect(ciDesktopScopeMode(raw)).toBe("off");
  });

  test("push, workflow_dispatch, other events and train PRs must run under on, even with nothing of desktop changed", () => {
    const harmless = PR_1428_MQ1P2.map(M);
    const cases: [Partial<DesktopScopeFacts>, string][] = [
      [{ event: "push", headRef: "" }, "push（main）始终跑"], [{ event: "workflow_dispatch", headRef: "" }, "补验始终跑"],
      [{ event: "schedule", headRef: "" }, "事件 schedule 始终跑"], [{ event: "", headRef: "" }, "事件 未知 始终跑"],
      [{ event: "pull_request_target" }, "事件 pull_request_target 始终跑"], [{ headRef: "train/x" }, "列车 PR 始终跑"],
    ];
    for (const [over, reason] of cases) {
      for (const changes of [harmless, null]) {
        expect(decide(changes, { ...over, mode: "on" })).toEqual({ run: true, wouldSkip: false, reasons: [reason], line: `desktop 范围：mode=on 结论=必须跑 原因=${reason}` });
      }
    }
    expect(decide(harmless, { headRef: "lend/train/x" })).toMatchObject({ run: false, wouldSkip: true }); // only a train/ prefix is a train PR
  });

  test("run is false in exactly one case: an ordinary PR that could skip, under on", () => {
    for (const mode of MODES) {
      expect(decide([M("src/lib/a.ts")], { mode }).run).toBe(mode !== "on");
      expect(decide([M("desktop/ui/main.ts")], { mode }).run).toBe(true);
    }
  });
});

const ROOT = join(import.meta.dir, "..");
const ciText = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
interface Step { name?: string; id?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job {
  name: string; needs?: string | string[]; if?: string; "runs-on": string; "timeout-minutes"?: number; outputs?: Record<string, string>; steps: Step[];
}
const ci = Bun.YAML.parse(ciText) as { jobs: Record<string, Job> };
const RUN = "needs.desktop-scope.outputs.run";

describe("[验收线 4] ci.yml: one desktop check, a success on both paths", () => {
  const desktop = ci.jobs.desktop!, scope = ci.jobs["desktop-scope"]!;

  test("the desktop job keeps its name, waits for desktop-scope only, runs unless cancelled and picks ubuntu only on an exact 'false'", () => {
    expect(desktop.name).toBe("desktop typecheck + cargo test");
    expect(desktop.needs).toBe("desktop-scope");
    expect(desktop.if).toBe("${{ !cancelled() }}");
    expect(desktop["runs-on"]).toBe(`\${{ ${RUN} == 'false' && 'ubuntu-latest' || 'macos-latest' }}`);
    expect(desktop["timeout-minutes"]).toBe(30);
    // one job of that name in the file: a second one would be deduplicated by gh into whichever started last
    expect(Object.values(ci.jobs).filter((j) => j.name === desktop.name)).toHaveLength(1);
    expect(ciText.match(/^    if: /gm)!.filter((l) => l.includes("desktop"))).toEqual([]); // no job-level if reads the scope: a skipped check is not a pass
  });

  test("every step that was there runs unless the output is 'false'; the last one records ran=true", () => {
    const real = desktop.steps.filter((s) => s.id !== "skipped");
    expect(real.map((s) => s.name ?? s.uses)).toEqual(["actions/checkout@v4", "oven-sh/setup-bun@v2", "Install dependencies", "Typecheck window UI (tsc)",
      "Build window UI", "dtolnay/rust-toolchain@stable", "Swatinem/rust-cache@v2", "cargo test", "Record desktop ran"]);
    for (const s of real) expect(`${s.name ?? s.uses}: ${s.if}`).toBe(`${s.name ?? s.uses}: ${RUN} != 'false'`);
    expect(real.at(-1)).toMatchObject({ id: "ran", run: 'echo "ran=true" >> "$GITHUB_OUTPUT"' });
    expect(real[0]!.with).toEqual({ ref: "${{ inputs.merge }}" });
    expect(real.find((s) => s.name === "cargo test")!.run).toBe("cargo test --locked");
  });

  test("the skip step runs only on 'false', writes ran=false and says why in the log and the job summary; outputs.ran is wired", () => {
    const skipped = desktop.steps.filter((s) => s.if !== `${RUN} != 'false'`);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ id: "skipped", if: `${RUN} == 'false'` });
    expect(skipped[0]!.run).toContain('echo "ran=false" >> "$GITHUB_OUTPUT"');
    expect(skipped[0]!.run).toContain('echo "无需运行：未改 desktop 输入" | tee -a "$GITHUB_STEP_SUMMARY"');
    expect(desktop.steps.at(-1)).toBe(skipped[0]!);
    expect(desktop.outputs).toEqual({ ran: "${{ steps.ran.outputs.ran || steps.skipped.outputs.ran }}" });
  });

  test("desktop-scope reads the variable once, checks out the tested commit with both parents and only runs the decider", () => {
    expect(scope).toMatchObject({ name: "desktop scope", "runs-on": "ubuntu-latest", "timeout-minutes": 5, outputs: { run: "${{ steps.scope.outputs.run }}" } });
    expect(scope.needs).toBe("plan");
    expect(scope.if).toBeUndefined();
    const [checkout, bun, decideStep, ...rest] = scope.steps;
    expect(rest).toEqual([]);
    expect(checkout).toMatchObject({ uses: "actions/checkout@v4", with: { ref: "${{ inputs.merge }}" } });
    expect(Number(checkout!.with!["fetch-depth"])).toBeGreaterThanOrEqual(2);
    expect(bun).toEqual({ uses: "oven-sh/setup-bun@v2", with: { "bun-version": "1.3.14" } });
    expect(decideStep).toEqual({ name: "Decide desktop scope", id: "scope", run: "bun scripts/ci-desktop-scope.ts",
      env: { CI_PLAN_SCOPE: "${{ needs.plan.outputs.scope }}", CI_DESKTOP_SCOPE: "${{ vars.CI_DESKTOP_SCOPE }}" } });
    expect(ciText.match(/vars\.CI_DESKTOP_SCOPE/g)).toHaveLength(1);
    expect(scope.steps.some((s) => /bun install/.test(s.run ?? ""))).toBe(false);
  });

  test("the whole file pins one Bun version (the proof gate refuses a workflow with several)", () => {
    const versions = [...ciText.matchAll(/^\s*bun-version:\s*["']?([\w.-]+)["']?\s*$/gm)].map((m) => m[1]!);
    expect(versions.length).toBeGreaterThan(1);
    expect([...new Set(versions)]).toEqual(["1.3.14"]);
  });

  test("the proof still waits for desktop itself, not for the scope job", () => {
    expect(ci.jobs.proof!.needs).toEqual(["tests", "check", "web", "web-build", "desktop"]);
  });

  test("the decider needs no install: its import closure is repo files and node builtins only", () => {
    const seen = new Set<string>(), queue = ["scripts/ci-desktop-scope.ts"], external = new Set<string>();
    for (let file = queue.pop(); file; file = queue.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)) {
        const spec = m[1]!;
        if (spec.startsWith(".")) queue.push(join(file, "..", spec).replace(/\.js$/, ".ts"));
        else external.add(spec);
      }
    }
    expect([...external].filter((s) => !s.startsWith("node:"))).toEqual([]);
    // each file of the closure is itself an input: a change to the decision logic has to run the real job
    for (const file of seen) expect(decide([M(file)]).wouldSkip).toBe(false);
  });
});
