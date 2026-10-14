import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseSync } from "oxc-parser";
import { buildGraph, oxcScanner, type OxcParseSync } from "../src/lib/ci-impact-graph.js";
import { selectLightTests } from "../src/lib/ci-light-select.js";
import { buildPlan, planDigest, planLine, shardFiles, type PlanFacts } from "../scripts/ci-related-plan.ts";
import { verifyRelated } from "../scripts/ci-related-verify.ts";
import { decideDesktopScope } from "../scripts/ci-desktop-scope.ts";
import { selectImpactedTests } from "../src/lib/ci-impact-select.js";

const scan = oxcScanner(parseSync as unknown as OxcParseSync);
const side = (files: Record<string, string>) => ({ paths: Object.keys(files), graph: buildGraph({ paths: Object.keys(files), read: (p) => files[p]! }, scan, []) });
const files = { "src/a.ts": "export const a=1", "src/b.ts": 'export {a} from "./a"',
  "tests/direct.test.ts": 'import {a} from "../src/a"', "tests/indirect.test.ts": 'import {a} from "../src/b"',
  "tests/changed.test.ts": "export const test=1", "tests/slow.test.ts": 'import {a} from "../src/a"' };
const graph = side(files), changes = [{ status: "M" as const, path: "src/a.ts" }, { status: "M" as const, path: "tests/changed.test.ts" }];
const pick = () => selectLightTests(changes, graph, graph, ["tests/slow.test.ts"]);
const H = "a".repeat(40), P = "b".repeat(40);
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ event: "pull_request", sha: H, prHead: P, mode: "off", headRef: "task/T",
  allTests: graph.paths.filter((p) => p.endsWith("test.ts")), slow: [], seconds: {}, queueMode: "on", runAttempt: 1, labels: [], lightSelect: pick,
  select: (mode) => selectImpactedTests({ mode, changes: [], headPaths: graph.paths, load: () => ({ base: graph, head: graph }) }), ...over });

test("light selects changed tests and one-hop importers, excludes slow and transitive users", () => {
  expect(pick()).toEqual({ tests: ["tests/changed.test.ts", "tests/direct.test.ts"], changed: 1, direct: 1, reasons: [] });
  const renamed = side({ "src/new.ts": "export const a=1", "tests/direct.test.ts": "export const test=1" });
  expect(selectLightTests([{ status: "R", from: "src/a.ts", path: "src/new.ts" }], graph, renamed).tests).toEqual(["tests/direct.test.ts"]);
  expect(selectLightTests([{ status: "D", path: "src/a.ts" }], graph, renamed).tests).toEqual(["tests/direct.test.ts"]);
});

test("over 200 direct users keeps only changed tests with a reason; empty is legal", () => {
  const many = side(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`tests/t${i}.test.ts`, 'import {a} from "../src/a"']).concat([["src/a.ts", "export const a=1"]])));
  const p = selectLightTests([{ status: "M", path: "src/a.ts" }, { status: "M", path: "tests/t0.test.ts" }], many, many);
  expect(p.tests).toEqual(["tests/t0.test.ts"]); expect(p.reasons.join()).toContain("超过 200");
  expect(selectLightTests([{ status: "M", path: "README.md" }], graph, graph).tests).toEqual([]);
});

test("ordinary first attempt can be light; rerun/label/main/dispatch/train always full even when related is on", () => {
  const p = buildPlan(facts());
  expect(p).toMatchObject({ scope: "light", prHead: P, tests: pick().tests, shards: [pick().tests] });
  expect(shardFiles(JSON.stringify(p), planDigest(p), 1)).toEqual(p.tests);
  expect(() => shardFiles(JSON.stringify(p), planDigest(p), 2)).toThrow();
  for (const over of [{ runAttempt: 2 }, { labels: ["ci-full"] }, { event: "push" }, { event: "workflow_dispatch" }, { headRef: "train/1" }]) {
    expect(buildPlan(facts({ ...over, mode: "on", select: () => { throw new Error("must not select"); } })).scope).toBe("full");
  }
  for (const queueMode of ["off", "UNKNOWN"]) {
    const { queueMode: frozen, ...p } = buildPlan(facts({ queueMode })), { queueMode: _, ...before } = buildPlan(facts({ queueMode: "off" }));
    expect(frozen).toBe(queueMode); expect(p).toEqual(before);
  }
  const { queueMode: _, ...before } = buildPlan(facts({ queueMode: "off" }));
  for (const queueMode of ["", "observe"]) {
    const observed = buildPlan(facts({ queueMode })), { light, queueMode: frozen, ...rest } = observed;
    expect(frozen).toBe(queueMode);
    expect(rest).toEqual(before); expect(light?.tests).toEqual(pick().tests);
    expect(planLine(observed, planDigest(observed))).toContain("light 会选 2（改动测试 1 + 直接引用 1）");
  }
});

