/**
 * merge-arch-SELECT2：各片读取记录汇总成 io-map.json（scripts/ci-io-map.ts）、ci.yml 只在 push main 记录与汇总、
 * plan.json 的 picked 统计口径（scripts/ci-related-plan.ts）。记录器本身见 tests/ci-io-trace.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildIoMap, type IoMap, missingShards, traceFiles } from "../scripts/ci-io-map.ts";
import { buildPlan, planDigest, planLine, type PlanFacts } from "../scripts/ci-related-plan.ts";
import type { ImpactSelection } from "../src/lib/ci-impact-select.ts";

const ROOT = resolve(import.meta.dir, "..");
const rec = (module: string, kind: string, path: string) => JSON.stringify({ module, kind, path });

describe("汇总", () => {
  test("多份 JSONL → 按模块排序、三类各自排序去重；读不懂的行跳过并计数", () => {
    const a = [rec("src/b.ts", "read", "z.json"), rec("src/b.ts", "read", "a.json"), rec("src/a.ts", "walk", "tests"), ""].join("\n");
    const b = [rec("src/b.ts", "read", "a.json"), rec("src/b.ts", "spawn", "scripts/x.ts"), "{oops", rec("src/c.ts", "write", "x"),
      JSON.stringify({ module: "", kind: "read", path: "x" })].join("\n");
    const { map, bad, lines } = buildIoMap([a, b], "abc", new Date("2026-10-13T00:00:00Z"));
    expect({ bad, lines }).toEqual({ bad: 3, lines: 8 });
    expect(map).toEqual({ version: 1, sha: "abc", generatedAt: "2026-10-13T00:00:00.000Z", entries: [
      { module: "src/a.ts", reads: [], walks: ["tests"], spawns: [] },
      { module: "src/b.ts", reads: ["a.json", "z.json"], walks: [], spawns: ["scripts/x.ts"] },
    ] } satisfies IoMap);
  });

  test("给了片数时缺任何一片就不出图；脚本失败只写原因、退出码非 0（ci.yml 那一步容错）", () => {
    const dir = mkdtempSync(join(tmpdir(), "io-map-"));
    try {
      for (const k of [1, 2]) {
        mkdirSync(join(dir, `ci-io-trace-shard-${k}`));
        writeFileSync(join(dir, `ci-io-trace-shard-${k}`, "io-trace.jsonl"), `${rec(`src/m${k}.ts`, "read", "package.json")}\n`);
      }
      expect(traceFiles(dir).length).toBe(2);
      expect(missingShards(dir, 2)).toEqual([]);
      expect(missingShards(dir, 3)).toEqual(["ci-io-trace-shard-3"]);
      const run = (...a: string[]) => Bun.spawnSync([process.execPath, join(ROOT, "scripts/ci-io-map.ts"), ...a], { stdout: "pipe", stderr: "pipe" });
      const bad = run(dir, join(dir, "out", "io-map.json"), "s", "3");
      expect(bad.exitCode).toBe(1);
      expect(bad.stdout.toString()).toContain("缺分片记录，不出图：ci-io-trace-shard-3");
      const ok = run(dir, join(dir, "out", "io-map.json"), "s", "2");
      expect(ok.exitCode).toBe(0);
      const map = JSON.parse(readFileSync(join(dir, "out", "io-map.json"), "utf8")) as IoMap;
      expect(map.entries.map((e) => e.module)).toEqual(["src/m1.ts", "src/m2.ts"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("ci.yml：只在 push main 的全量跑记录与汇总", () => {
  type Step = { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; "continue-on-error"?: boolean };
  const ci = Bun.YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")) as { jobs: Record<string, { steps: Step[] }> };
  const steps = (job: string) => ci.jobs[job]!.steps;

  test("测试步骤只在 push 时给 CI_IO_TRACE（其余为空串 = 不装），每片上传自己那份", () => {
    const unit = steps("tests").find((s) => s.name === "Unit tests")!;
    expect(unit.env).toEqual({ CI_IO_TRACE: "${{ github.event_name == 'push' && format('{0}/io-trace.jsonl', runner.temp) || '' }}" });
    const up = steps("tests").find((s) => s.with?.name === "ci-io-trace-shard-${{ matrix.shard }}")!;
    expect(up).toMatchObject({ if: "always() && github.event_name == 'push'", "continue-on-error": true });
    expect(up.with!.path).toBe("${{ runner.temp }}/io-trace.jsonl");
    for (const [id, job] of Object.entries(ci.jobs)) for (const s of job.steps) if (s !== unit) expect(`${id}:${JSON.stringify(s.env ?? {})}`).not.toContain("CI_IO_TRACE");
  });

  test("汇总在 check 作业末尾：只在 push、三步都容错，工件 ci-io-map 留 14 天", () => {
    const all = steps("check"), from = all.findIndex((s) => s.with?.pattern === "ci-io-trace-*");
    const mine = all.slice(from);
    expect(mine.map((s) => s.name ?? s.uses)).toEqual(["actions/download-artifact@v4", "Merge io map", "actions/upload-artifact@v4"]);
    for (const s of mine) expect(s).toMatchObject({ if: "github.event_name == 'push'", "continue-on-error": true });
    expect(mine[1]!.run).toBe('bun scripts/ci-io-map.ts io-trace "$RUNNER_TEMP/ci-io-map/io-map.json" "$GITHUB_SHA" 8');
    expect(mine[2]!.with).toMatchObject({ name: "ci-io-map", "retention-days": 14 });
  });
});

describe("plan.json 的 picked：不看兜底原因时选择器本来会挑的测试数", () => {
  const ALL = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/slow.test.ts"];
  const sel = (over: Partial<ImpactSelection>): ImpactSelection => ({ mode: "observe", run: "full", tests: ALL, proposed: ALL, fullReasons: ["未登记的仓库读取 / 扫描 / 子进程：src/x.ts"],
    links: [{ test: "tests/a.test.ts", via: "import", cause: "src/a.ts" }, { test: "tests/slow.test.ts", via: "import", cause: "src/a.ts" }], guard: true, digest: "d", ...over });
  const facts = (s: ImpactSelection, over: Partial<PlanFacts> = {}): PlanFacts => ({ event: "pull_request", sha: "a".repeat(40), mode: "observe", headRef: "task/x",
    allTests: ALL, slow: ["tests/slow.test.ts"], select: () => s, seconds: {}, ...over });

  test("退回全量时 proposed 照旧是整份清单，picked 是选择器真正挑到的（去掉慢清单），日志的拟选改用 picked", () => {
    const p = buildPlan(facts(sel({})));
    expect(p).toMatchObject({ scope: "full", proposed: 3, picked: 1, universe: 4 });
    expect(planLine(p, planDigest(p))).toContain("拟选 1 / 4");
  });

  test("related 时 picked = 实跑数；push / off 没有拟选集", () => {
    const on = buildPlan(facts(sel({ mode: "on", run: "selected", tests: ["tests/a.test.ts"], proposed: ["tests/a.test.ts"], fullReasons: [] }), { mode: "on" }));
    expect(on).toMatchObject({ scope: "related", proposed: 1, picked: 1 });
    expect(buildPlan(facts(sel({}), { event: "push" }))).toMatchObject({ proposed: null, picked: null });
    const off = buildPlan(facts(sel({ mode: "off", proposed: null, links: [], fullReasons: ["ciRelatedChecks=off"] }), { mode: "off" }));
    expect(off).toMatchObject({ proposed: null, picked: null });
    expect(planLine(off, "d")).toContain("无拟选集");
  });
});
