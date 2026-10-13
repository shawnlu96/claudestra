/**
 * merge-arch-SELECT3: the measured read map as a selection input — src/lib/ci-impact-io-map.ts (parse, edges, which map to use),
 * what it changes in src/lib/ci-impact-select.ts, and the CI_IO_MAP switch in scripts/ci-related-plan.ts / ci.yml's plan job.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, isTestFile, oxcScanner, type OxcParseSync, reverseClosure, tsconfigAliases, withEdges } from "../src/lib/ci-impact-graph.js";
import { DEFAULT_IMPACT_INPUTS, globMatch, type ImpactInputs } from "../src/lib/ci-impact-inputs.js";
import { ciIoMapMode, type IoMap, type IoMapEntry, ioMapEdges, type IoMapSource, mainPushRuns, parseIoMap, resolveIoMap,
  unionChanges } from "../src/lib/ci-impact-io-map.js";
import { type ChangedFile, type ImpactSelection, proposeTests, selectImpactedTests } from "../src/lib/ci-impact-select.js";
import { buildPlan, type IoMapSelect, planDigest, planLine, type PlanFacts } from "../scripts/ci-related-plan.ts";

const ROOT = join(import.meta.dir, "..");
const scan = oxcScanner(parseSync as unknown as OxcParseSync);
type Files = Record<string, string>;
const side = (files: Files) => ({ paths: Object.keys(files).sort(), graph: buildGraph({ paths: Object.keys(files), read: (p) => files[p]! }, scan, []) });
const INPUTS: ImpactInputs = {
  fullTriggers: [{ glob: "**/bun.lock", why: "锁文件" }], alwaysRun: [{ test: "tests/always.test.ts", why: "常跑" }],
  inputMap: [{ inputs: "tests/fixtures/f/**", consumers: ["tests/fx.test.ts"], why: "fixture 读者" }],
  implicit: [{ module: "src/lib/runner.ts", deps: ["src/tool.ts"], why: "子进程跑 src/tool.ts" }], knownUnresolved: [], docs: ["**/*.md", "docs/**"],
};
const READS = `import { readFileSync } from "node:fs"; export const load = (p: string) => readFileSync(p, "utf8");`;
const REPO: Files = {
  "src/lib/m.ts": READS,
  "src/lib/via-m.ts": `export { load } from "./m.js";`,
  "src/lib/plain.ts": `export const p = 1;`,
  "src/lib/runner.ts": `export const run = () => Bun.spawnSync(["bun", "src/tool.ts"]);`,
  "src/tool.ts": `console.log(1);`,
  "tests/always.test.ts": `import "bun:test";`,
  "tests/m.test.ts": `import { load } from "../src/lib/m.js";`,
  "tests/via-m.test.ts": `import { load } from "../src/lib/via-m.js";`,
  "tests/plain.test.ts": `import { p } from "../src/lib/plain.js";`,
  "tests/runner.test.ts": `import { run } from "../src/lib/runner.js";`,
  "tests/fx.test.ts": `import "bun:test";`,
  "tests/reader.test.ts": `import { readFileSync } from "node:fs"; readFileSync("data/d/a.json");`,
  "tests/fixtures/f/a.json": `{}`,
  "docs/x.json": `{}`, "docs/y.md": "# y",
  "data/d/a.json": `{}`, "data/other.bin": "x",
};
const repo = (patch: Files = {}, drop: string[] = []) => {
  const f = { ...REPO, ...patch };
  for (const d of drop) delete f[d];
  return side(f);
};
const entry = (module: string, e: Partial<IoMapEntry> = {}): IoMapEntry => ({ module, reads: [], walks: [], spawns: [], ...e });
const M = (path: string): ChangedFile => ({ status: "M", path });
const A = (path: string): ChangedFile => ({ status: "A", path });
const ALWAYS = "tests/always.test.ts", VIA_M = ["tests/m.test.ts", "tests/via-m.test.ts"];
const ALL = repo().paths.filter(isTestFile);
const propose = (changes: ChangedFile[], map: IoMapEntry[] | undefined, h = repo(), b = repo()) => proposeTests(changes, b, h, INPUTS, map);