test("empty light shard verifies only explicit zero=1 and retains digest/head binding", () => {
  const p = buildPlan(facts({ lightSelect: () => ({ tests: [], changed: 0, direct: 0, reasons: [] }) }));
  const digest = planDigest(p), text = JSON.stringify(p), log = `shard=1/1\nhead=${H}\nplan=${digest}\nzero=1`;
  const want = { n: 1, head: H, bun: "1" };
  expect(verifyRelated(text, digest, new Map([["test-shard-1", log]]), want)).toEqual([]);
  expect(verifyRelated(text, digest, new Map([["test-shard-1", log.replace("zero=1", "bun test v1 (x)")]]), want).join()).toContain("zero=1");
  expect(verifyRelated(text, digest, new Map([["test-shard-1", log]]), { ...want, n: 8 }).join()).toContain("light 只能分 1 片");
  expect(verifyRelated(text, "sha256:other", new Map(), want).join()).toContain("digest");
});

test("light desktop ignores desktop switch; untouched skips, desktop inputs and unreadable diff run", () => {
  const f = { event: "pull_request", headRef: "task/T", mode: "observe" as const, scope: "light", changes: [{ status: "M" as const, path: "src/a.ts" }], bad: [] };
  expect(decideDesktopScope(f).run).toBe(false);
  expect(decideDesktopScope({ ...f, changes: [{ status: "M", path: "desktop/app.ts" }] }).run).toBe(true);
  expect(decideDesktopScope({ ...f, bad: ["unknown"] }).run).toBe(true);
  expect(decideDesktopScope({ ...f, scope: "full" }).run).toBe(true);
});

test("workflow freezes light switch/labels/attempt, uses one shard and plan-controlled desktop", () => {
  const text = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"), ci = Bun.YAML.parse(text) as any;
  expect(text.match(/vars\.CI_QUEUE_LIGHT/g)).toHaveLength(1);
  expect(ci.jobs.plan.steps.find((s: any) => s.id === "plan").env).toMatchObject({ CI_QUEUE_LIGHT: "${{ vars.CI_QUEUE_LIGHT }}",
    GITHUB_RUN_ATTEMPT: "${{ github.run_attempt }}", CI_PR_LABELS: "${{ toJSON(github.event.pull_request.labels.*.name) }}" });
  expect(ci.jobs.tests.strategy.matrix.shard).toBe("${{ fromJSON(needs.plan.outputs.scope == 'light' && '[1]' || '[1,2,3,4,5,6,7,8]') }}");
  const unit = ci.jobs.tests.steps.find((s: any) => s.name === "Unit tests").run;
  expect(unit).toContain('"${{ needs.plan.outputs.scope }}" = light');
  expect(unit).toContain("needs.plan.outputs.scope == 'light' && '1' || '8'");
  expect(ci.jobs.check.steps.find((s: any) => s.run?.includes("ci-related-verify.ts")).run).toContain("needs.plan.outputs.scope == 'light' && '1' || '8'");
  expect(ci.jobs["desktop-scope"].needs).toBe("plan");
  expect(ci.jobs["desktop-scope"].steps.find((s: any) => s.id === "scope").env.CI_PLAN_SCOPE).toBe("${{ needs.plan.outputs.scope }}");
  const guard = ci.jobs.tests.steps.find((s: any) => s.name === "Guard (ratchets)");
  expect(guard.run).toBe("bun run guard"); expect(guard.env.GUARD_STRICT).toBe("1");
  const fixed = [ci.jobs.web, ci.jobs["web-build"], ci.jobs.proof, ci.concurrency, ci.jobs.check.steps.find((s: any) => s.name === "All shards succeeded"), guard];
  expect(createHash("sha256").update(JSON.stringify(fixed)).digest("hex")).toBe("8279edb6fe41edc5d8691d8bc3af50249236cca76959d476aac6d992869cec6f");
});

test("failed light graph falls back full and keeps the PR head binding; observe preserves execution", () => {
  const lightSelect = () => { throw new Error("parse failed"); };
  const p = buildPlan(facts({ lightSelect }));
  expect(p).toMatchObject({ scope: "full", prHead: P, queueMode: "on" }); expect(p.reasons.join()).toContain("parse failed");
  expect(buildPlan(facts({ lightSelect, queueMode: "observe" }))).toMatchObject({ scope: "full", prHead: P, reasons: ["ciRelatedChecks=off"] });
});
