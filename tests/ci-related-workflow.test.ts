/**
 * merge-arch-SELECT1: ci.yml wiring of the affected-test selector — the plan (scripts/ci-related-plan.ts), the related gate check
 * (scripts/ci-related-verify.ts) and the workflow shape they rely on. The serial full re-check is tests/scheduler-ci-full-request.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, oxcScanner, type OxcParseSync } from "../src/lib/ci-impact-graph.js";
import type { ImpactInputs } from "../src/lib/ci-impact-inputs.js";
import { type ChangedFile, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { fullRequestId } from "../src/lib/scheduler-ci-full-request.js";
import { buildPlan, type CiPlan, dispatchProblems, planDigest, planLine, type PlanFacts, SHARDS, shardFiles } from "../scripts/ci-related-plan.ts";
import { verifyRelated } from "../scripts/ci-related-verify.ts";

const ROOT = join(import.meta.dir, "..");
const ciText = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
interface Step { name?: string; uses?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { name: string; needs?: string | string[]; if?: string; "timeout-minutes"?: number; outputs?: Record<string, string>; steps: Step[] }
const ci = Bun.YAML.parse(ciText) as { on: Record<string, unknown>; concurrency: { group: string; "cancel-in-progress": string }; "run-name": string; jobs: Record<string, Job> };
const step = (job: string, name: string) => ci.jobs[job]!.steps.find((s) => s.name === name)!;

const scan = oxcScanner(parseSync as unknown as OxcParseSync);
type Files = Record<string, string>;
const side = (files: Files) => ({ paths: Object.keys(files).sort(), graph: buildGraph({ paths: Object.keys(files), read: (p) => files[p]! }, scan, []) });
const INPUTS: ImpactInputs = {
  fullTriggers: [{ glob: ".github/**", why: "workflow" }, { glob: "**/bun.lock", why: "锁文件" }], alwaysRun: [], inputMap: [], implicit: [],
  knownUnresolved: [], docs: ["**/*.md"],
};
const REPO: Files = {
  "src/lib/a.ts": "export const a = 1;", "src/lib/b.ts": "export const b = 2;", "src/lib/c.ts": "export const c = 3;",
  "tests/a.test.ts": `import { a } from "../src/lib/a.js";`, "tests/b.test.ts": `import { b } from "../src/lib/b.js";`,
  "tests/c.test.ts": `import { c } from "../src/lib/c.js";`, "tests/slow.test.ts": `import { a } from "../src/lib/a.js";`,
  ".github/workflows/ci.yml": "x", "README.md": "x",
};
const ALL = Object.keys(REPO).filter((p) => p.endsWith(".test.ts")).sort();
const M = (path: string): ChangedFile => ({ status: "M", path });
const SHA = "a".repeat(40);
const selector = (changes: ChangedFile[], load = () => ({ base: side(REPO), head: side(REPO) })) => (mode: unknown) =>
  selectImpactedTests({ mode, changes, headPaths: Object.keys(REPO), load, inputs: INPUTS });
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ event: "pull_request", sha: SHA, mode: "on", headRef: "task/x", allTests: ALL,
  slow: ["tests/slow.test.ts"], select: selector([M("src/lib/a.ts")]), seconds: {}, ...over });

describe("[验收线 1] observe only records, on narrows an ordinary PR, train / main stay full", () => {
  test("red first: before this card every PR ran the full shard list — now the unit step branches on the frozen plan's scope", () => {
    const unit = step("tests", "Unit tests").run!;
    expect(unit.indexOf('if [ "${{ needs.plan.outputs.scope }}" = related ]')).toBeLessThan(unit.indexOf("bun run --silent test:shard"));
    expect(ci.jobs.tests!.needs).toBe("plan");
  });

  test("on: an ordinary PR runs only its related tests (slow list excluded), LPT-sharded into the existing eight shards", () => {
    const p = buildPlan(facts());
    expect(p).toMatchObject({ scope: "related", tests: ["tests/a.test.ts"], reasons: [], proposed: 1, universe: ALL.length });
    expect(p.shards).toHaveLength(SHARDS);
    expect(p.shards.flat()).toEqual(["tests/a.test.ts"]);
  });

  test("observe (unset, empty or observe) runs full and records the would-be selection in the log line", () => {
    for (const mode of ["", "observe"]) {
      const p = buildPlan(facts({ mode }));
      expect(p).toMatchObject({ scope: "full", tests: [], proposed: 1 });
      expect(planLine(p, planDigest(p))).toContain(`拟选 1 / ${ALL.length}`);
    }
    expect(planLine(buildPlan(facts({ mode: "" })), "d")).toContain("缺省 observe");
  });

  test("push (main), a train PR and the dispatched re-check are always full, whatever the mode, and never parse the repo", () => {
    const never = () => { throw new Error("must not select"); };
    expect(buildPlan(facts({ event: "push", select: never }))).toMatchObject({ scope: "full", reasons: ["push（main）始终全量"] });
    expect(buildPlan(facts({ headRef: "train/42", select: never }))).toMatchObject({ scope: "full", reasons: ["列车 PR 始终全量"] });
    expect(buildPlan(facts({ event: "workflow_dispatch", select: never }))).toMatchObject({ scope: "full", reasons: ["串行补验始终全量"] });
    expect(buildPlan(facts({ event: "merge_group", select: never })).scope).toBe("full");
  });
});