describe("[先红后绿] 读取图代替两条一刀切的 io 规则", () => {
  test("红测1：真实仓库 + 夹具读取图，只改 src/lib/agent-name.ts → 不是全量，只有反向闭包加 ALWAYS_RUN", () => {
    const paths = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().split("\0").filter(Boolean);
    const aliases = tsconfigAliases(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
    const real = { paths, graph: buildGraph({ paths, read: (p) => readFileSync(join(ROOT, p), "utf8") }, scan, aliases) };
    // 非字面量动态加载照旧要登记：真实仓库现在有 4 个没登记（都经 `as string` 载 web 模块），这里按 webLoader 的写法补上，登记表本身不归本卡
    const loaders = ["editor-contested", "snapshot", "submit-retry", "submit"].map((n) => `tests/web-shared-audit-${n}.test.ts`);
    const registered = new Set(DEFAULT_IMPACT_INPUTS.implicit.map((i) => i.module));
    const tests = paths.filter(isTestFile);
    expect([...new Set(real.graph.dynamic.map((d) => d.from))].filter((m) => !registered.has(m) && tests.includes(m)).sort()).toEqual(loaders);
    const inputs: ImpactInputs = { ...DEFAULT_IMPACT_INPUTS,
      implicit: [...DEFAULT_IMPACT_INPUTS.implicit, ...loaders.map((module) => ({ module, deps: ["web/**"], why: "经路径变量 import web 模块" }))] };
    const map = [entry("src/lib/team-roles.ts", { reads: ["roles/pm.md"] }), entry("tests/lp-state.test.ts", { walks: ["tests/fixtures/lp"] })];
    const changed = "src/lib/agent-name.ts";
    const p = proposeTests([M(changed)], real, real, inputs, map);
    expect(p.reasons).toEqual([]);
    const edges = inputs.implicit.map((e) => ({ from: e.module, to: paths.filter((x) => e.deps.some((d) => globMatch(d, x))) }));
    const closure = [...reverseClosure(withEdges(real.graph, edges), [changed])].filter(isTestFile);
    const want = [...new Set([...closure, ...inputs.alwaysRun.map((a) => a.test)])].sort();
    expect(p.tests).toEqual(want);
    expect(p.tests.length).toBeLessThan(tests.length);
    // 纯 import 的反向闭包只有个位数；多出来的都来自登记表里「子进程跑 src/manager.ts」这类边，登记照旧有效
    expect([...reverseClosure(real.graph, [changed])].filter(isTestFile).length).toBeLessThan(10);
  }, 60_000);

  test("红测2：读取图里 M 读过 docs/x.json，PR 只改它 → 走得到 M 的测试都选上，走不到的不选", () => {
    const p = propose([M("docs/x.json")], [entry("src/lib/m.ts", { reads: ["docs/x.json"] })]);
    expect(p.reasons).toEqual([]);
    expect(p.tests).toEqual([ALWAYS, ...VIA_M].sort());
    expect(p.links.find((l) => l.test === "tests/m.test.ts")).toEqual({ test: "tests/m.test.ts", via: "io-map", cause: "docs/x.json" });
  });

  test("红测3：读取图里 M 扫过目录 data/d，PR 在它下面新增一个文件 → 走得到 M 的测试选上", () => {
    const h = repo({ "data/d/new.json": "{}" });
    const p = propose([A("data/d/new.json")], [entry("src/lib/m.ts", { walks: ["data/d"] })], h);
    expect(p.reasons).toEqual([]);
    expect(p.tests).toEqual([ALWAYS, ...VIA_M].sort());
  });
});

describe("读取图的边", () => {
  const map = [entry("src/lib/m.ts", { walks: ["data/d"] })];
  test("扫过的目录下删、改、改名都算：删和改名的旧路径走 base 图", () => {
    expect(propose([M("data/d/a.json")], map).tests).toEqual([ALWAYS, ...VIA_M].sort());
    const gone = repo({}, ["data/d/a.json"]);
    expect(propose([{ status: "D", path: "data/d/a.json" }], map, gone)).toMatchObject({ reasons: [], tests: [ALWAYS, ...VIA_M].sort() });
    const moved = repo({ "docs/moved.json": "{}" }, ["data/d/a.json"]);
    expect(propose([{ status: "R", from: "data/d/a.json", path: "docs/moved.json" }], map, moved)).toMatchObject({ reasons: [], tests: [ALWAYS, ...VIA_M].sort() });
  });

  test("起过的仓库文件是边；当时不存在、PR 才加上的被读路径也是边；没人读过的外部输入照旧全量", () => {
    expect(propose([M("src/tool.ts")], [entry("src/lib/plain.ts", { spawns: ["src/tool.ts"] })]).tests)
      .toEqual([ALWAYS, "tests/plain.test.ts", "tests/runner.test.ts"].sort());
    const h = repo({ "data/late.json": "{}" });
    expect(propose([A("data/late.json")], [entry("src/lib/plain.ts", { reads: ["data/late.json"] })], h)).toMatchObject({ reasons: [], tests: [ALWAYS, "tests/plain.test.ts"] });
    expect(propose([M("data/other.bin")], map).reasons).toEqual(["未登记外部输入：data/other.bin"]);
  });

  test("只看过目录在不在（exists / stat）的：目录两边都在就不是依赖，目录出现或消失才是", () => {
    const look = [entry("src/lib/plain.ts", { reads: ["data/d", "data/new", "."] })];
    expect(ioMapEdges(look, repo().paths, repo().paths)).toEqual([{ from: "src/lib/plain.ts", to: [] }]);
    const h = repo({ "data/new/a.json": "{}" });
    expect(ioMapEdges(look, h.paths, repo().paths)).toEqual([{ from: "src/lib/plain.ts", to: ["data/new/a.json"] }]);
    expect(propose([A("data/new/a.json")], look, h)).toMatchObject({ reasons: [], tests: [ALWAYS, "tests/plain.test.ts"] });
    const gone = repo({}, ["data/d/a.json"]);
    expect(propose([{ status: "D", path: "data/d/a.json" }], look, gone).tests).toEqual([ALWAYS, "tests/plain.test.ts"]);
  });

  test("同一模块的多条 entry 合成一条边；扫仓库根 = 依赖所有文件；图里不在仓库的模块不加边", () => {
    const e = ioMapEdges([entry("a.ts", { reads: ["docs/y.md"] }), entry("a.ts", { walks: ["docs"] }), entry("b.ts", { walks: ["."] })], repo().paths, repo().paths);
    expect(e).toEqual([{ from: "a.ts", to: ["docs/y.md", "docs/x.json"] }, { from: "b.ts", to: repo().paths }]);
    expect(propose([M("src/lib/plain.ts")], [entry("src/lib/ghost.ts", { walks: ["."] })])).toMatchObject({ reasons: [], tests: [ALWAYS, "tests/plain.test.ts"] });
  });
});

describe("用读取图时变和不变的", () => {
  test("静态判为有 io、读取图里没有它的模块按「不读仓库」处理；tests/ 的 io 不再每次都跑", () => {
    const old = propose([M("src/lib/plain.ts")], undefined);
    expect(old.reasons).toEqual(["未登记的仓库读取 / 扫描 / 子进程：src/lib/m.ts"]);
    expect(old.links.find((l) => l.test === "tests/reader.test.ts")?.via).toBe("reads-repo");
    const p = propose([M("src/lib/plain.ts")], []);
    expect(p).toMatchObject({ reasons: [], tests: [ALWAYS, "tests/plain.test.ts"] });
    // 改了这个模块本身：它是改动文件，反向闭包照旧选上用到它的测试
    expect(propose([M("src/lib/m.ts")], []).tests).toEqual([ALWAYS, ...VIA_M].sort());
    expect(propose([M("data/d/a.json")], [entry("tests/reader.test.ts", { reads: ["data/d/a.json"] })]).tests).toEqual([ALWAYS, "tests/reader.test.ts"]);
  });

  test("现有登记照旧有效（并集）：IMPLICIT_INPUTS 的边、INPUT_MAP 的读者、ALWAYS_RUN", () => {
    expect(propose([M("src/tool.ts")], []).tests).toEqual([ALWAYS, "tests/runner.test.ts"]);
    const fx = propose([M("tests/fixtures/f/a.json")], []);
    expect(fx.tests).toEqual([ALWAYS, "tests/fx.test.ts"]);
    expect(fx.links.find((l) => l.test === "tests/fx.test.ts")?.via).toBe("input-map");
    expect(propose([M("docs/y.md")], [])).toMatchObject({ reasons: [], tests: [ALWAYS] });
  });

  test("FULL_TRIGGERS、未登记的非字面量动态加载、选集为空照旧全量", () => {
    const lock = repo({ "bun.lock": "" });
    expect(propose([M("bun.lock")], [entry("src/lib/m.ts", { reads: ["bun.lock"] })], lock))
      .toMatchObject({ reasons: ["全量触发：bun.lock（锁文件）"], tests: lock.paths.filter(isTestFile) });
    const dyn = repo({ "src/lib/plain.ts": `export const load = (n: string) => import(n);` });
    expect(propose([M("docs/y.md")], [], dyn).reasons).toEqual(["未登记的非字面量动态加载：src/lib/plain.ts"]);
    const inTests = repo({ "tests/plain.test.ts": `const n = "../src/lib/plain.ts"; await import(n);` });
    expect(propose([M("docs/y.md")], [], inTests).reasons).toEqual(["未登记的非字面量动态加载：tests/plain.test.ts"]);
    expect(proposeTests([M("docs/y.md")], repo(), repo(), { ...INPUTS, alwaysRun: [] }, []).reasons).toEqual(["拟选集为空（不能拿空清单判绿）"]);
  });

  test("改动集是并集：读取图之后 main 上进来的改动也算；main 自己删掉的旧路径不算本 PR 的未知", () => {
    const pr = [M("src/lib/plain.ts")], since: ChangedFile[] = [M("src/lib/plain.ts"), M("src/lib/m.ts"), { status: "D", path: "src/lib/gone.ts" }];
    const all = unionChanges(pr, since);
    expect(all).toEqual([M("src/lib/plain.ts"), { ...M("src/lib/m.ts"), sinceMap: true }, { status: "D", path: "src/lib/gone.ts", sinceMap: true }]);
    expect(propose(all, [])).toMatchObject({ reasons: [], tests: [ALWAYS, ...VIA_M, "tests/plain.test.ts"].sort() });
    expect(propose([{ status: "D", path: "src/lib/gone.ts" }], []).reasons).toEqual(["改动旧路径不在 base：src/lib/gone.ts"]);
  });
});

const SHA = "a".repeat(40), NOW = new Date("2026-10-13T06:00:00Z");
const mapText = (over: Partial<IoMap> = {}) => JSON.stringify({ version: 1, sha: SHA, generatedAt: "2026-10-13T05:00:00.000Z",
  entries: [entry("src/lib/m.ts", { reads: ["docs/x.json"] })], ...over });
const runsText = (rows: Record<string, unknown>[]) => JSON.stringify({ workflow_runs: rows });
const okRun = (over: Record<string, unknown> = {}) => ({ id: 7, head_sha: SHA, event: "push", head_branch: "main", status: "completed", conclusion: "success",
  created_at: "2026-10-13T05:00:00Z", ...over });
const source = (over: Partial<IoMapSource> = {}): IoMapSource => ({ runs: () => runsText([okRun()]), isAncestor: () => true, download: () => mapText(), now: NOW, ...over });
const reason = (over: Partial<IoMapSource>) => { const r = resolveIoMap(source(over)); return "reason" in r ? r.reason : "（可用）"; };

describe("[保持测] 取不到可用的读取图就退回现有规则，原因写明", () => {
  test("可用：最近一次成功的 main push 运行、sha 是 PR head 的祖先、图绑定该 sha、不超过 7 天", () => {
    expect(resolveIoMap(source())).toMatchObject({ runId: 7, map: { sha: SHA, entries: [{ module: "src/lib/m.ts" }] } });
    const older = "b".repeat(40), asked: string[] = [];
    const r = resolveIoMap(source({ runs: () => runsText([okRun({ id: 5, head_sha: older, created_at: "2026-10-12T00:00:00Z" }), okRun()]),
      isAncestor: (sha) => { asked.push(sha); return sha === older; }, download: (id) => mapText({ sha: id === 5 ? older : SHA }) }));
    expect(r).toMatchObject({ runId: 5 });
    expect(asked).toEqual([SHA, older]);
  });

  test("只认 main 上成功的 push 运行：PR、别的分支、失败或没跑完的都不算", () => {
    const rows = [okRun({ id: 1, event: "pull_request" }), okRun({ id: 2, head_branch: "task/x" }), okRun({ id: 3, conclusion: "failure" }),
      okRun({ id: 4, status: "in_progress", conclusion: null }), okRun({ id: 5, head_sha: "short" })];
    expect(mainPushRuns(runsText(rows))).toEqual([]);
    expect(reason({ runs: () => runsText(rows) })).toBe("读取图：找不到成功的 main push 运行");
  });

  test("缺失、sha 不是祖先、超过 7 天、解析失败、下载失败、图不是这次运行的，各有原因", () => {
    expect(reason({ runs: () => { throw new Error("gh api：HTTP 403"); } })).toBe("读取图：列 main 运行失败（gh api：HTTP 403）");
    expect(reason({ runs: () => "<html>" })).toStartWith("读取图：列 main 运行失败");
    expect(reason({ isAncestor: () => false })).toBe("读取图：最近 1 次成功 main 运行的 sha 都不是 PR head 的祖先");
    expect(reason({ download: () => { throw new Error("no artifact matches"); } })).toBe("读取图：运行 7 的 ci-io-map 工件找不到或下载失败（no artifact matches）");
    expect(reason({ download: () => "{oops" })).toStartWith("读取图：解析失败");
    expect(reason({ download: () => mapText({ sha: "c".repeat(40) }) })).toContain("不是运行 7 的");
    expect(reason({ download: () => mapText({ generatedAt: "2026-10-06T05:59:59.000Z" }) })).toBe("读取图：生成于 2026-10-06T05:59:59.000Z，超过 7 天");
    expect(reason({ download: () => mapText({ generatedAt: "2026-10-06T06:00:00.000Z" }) })).toBe("（可用）");
  });

  test("io-map.json 的形状不对就是解析失败；CI_IO_MAP 缺省 / 空 = observe，只认三个词", () => {
    for (const bad of ["null", "[]", JSON.stringify({ version: 2 }), mapText({ sha: "abc" }), mapText({ generatedAt: "昨天" }), mapText({ entries: {} as never }),
      mapText({ entries: [{ module: "m", reads: [], walks: [] } as never] }), mapText({ entries: [entry("m", { reads: [1 as never] })] })]) {
      expect(() => parseIoMap(bad)).toThrow();
    }
    expect([undefined, null, "", "off", "observe", "on"].map(ciIoMapMode)).toEqual(["observe", "observe", "observe", "off", "observe", "on"]);
    for (const raw of ["ON", " on", true, 1]) expect(ciIoMapMode(raw)).toBeNull();
  });

  test("ci-impact-io-map.ts 只用系统模块：选择器这一组仍然是纯的", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "ci-impact-io-map.ts"), "utf8");
    expect([...src.matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((m) => m[1]).filter((m) => !/^node:/.test(m!))).toEqual([]);
  });
});

