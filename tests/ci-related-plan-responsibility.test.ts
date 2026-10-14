/**
 * merge-arch-CISEL1 [验收线 1]: plan.json freezes `responsibility` (what this PR is answerable for) beside the execution fields.
 * A small PR gets a file list, any full fallback / push / train / PR-less dispatch gets "all", and scope / tests / shards and the
 * rest of the envelope are byte-for-byte what main 0062df47e built for the same input (EXEC_GOLDEN below was computed there).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { buildPlan, dispatchPrRefOf, type PlanFacts, responsibilityOf } from "../scripts/ci-related-plan.ts";
import { buildGraph, oxcScanner, type OxcParseSync } from "../src/lib/ci-impact-graph.js";
import type { ImpactInputs } from "../src/lib/ci-impact-inputs.js";
import { type ChangedFile, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { selectLightTests } from "../src/lib/ci-light-select.js";
import { judgeSelected, readResponsibility, responsibilityDigest } from "../src/lib/ci-selected-verdict.js";

const scan = oxcScanner(parseSync as unknown as OxcParseSync);
type Files = Record<string, string>;
const side = (files: Files) => ({ paths: Object.keys(files).sort(), graph: buildGraph({ paths: Object.keys(files), read: (p) => files[p]! }, scan, []) });
const INPUTS: ImpactInputs = {
  fullTriggers: [{ glob: ".github/**", why: "workflow" }, { glob: "**/bun.lock", why: "锁文件" }], alwaysRun: [], inputMap: [], implicit: [],
  knownUnresolved: [], docs: ["**/*.md"],
};
const REPO: Files = {
  "src/lib/a.ts": "export const a = 1;", "src/lib/b.ts": "export const b = 2;",
  "tests/a.test.ts": `import { a } from "../src/lib/a.js";`, "tests/b.test.ts": `import { b } from "../src/lib/b.js";`,
  "tests/slow.test.ts": `import { a } from "../src/lib/a.js";`, ".github/workflows/ci.yml": "x", "README.md": "x",
};
const ALL = Object.keys(REPO).filter((p) => p.endsWith(".test.ts")).sort();
const M = (path: string): ChangedFile => ({ status: "M", path });
const selector = (changes: ChangedFile[]) => (mode: unknown) =>
  selectImpactedTests({ mode, changes, headPaths: Object.keys(REPO), load: () => ({ base: side(REPO), head: side(REPO) }), inputs: INPUTS });
const light = () => selectLightTests([M("src/lib/a.ts")], side(REPO), side(REPO), ["tests/slow.test.ts"]);
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ event: "pull_request", sha: "a".repeat(40), prHead: "b".repeat(40), mode: "on",
  headRef: "task/x", allTests: ALL, slow: ["tests/slow.test.ts"], select: selector([M("src/lib/a.ts")]), seconds: {}, ...over });

/** The same inputs as the golden run on main: each case's plan minus `responsibility`, hashed. */
const CASES: Record<string, Partial<PlanFacts>> = {
  related: {}, observe: { mode: "" }, off: { mode: "off" }, unknown: { mode: "bogus" },
  fallback: { select: selector([M(".github/workflows/ci.yml")]) }, rerun: { runAttempt: 2, queueMode: "" }, label: { labels: ["ci-full"], queueMode: "" },
  light: { queueMode: "on", lightSelect: light, runAttempt: 1, labels: [] }, push: { event: "push" }, train: { headRef: "train/7" },
  dispatch: { event: "workflow_dispatch" }, slowOnly: { select: selector([M("tests/slow.test.ts")]) },
};
const EXEC_GOLDEN: Record<string, string> = {
  related: "d1755fd223b07462e7632a3756ca6b2ceea23bed9ae960f17c61c0621e4ce9d8", observe: "b696728812fc48b89e6d7e939c232048733a11dd38914a26b1ba6ef71d3b792d",
  off: "123aab224671ca8d768d1e36653a4242d97720bddddb5efb007f92f9da40fece", unknown: "78435c1c25a5b0e8b7eb95204c3fe8d38ea65d65e5b4802d165452b02ec47eb4",
  fallback: "5edea66a1720df397cbedba4a1edc9ad3b8f6761b78317f533cc6f9b9485eeda", rerun: "f9fe283fc9d9f1132a50a145df6510ca444efbf36cb87f56139ed49fbeb9799c",
  label: "f9fe283fc9d9f1132a50a145df6510ca444efbf36cb87f56139ed49fbeb9799c", light: "18fb33eaf7d68a0b376c5cf33f4fa097c7903221543cdca05b4f8e6ee1f93ae2",
  push: "317bcdd29ada6ee3c1f81c8416f4900140fbe58f996da694eb7aae7eadc18365", train: "750b73dba7e8450406afe0fc89a686d0913e60a274c44c2a73352536769302cd",
  dispatch: "2d01a1a4a28e288c7fa0d3236473bd73b092ec3ec99e0ade3dfb1807228e7b1e", slowOnly: "291f7ae3fdce051e5bfbe246f2c19b1b4e67854a89ff98ba65b5facc0ceec0c2",
};
const execHash = (over: Partial<PlanFacts>) => {
  const { responsibility: _, ...rest } = buildPlan(facts(over));
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
};