describe("[验收线 2] fallbacks are full; a related gate refuses missing, duplicate or foreign shard artifacts", () => {
  test("a graph that cannot be built, an unknown config value and a global input change all run full with the reason", () => {
    const broken = buildPlan(facts({ select: selector([M("src/lib/a.ts")], () => { throw new Error("oxc 不在"); }) }));
    expect(broken).toMatchObject({ scope: "full" });
    expect(broken.reasons.join()).toContain("图构建失败");
    expect(buildPlan(facts({ mode: "ON" })).reasons.join()).toContain("配置未知");
    const global = buildPlan(facts({ select: selector([M("src/lib/b.ts"), M(".github/workflows/ci.yml")]) }));
    expect(global).toMatchObject({ scope: "full" });
    expect(global.reasons.join()).toContain("全量触发：.github/workflows/ci.yml");
  });

  test("a selection that is only slow-list files is full, never an empty related run", () => {
    expect(buildPlan(facts({ slow: ["tests/slow.test.ts", "tests/a.test.ts"] }))).toMatchObject({ scope: "full", reasons: ["排除慢清单后选集为空"] });
  });

  const plan = buildPlan(facts({ select: selector([M("src/lib/a.ts"), M("src/lib/b.ts"), M("src/lib/c.ts")]) }));
  const digest = planDigest(plan), text = JSON.stringify(plan), BUN = "1.3.14";
  const log = (k: number, files: string[], d = digest) => [`shard=${k}/8`, `head=${SHA}`, `plan=${d}`,
    ...(files.length ? [`bun test v${BUN} (abc)`, ...files.map((f) => `::group::${f}:`)] : ["zero=1"])].join("\n");
  const logs = (over: Record<number, string | null> = {}) => new Map(plan.shards.flatMap((files, i) => {
    const v = over[i + 1] === undefined ? log(i + 1, files) : over[i + 1];
    return v === null ? [] : [[`test-shard-${i + 1}`, v] as const];
  }));
  const want = { n: 8, head: SHA, bun: BUN };
  const busy = plan.shards.findIndex((s) => s.length) + 1, idle = plan.shards.findIndex((s) => !s.length) + 1;

  test("the exact related selection passes; empty shards are explicit zero-execution artifacts", () => {
    expect(plan.scope).toBe("related");
    expect(plan.tests).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
    expect(idle).toBeGreaterThan(0);
    expect(verifyRelated(text, digest, logs(), want)).toEqual([]);
  });

  test("a missing artifact, a file not run, a duplicate run or a file from outside the plan are each red", () => {
    expect(verifyRelated(text, digest, logs({ [busy]: null }), want)).toEqual([`缺少工件 test-shard-${busy}`]);
    const mine = plan.shards[busy - 1]!;
    expect(verifyRelated(text, digest, logs({ [busy]: log(busy, []) }), want).join()).toContain("没跑到分给它的");
    expect(verifyRelated(text, digest, logs({ [busy]: log(busy, [...mine, mine[0]!]) }), want).join()).toContain("重复跑了");
    expect(verifyRelated(text, digest, logs({ [busy]: log(busy, [...mine, "tests/slow.test.ts"]) }), want).join()).toContain("跑了不该它跑的");
    expect(verifyRelated(text, digest, new Map([...logs(), ["test-shard-9", "x"]]), want).join()).toContain("多出来的工件");
  });

  test("an artifact from another plan, a plan file that is not the frozen one, or a zero shard that ran anything is red", () => {
    expect(verifyRelated(text, digest, logs({ [busy]: log(busy, plan.shards[busy - 1]!, "sha256:other") }), want).join()).toContain(`plan=${digest}`);
    expect(verifyRelated(text, "sha256:other", logs(), want)).toEqual(["plan.json 的 digest 不是本次运行冻结的 sha256:other"]);
    expect(verifyRelated(text, digest, logs({ [idle]: `${log(idle, [])}\n::group::tests/a.test.ts:` }), want).join()).toContain("零执行片");
    expect(verifyRelated(text, digest, logs({ [idle]: log(idle, []).replace("zero=1", `bun test v${BUN} (abc)`) }), want).join()).toContain("zero=1");
    const full = buildPlan(facts({ mode: "observe" }));
    expect(verifyRelated(JSON.stringify(full), planDigest(full), logs(), want)).toEqual(["plan scope=full，不该走 related 核对"]);
  });

  test("the shard list comes only from the frozen plan: another digest, a full plan or a bad shard number refuse", () => {
    expect(shardFiles(text, digest, busy)).toEqual(plan.shards[busy - 1]!);
    expect(shardFiles(text, digest, idle)).toEqual([]);
    expect(() => shardFiles(text, "sha256:x", busy)).toThrow(/digest/);
    expect(() => shardFiles(text, digest, 9)).toThrow(/片号/);
    const full = buildPlan(facts({ mode: "off" }));
    expect(() => shardFiles(JSON.stringify(full), planDigest(full), 1)).toThrow(/不是 related/);
  });
});