describe("[保持测] CI_IO_MAP：observe 实际跑的不变，on 才用读取图，off 不算", () => {
  const changes = [M("docs/x.json")], headPaths = repo().paths, load = () => ({ base: repo(), head: repo() });
  const select = (mode: unknown): ImpactSelection => selectImpactedTests({ mode, changes, headPaths, load, inputs: INPUTS });
  const withMap = (mode: unknown): IoMapSelect => ({ sha: SHA, generatedAt: "2026-10-13T05:00:00.000Z", reasons: [],
    sel: selectImpactedTests({ mode, changes, headPaths, load, inputs: INPUTS, ioMap: [entry("src/lib/m.ts", { reads: ["docs/x.json"] })] }) });
  const noMap = (): IoMapSelect => ({ sel: null, sha: null, generatedAt: null, reasons: ["读取图：找不到成功的 main push 运行"] });
  const never = () => { throw new Error("must not fetch the read map"); };
  const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ event: "pull_request", sha: SHA, mode: "on", headRef: "task/x", allTests: ALL,
    slow: ["tests/via-m.test.ts"], select, seconds: {}, ioMode: "", ioSelect: withMap, ...over });
  const bare = (p: ReturnType<typeof buildPlan>) => { const { ioMap: _, ...rest } = p; return rest; };

  test("observe（缺省 / 空 / observe）：plan 除多一段 ioMap 外与没有读取图时逐字段相同，日志记「读取图会选 N」", () => {
    for (const mode of ["on", "observe", ""]) {
      const before = buildPlan(facts({ mode, ioMode: undefined, ioSelect: undefined }));
      expect(before.ioMap).toBeUndefined();
      for (const ioMode of ["", "observe"]) {
        const p = buildPlan(facts({ mode, ioMode }));
        expect(bare(p)).toEqual(before);
        expect(p.ioMap).toEqual({ mode: ioMode, used: false, sha: SHA, generatedAt: "2026-10-13T05:00:00.000Z", proposed: 2, picked: 2, reasons: [] });
        expect(planLine(p, "d")).toContain(`读取图会选 2 / ${ALL.length}`);
      }
    }
    // 现有规则下这个仓库有未登记 io，on 也只能全量；实际跑的就是这份
    expect(buildPlan(facts())).toMatchObject({ scope: "full", tests: [], reasons: ["未登记的仓库读取 / 扫描 / 子进程：src/lib/m.ts"] });
    expect(planLine(buildPlan(facts()), "d")).toContain("读取图 mode=(缺省 observe) 读取图会选");
  });

  test("on：普通 PR 跑读取图的选集（慢清单照旧排除）；读取图的选集要全量时照旧全量并带原因", () => {
    const p = buildPlan(facts({ ioMode: "on" }));
    expect(p).toMatchObject({ scope: "related", tests: [ALWAYS, "tests/m.test.ts"], reasons: [], proposed: 2, picked: 2, ioMap: { used: true, proposed: 2 } });
    expect(planLine(p, "d")).toContain("已采用 读取图会选 2");
    expect(planDigest(p)).not.toBe(planDigest(buildPlan(facts({ ioMode: "observe" }))));
    const lock = (mode: unknown): IoMapSelect => ({ ...withMap(mode), sel: selectImpactedTests({ mode, changes: [M("bun.lock")], headPaths: [...headPaths, "bun.lock"],
      load: () => ({ base: repo({ "bun.lock": "" }), head: repo({ "bun.lock": "" }) }), inputs: INPUTS, ioMap: [] }) });
    expect(buildPlan(facts({ ioMode: "on", ioSelect: lock }))).toMatchObject({ scope: "full", reasons: ["全量触发：bun.lock（锁文件）"], ioMap: { used: true } });
    // CI_RELATED_CHECKS 没开到 on 时读取图也只是记录
    expect(buildPlan(facts({ mode: "observe", ioMode: "on" }))).toMatchObject({ scope: "full", tests: [], proposed: 2, ioMap: { used: true } });
  });

  test("on 但读取图不可用：退回现有规则，原因进 ioMap.reasons，全量时也进 reasons", () => {
    const p = buildPlan(facts({ ioMode: "on", ioSelect: noMap }));
    expect(bare(p)).toEqual({ ...buildPlan(facts({ ioMode: undefined, ioSelect: undefined })),
      reasons: ["未登记的仓库读取 / 扫描 / 子进程：src/lib/m.ts", "读取图：找不到成功的 main push 运行"] });
    expect(p.ioMap).toEqual({ mode: "on", used: false, sha: null, generatedAt: null, proposed: null, picked: null, reasons: ["读取图：找不到成功的 main push 运行"] });
    expect(planLine(p, "d")).toContain("读取图 mode=on 不可用（读取图：找不到成功的 main push 运行）");
    const observed = buildPlan(facts({ ioMode: "observe", ioSelect: noMap }));
    expect(bare(observed)).toEqual(buildPlan(facts({ ioMode: undefined, ioSelect: undefined })));
    // 退回的现有规则本身给得出选集时照样跑选集
    const clean = (mode: unknown) => selectImpactedTests({ mode, changes: [M("src/lib/plain.ts")], headPaths, load: () => ({ base: repo({ "src/lib/m.ts": "" }),
      head: repo({ "src/lib/m.ts": "", "tests/reader.test.ts": "" }) }), inputs: INPUTS });
    expect(buildPlan(facts({ ioMode: "on", ioSelect: noMap, select: clean }))).toMatchObject({ scope: "related", tests: [ALWAYS, "tests/plain.test.ts"], reasons: [] });
  });

  test("off、未知值、CI_RELATED_CHECKS=off、push、列车、补验：都不去取读取图", () => {
    expect(buildPlan(facts({ ioMode: "off", ioSelect: never })).ioMap).toBeUndefined();
    const odd = buildPlan(facts({ ioMode: "ON", ioSelect: never }));
    expect(odd.ioMap).toMatchObject({ used: false, proposed: null, reasons: ['CI_IO_MAP 配置未知："ON"（按现有规则）'] });
    expect(bare(odd)).toEqual(buildPlan(facts({ ioMode: undefined, ioSelect: undefined })));
    expect(buildPlan(facts({ mode: "off", ioMode: "on", ioSelect: never }))).toMatchObject({ scope: "full", reasons: ["ciRelatedChecks=off"] });
    for (const over of [{ event: "push" }, { headRef: "train/42" }, { event: "workflow_dispatch" }]) {
      const p = buildPlan(facts({ ...over, ioMode: "on", ioSelect: never, select: never }));
      expect(p.scope).toBe("full");
      expect(p.ioMap).toBeUndefined();
    }
  });
});

describe("ci.yml：只改 plan 作业", () => {
  interface Step { name?: string; env?: Record<string, string> }
  const text = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const ci = Bun.YAML.parse(text) as { permissions?: unknown; jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }> };

  test("CI_IO_MAP 是受信仓库变量，只在 plan 作业读一次；下载工件用只读的 actions 权限", () => {
    expect(text.match(/vars\.CI_IO_MAP/g)).toHaveLength(1);
    const env = ci.jobs.plan!.steps.find((s) => s.name === "Plan test selection")!.env!;
    expect(env).toMatchObject({ CI_IO_MAP: "${{ vars.CI_IO_MAP }}", GH_TOKEN: "${{ github.token }}", CI_RELATED_CHECKS: "${{ vars.CI_RELATED_CHECKS }}" });
    expect(ci.jobs.plan!.permissions).toEqual({ contents: "read", actions: "read" });
    for (const [id, job] of Object.entries(ci.jobs)) if (id !== "plan") expect(`${id}:${job.permissions === undefined}`).toBe(`${id}:true`);
    expect(ci.permissions).toBeUndefined();
  });
});