describe("[验收线 1] responsibility is frozen beside an unchanged execution plan", () => {
  test("red first: a small PR's plan carries a non-\"all\" responsibility with its digest (main had no such field)", () => {
    const p = buildPlan(facts());
    expect(p.responsibility).toEqual({ tests: ["tests/a.test.ts", "tests/slow.test.ts"], digest: responsibilityDigest(["tests/a.test.ts", "tests/slow.test.ts"]),
      fallbackReasons: [] });
    expect(readResponsibility(p.responsibility)).toEqual(p.responsibility!);
  });

  test("the responsibility does not follow the execution mode: observe, off, an unknown value, a whole re-run, ci-full and light all compute it", () => {
    const want = buildPlan(facts()).responsibility;
    for (const name of ["observe", "off", "unknown", "rerun", "label", "light"]) expect(`${name}:${JSON.stringify(buildPlan(facts(CASES[name])).responsibility)}`)
      .toBe(`${name}:${JSON.stringify(want)}`);
  });

  test("every full fallback is \"all\" with its reason; push, a train PR, other events and a PR-less dispatch are \"all\" without selecting", () => {
    expect(buildPlan(facts(CASES.fallback)).responsibility).toMatchObject({ tests: "all", fallbackReasons: ["全量触发：.github/workflows/ci.yml（workflow）"] });
    const never = () => { throw new Error("must not select"); };
    expect(responsibilityOf(facts({ event: "push", select: never }))).toMatchObject({ tests: "all", fallbackReasons: ["push（main）始终全量"] });
    expect(responsibilityOf(facts({ headRef: "train/7", select: never }))).toMatchObject({ tests: "all", fallbackReasons: ["列车 PR 始终全量"] });
    expect(responsibilityOf(facts({ event: "workflow_dispatch", select: never }))).toMatchObject({ tests: "all" });
    expect(responsibilityOf(facts({ event: "merge_group", select: never }))).toMatchObject({ tests: "all" });
    expect(responsibilityOf(facts({ select: never }))).toMatchObject({ tests: "all", fallbackReasons: ["选择器失败：must not select"] });
  });

  test("the slow-list fallback freezes \"all\" too: a PR that only touches a slow test runs full, and owns everything that full run fails", () => {
    const p = buildPlan(facts(CASES.slowOnly));
    expect([p.scope, p.reasons]).toEqual(["full", ["排除慢清单后选集为空"]]);
    expect(p.responsibility).toEqual({ tests: "all", digest: responsibilityDigest("all"), fallbackReasons: ["排除慢清单后选集为空"] });
    expect(judgeSelected({ responsibility: p.responsibility!, failures: [{ file: "tests/b.test.ts", name: "flaky", timedOut: false }],
      changed: ["tests/slow.test.ts"], complete: true, steps: {} })).toMatchObject({ allow: false });
  });

  test("a dispatch that belongs to a PR is computed on its checkout like the PR run", () => {
    expect(responsibilityOf(facts({ event: "workflow_dispatch", dispatchPr: 7, dispatchPrRef: { ref: "task/x" } }))).toEqual(buildPlan(facts()).responsibility!);
  });

  test("a dispatch for a train PR, or whose PR branch could not be read and bound, is \"all\" and exempts nothing", () => {
    const never = () => { throw new Error("must not select"); };
    const d = (over: Partial<PlanFacts>) => responsibilityOf(facts({ event: "workflow_dispatch", dispatchPr: 7, headRef: "", select: never, ...over }));
    expect(d({ dispatchPrRef: { ref: "train/pr-1" } })).toMatchObject({ tests: "all", fallbackReasons: ["列车 PR 始终全量"] });
    expect(d({})).toMatchObject({ tests: "all", fallbackReasons: ["补验对应 PR 的分支未知"] });
    expect(d({ dispatchPrRef: { reason: "PR #7 的 head 不是请求绑定的" } })).toMatchObject({ tests: "all",
      fallbackReasons: ["补验对应 PR 的分支未知：PR #7 的 head 不是请求绑定的"] });
    const p = buildPlan(facts({ event: "workflow_dispatch", dispatchPr: 7, headRef: "", dispatchPrRef: { ref: "train/pr-1" } }));
    expect(judgeSelected({ responsibility: p.responsibility!, failures: [{ file: "tests/b.test.ts", name: "flaky", timedOut: false }],
      changed: ["src/lib/a.ts"], complete: true, steps: {} })).toMatchObject({ allow: false });
  });

  test("CI_IO_MAP=on: the read map's selection is the responsibility; observe keeps the registry rules", () => {
    const viaMap = (mode: unknown) => ({ sel: selectImpactedTests({ mode, changes: [M("src/lib/b.ts")], headPaths: Object.keys(REPO),
      load: () => ({ base: side(REPO), head: side(REPO) }), inputs: INPUTS }), sha: "c".repeat(40), generatedAt: "2026-10-14T00:00:00.000Z", reasons: [] });
    expect(buildPlan(facts({ ioMode: "on", ioSelect: viaMap })).responsibility!.tests).toEqual(["tests/b.test.ts"]);
    expect(buildPlan(facts({ ioMode: "observe", ioSelect: viaMap })).responsibility!.tests).toEqual(["tests/a.test.ts", "tests/slow.test.ts"]);
  });

  test("scope, tests, shards and the rest of the plan are byte-identical to main's for the same input", () => {
    for (const [name, over] of Object.entries(CASES)) expect(`${name}:${execHash(over)}`).toBe(`${name}:${EXEC_GOLDEN[name]}`);
  });

  test("a digest that does not match its list, or a malformed field, reads as no responsibility", () => {
    const r = buildPlan(facts()).responsibility!;
    expect(readResponsibility({ ...r, tests: ["tests/b.test.ts"] })).toBeNull();
    expect(readResponsibility({ ...r, tests: "everything" })).toBeNull();
    expect(readResponsibility(undefined)).toBeNull();
    expect(readResponsibility({ tests: "all", digest: responsibilityDigest("all"), fallbackReasons: [] })).toMatchObject({ tests: "all" });
  });
});