describe("[验收线 3] the dispatched full re-check runs only on the exact integration content", () => {
  const S = { repo: "o/r", pr: 7, head: "1".repeat(40), base: "2".repeat(40), merge: "3".repeat(40), tree: "4".repeat(40) };
  const env = { GITHUB_REPOSITORY: S.repo, REQ_ID: fullRequestId(S), REQ_PR: "7", REQ_HEAD: S.head, REQ_BASE: S.base, REQ_MERGE: S.merge, REQ_TREE: S.tree };
  const git = (over: Record<string, string> = {}) => (...a: string[]) => {
    const rev = a[1]!, map: Record<string, string> = { HEAD: S.merge, "HEAD^1": S.base, "HEAD^2": S.head, "HEAD^{tree}": S.tree, ...over };
    if (!(rev in map)) throw new Error("bad rev");
    return `${map[rev]}\n`;
  };

  test("checkout, parents, tree and request id all match → no problem", () => {
    expect(dispatchProblems(env, git())).toEqual([]);
  });

  test("a moved base, another head, another tree, an octopus or a forged request id each fail the plan job", () => {
    expect(dispatchProblems(env, git({ "HEAD^1": "9".repeat(40) })).join()).toContain("HEAD^1");
    expect(dispatchProblems(env, git({ "HEAD^2": "9".repeat(40) })).join()).toContain("HEAD^2");
    expect(dispatchProblems(env, git({ "HEAD^{tree}": "9".repeat(40) })).join()).toContain("tree");
    expect(dispatchProblems(env, git({ "HEAD^3": "9".repeat(40) })).join()).toContain("两个父提交");
    expect(dispatchProblems({ ...env, REQ_ID: "cifull-forged" }, git()).join()).toContain("request_id");
    expect(dispatchProblems({ ...env, REQ_BASE: "8".repeat(40) }, git()).length).toBeGreaterThan(0);
  });

  test("every job checks out the requested merge commit; the gate verifies against it, the guard diffs against its base", () => {
    for (const [id, job] of Object.entries(ci.jobs)) {
      const co = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
      expect(`${id}:${co.length > 0 && co.every((s) => s.with?.ref === "${{ inputs.merge }}")}`).toBe(`${id}:true`);
    }
    expect(step("check", "Shards cover every test file exactly once").env).toEqual({ CHECKOUT_SHA: "${{ inputs.merge || github.sha }}" });
    expect(step("tests", "Guard (ratchets)").env!.GUARD_BASE).toBe("${{ github.event.pull_request.base.sha || github.event.before || inputs.base }}");
  });
});

describe("[验收线 4] beside the existing paths: required names, CIF1 wording, no cancelling of trains / re-checks", () => {
  test("required check names and the gate's verdict line are unchanged; the gate still runs always()", () => {
    expect(ci.jobs.check).toMatchObject({ name: "typecheck + test + guard", if: "always()" });
    expect(step("check", "All shards succeeded").run).toContain("::error::分片没有全部成功：${{ needs.tests.result }}");
    expect(ci.jobs.web!.name).toBe("web typecheck + lint");
    expect(ci.jobs.desktop!.name).toBe("desktop typecheck + cargo test");
  });

  test("only a PR's own older run is cancelled; main, trains and each re-check request are separate groups", () => {
    expect(ci.concurrency).toEqual({ group: "${{ github.workflow }}-${{ inputs.request_id || github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" });
  });

  test("web, desktop, typecheck, guard and the entry build never depend on the selection", () => {
    for (const id of ["web", "web-build"]) expect(ci.jobs[id]!.needs).toBeUndefined();
    expect(ci.jobs.desktop!.needs).toBe("desktop-scope");
    expect(ci.jobs["desktop-scope"]!.needs).toBe("plan"); // Its own scope job consumes the frozen plan before deciding desktop inputs.
    for (const name of ["Typecheck (tsc --noEmit)", "Guard (ratchets)", "Build entrypoints", "Install web dependencies"]) {
      expect(step("tests", name).if ?? "matrix.shard == 1").toBe("matrix.shard == 1");
    }
    expect(step("tests", "Install web dependencies").if).toBeUndefined();
  });
});

describe("[验收线 5] off restores full, an in-flight plan settles on its own manifest, every job is bounded", () => {
  test("the mode is read once, in the plan job; later jobs only see the frozen plan and its digest", () => {
    expect(ciText.match(/vars\.CI_RELATED_CHECKS/g)).toHaveLength(1);
    expect(step("plan", "Plan test selection").env!.CI_RELATED_CHECKS).toBe("${{ vars.CI_RELATED_CHECKS }}");
    expect(ci.jobs.plan!.outputs).toEqual({ scope: "${{ steps.plan.outputs.scope }}", digest: "${{ steps.plan.outputs.digest }}" });
    expect(buildPlan(facts({ mode: "off" }))).toMatchObject({ scope: "full", reasons: ["ciRelatedChecks=off"], proposed: null });
  });

  test("a related plan frozen before a switch to off still verifies against its own digest", () => {
    const frozen: CiPlan = buildPlan(facts());
    expect(frozen.mode).toBe("on");
    const d = planDigest(frozen), k = frozen.shards.findIndex((s) => s.length) + 1;
    const logs = new Map(frozen.shards.map((f, i) => [`test-shard-${i + 1}`, [`shard=${i + 1}/8`, `head=${SHA}`, `plan=${d}`,
      ...(f.length ? ["bun test v1 (x)", ...f.map((x) => `::group::${x}:`)] : ["zero=1"])].join("\n")] as const));
    expect(k).toBeGreaterThan(0);
    expect(verifyRelated(JSON.stringify(frozen), d, logs, { n: 8, head: SHA, bun: "1" })).toEqual([]);
  });

  test("merge-arch-SELECT4: a pull_request plan binds the PR's own head under the digest; the rest of the envelope is what it was", () => {
    const head = "b".repeat(40), bound = buildPlan(facts({ prHead: head })), bare = buildPlan(facts());
    expect(bound).toEqual({ ...bare, prHead: head });
    expect(Object.keys(bare)).not.toContain("prHead"); // an unknown head leaves no field: the synthetic merge sha never stands in for it
    expect([bound.prHead === bound.sha, planDigest(bound) === planDigest(bare)]).toEqual([false, false]);
    expect(buildPlan(facts({ prHead: head, mode: "off" }))).toMatchObject({ scope: "full", reasons: ["ciRelatedChecks=off"], prHead: head });
    for (const event of ["push", "workflow_dispatch", "merge_group"]) expect(Object.keys(buildPlan(facts({ event, prHead: head })))).not.toContain("prHead");
    const text = JSON.stringify(bound, null, 1), k = bound.shards.findIndex((f) => f.length) + 1;
    expect(shardFiles(text, planDigest(bound), k)).toEqual(bound.shards[k - 1]!);
    expect(verifyRelated(text, planDigest(bound), new Map(bound.shards.map((f, i) => [`test-shard-${i + 1}`, [`shard=${i + 1}/8`, `head=${SHA}`, `plan=${planDigest(bound)}`,
      ...(f.length ? ["bun test v1 (x)", ...f.map((x) => `::group::${x}:`)] : ["zero=1"])].join("\n")] as const)), { n: 8, head: SHA, bun: "1" })).toEqual([]);
  });

  test("the zero-execution branch exits before bun test, so an empty list never starts the whole suite", () => {
    const unit = step("tests", "Unit tests").run!, related = unit.slice(0, unit.indexOf("\nfi\n"));
    expect(related.indexOf('if [ ${#files[@]} -eq 0 ]; then echo zero=1 >> "$RUNNER_TEMP/shard.log"; exit 0; fi'))
      .toBeLessThan(related.indexOf('bun test "${files[@]}"'));
  });

  test("every job, the new ones included, has a finite timeout below the train car's", () => {
    for (const [id, job] of Object.entries(ci.jobs)) expect(`${id}:${(job["timeout-minutes"] ?? 0) > 0 && job["timeout-minutes"]! < 60}`).toBe(`${id}:true`);
    expect([ci.jobs.plan!["timeout-minutes"], ci.jobs.scope!["timeout-minutes"]]).toEqual([10, 2]);
  });
});