describe("[验收线 1] a dispatch reads its PR's branch from the remote refs, bound to the request's head", () => {
  const H = "b".repeat(40), O = "c".repeat(40), ls = (...l: string[]) => () => l.join("\n");
  test("the branch pointing at the PR head, a train branch winning; a reason when the PR moved, no branch matches or the refs are unreadable", () => {
    expect(dispatchPrRefOf(ls(`${H}\trefs/pull/7/head`, `${O}\trefs/heads/main`, `${H}\trefs/heads/task/x`), 7, H)).toEqual({ ref: "task/x" });
    expect(dispatchPrRefOf(ls(`${H}\trefs/pull/7/head`, `${H}\trefs/heads/task/x`, `${H.toUpperCase()}\trefs/heads/train/pr-1`), 7, H))
      .toEqual({ ref: "train/pr-1" });
    expect(dispatchPrRefOf(ls(`${O}\trefs/pull/7/head`, `${H}\trefs/heads/task/x`), 7, H)).toMatchObject({ reason: expect.stringContaining("不是请求绑定的") });
    expect(dispatchPrRefOf(ls(`${H}\trefs/pull/8/head`, `${H}\trefs/heads/task/x`), 7, H)).toMatchObject({ reason: expect.stringContaining("不是请求绑定的") });
    expect(dispatchPrRefOf(ls(`${H}\trefs/pull/7/head`, `${O}\trefs/heads/task/x`), 7, H)).toEqual({ reason: "没有分支指向 PR #7 的 head" });
    expect(dispatchPrRefOf(() => { throw new Error("git ls-remote：denied"); }, 7, H)).toMatchObject({ reason: expect.stringContaining("denied") });
  });
});
