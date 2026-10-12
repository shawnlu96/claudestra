/**
 * merge-arch-IMPACT1: src/lib/ci-impact-select.ts over synthetic repos (base and head graphs) — what gets selected, every way the
 * proposal falls back to the full suite, and the off / observe / on contract — plus the real registry checked against this repo.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import { buildGraph, isTestFile, oxcScanner, type OxcParseSync } from "../src/lib/ci-impact-graph.js";
import { DEFAULT_IMPACT_INPUTS, globMatch, type ImpactInputs } from "../src/lib/ci-impact-inputs.js";
import { type ChangedFile, ciRelatedChecksMode, parseNameStatus, proposeTests, selectImpactedTests } from "../src/lib/ci-impact-select.js";

const ROOT = join(import.meta.dir, "..");
const scan = oxcScanner(parseSync as unknown as OxcParseSync);
const ALIAS = [{ prefix: "@/", target: "web/" }];
type Files = Record<string, string>;
const side = (files: Files) => ({ paths: Object.keys(files).sort(), graph: buildGraph({ paths: Object.keys(files), read: (p) => files[p]! }, scan, ALIAS) });
const INPUTS: ImpactInputs = {
  fullTriggers: [{ glob: "**/bun.lock", why: "锁文件" }, { glob: ".github/**", why: "workflow" }, { glob: "tests/preload.ts", why: "preload" }],
  alwaysRun: [{ test: "tests/always.test.ts", why: "常跑" }],
  inputMap: [{ inputs: "tests/fixtures/f/**", consumers: ["tests/fixture-kit.ts"], why: "fixture 读者" }],
  implicit: [{ module: "src/lib/runner.ts", deps: ["src/tool.ts"], why: "子进程跑 src/tool.ts" }],
  knownUnresolved: [{ spec: "@/lib/generated", why: "构建生成" }],
  docs: ["**/*.md", "docs/**"],
};
const BASE: Files = {
  "src/lib/leaf.ts": `export const leaf = 1;`,
  "src/lib/mid.ts": `export { leaf } from "./leaf.js";`,
  "src/lib/cy-a.ts": `import { b } from "./cy-b.js"; export const a = b;`,
  "src/lib/cy-b.ts": `import { a } from "./cy-a.js"; export const b = a;`,
  "src/lib/old-name.ts": `export const n = 1;`,
  "src/lib/doomed.ts": `export const d = 1;`,
  "src/lib/runner.ts": `import { join } from "node:path"; export const run = () => Bun.spawnSync(["bun", join(import.meta.dir, "../tool.ts")]);`,
  "src/tool.ts": `console.log(1);`,
  "web/lib/view.ts": `import { leaf } from "../../src/lib/mid.js"; export const v = leaf;`,
  "tests/always.test.ts": `import "bun:test";`,
  "tests/mid.test.ts": `import { leaf } from "../src/lib/mid.js";`,
  "tests/web/view.test.ts": `import { v } from "@/lib/view";`,
  "tests/cycle.test.ts": `import { a } from "../src/lib/cy-a.js";`,
  "tests/name.test.ts": `import { n } from "../src/lib/old-name.js";`,
  "tests/doomed.test.ts": `import { d } from "../src/lib/doomed.js";`,
  "tests/fixture-kit.ts": `export const load = (n: string) => n;`,
  "tests/fx.test.ts": `import { load } from "./fixture-kit.ts";`,
  "tests/runner.test.ts": `import { run } from "../src/lib/runner.js";`,
  "tests/fixtures/f/a.json": `{}`,
  "docs/x.md": "# x",
};
const head = (patch: Files, drop: string[] = []) => {
  const f = { ...BASE, ...patch };
  for (const d of drop) delete f[d];
  return side(f);
};
const propose = (changes: ChangedFile[], h = side(BASE), b = side(BASE), inputs = INPUTS) => proposeTests(changes, b, h, inputs);
const M = (path: string): ChangedFile => ({ status: "M", path });
const ALWAYS = ["tests/always.test.ts"];

describe("[验收线 1] affected tests are selected", () => {
  test("先红: a path-prefix selector misses the cross-directory consumer that the graph finds", () => {
    const changed = "src/lib/leaf.ts";
    const prefix = side(BASE).paths.filter(isTestFile).filter((t) => t.includes(changed.replace(/^src\/lib\//, "").replace(/\.ts$/, "")));
    expect(prefix).not.toContain("tests/web/view.test.ts");
    expect(prefix).not.toContain("tests/mid.test.ts");
    const p = propose([M(changed)]);
    expect(p.reasons).toEqual([]);
    expect(p.tests).toEqual([...ALWAYS, "tests/mid.test.ts", "tests/web/view.test.ts"].sort());
    expect(p.links.find((l) => l.test === "tests/web/view.test.ts")).toEqual({ test: "tests/web/view.test.ts", via: "import", cause: changed });
  });

  test("cycles terminate and select every consumer of the cycle", () => {
    expect(propose([M("src/lib/cy-b.ts")]).tests).toEqual([...ALWAYS, "tests/cycle.test.ts"].sort());
  });

  test("a deletion selects the old consumers from the base graph (and their now-dangling import sends the batch full)", () => {
    const h = head({}, ["src/lib/doomed.ts"]);
    const p = propose([{ status: "D", path: "src/lib/doomed.ts" }], h);
    expect(p.links.find((l) => l.test === "tests/doomed.test.ts")?.cause).toBe("src/lib/doomed.ts（base）");
    expect(p.reasons).toEqual(["未知本地依赖：tests/doomed.test.ts → ../src/lib/doomed.js"]);
    const clean = propose([{ status: "D", path: "src/lib/doomed.ts" }, { status: "D", path: "tests/doomed.test.ts" }], head({}, ["src/lib/doomed.ts", "tests/doomed.test.ts"]));
    expect(clean).toMatchObject({ reasons: [], tests: ALWAYS });
  });

  test("a rename selects consumers of the old path (base) and of the new path (head)", () => {
    const h = head({ "src/lib/new-name.ts": BASE["src/lib/old-name.ts"]!, "tests/name.test.ts": `import { n } from "../src/lib/new-name.js";`,
      "tests/new-consumer.test.ts": `import { n } from "../src/lib/new-name.js";` }, ["src/lib/old-name.ts"]);
    const p = propose([{ status: "R", from: "src/lib/old-name.ts", path: "src/lib/new-name.ts" }], h);
    expect(p.reasons).toEqual([]);
    expect(p.tests).toEqual([...ALWAYS, "tests/name.test.ts", "tests/new-consumer.test.ts"].sort());
  });

  test("a fixture change goes through its registered reader; a helper change reaches its tests; links say why", () => {
    const p = propose([M("tests/fixtures/f/a.json")]);
    expect(p.tests).toEqual([...ALWAYS, "tests/fx.test.ts"].sort());
    expect(p.links.find((l) => l.test === "tests/fx.test.ts")).toEqual({ test: "tests/fx.test.ts", via: "input-map", cause: "tests/fixtures/f/a.json" });
    expect(propose([M("tests/fixture-kit.ts")]).links.find((l) => l.test === "tests/fx.test.ts")?.via).toBe("import");
  });

  test("a new or changed test file is always selected; a registered subprocess dependency is an edge", () => {
    const h = head({ "tests/brand-new.test.ts": `import "bun:test";` });
    expect(propose([{ status: "A", path: "tests/brand-new.test.ts" }], h).tests).toEqual([...ALWAYS, "tests/brand-new.test.ts"].sort());
    expect(propose([M("tests/cycle.test.ts")]).tests).toEqual([...ALWAYS, "tests/cycle.test.ts"].sort());
    expect(propose([M("src/tool.ts")]).tests).toEqual([...ALWAYS, "tests/runner.test.ts"].sort());
  });

  test("tests whose own tests/ code reads the repo are always selected", () => {
    const h = head({ "tests/scan.test.ts": `import { readdirSync } from "node:fs"; readdirSync(import.meta.dir);` });
    const p = propose([M("src/lib/leaf.ts")], h);
    expect(p.tests).toContain("tests/scan.test.ts");
    expect(p.links.find((l) => l.test === "tests/scan.test.ts")).toEqual({ test: "tests/scan.test.ts", via: "reads-repo", cause: "tests/scan.test.ts" });
  });
});

describe("[验收线 2] what the graph cannot bound sends the batch full, never an empty list", () => {
  test("合成全仓扫描: an unregistered module that locates the repo and walks it, reachable from a test, means full", () => {
    const h = head({ "src/lib/scanner.ts": `import { readdirSync } from "node:fs"; export const all = () => readdirSync(import.meta.dir + "/..");`,
      "tests/mid.test.ts": `import "../src/lib/scanner.js"; import "../src/lib/mid.js";` });
    const p = propose([M("docs/x.md")], h);
    expect(p.reasons).toEqual(["未登记的仓库扫描 / 子进程：src/lib/scanner.ts"]);
    expect(p.tests).toEqual(h.paths.filter(isTestFile));
  });

  test("an unknown dynamic path reachable from a test means full; the same module registered does not", () => {
    const loader = { "src/lib/loader.ts": `export const load = (n: string) => import(n);`, "tests/mid.test.ts": `import "../src/lib/loader.js";` };
    expect(propose([M("src/lib/leaf.ts")], head(loader)).reasons).toEqual(["未登记的非字面量动态加载：src/lib/loader.ts"]);
    const registered = { ...INPUTS, implicit: [...INPUTS.implicit, { module: "src/lib/loader.ts", deps: ["src/lib/*.ts"], why: "按名加载 lib" }] };
    const p = propose([M("src/lib/leaf.ts")], head(loader), side(BASE), registered);
    expect(p.reasons).toEqual([]);
    expect(p.tests).toContain("tests/mid.test.ts");
  });

  test("unregistered external inputs, unknown local specs and parse errors mean full; registered generated specs do not", () => {
    expect(propose([M("data/blob.bin")], head({ "data/blob.bin": "x" })).reasons).toEqual(["未登记外部输入：data/blob.bin"]);
    expect(propose([M("src/lib/leaf.ts")], head({ "tests/mid.test.ts": `import "../src/lib/nowhere.js";` })).reasons)
      .toEqual(["未知本地依赖：tests/mid.test.ts → ../src/lib/nowhere.js"]);
    expect(propose([M("src/lib/leaf.ts")], head({ "tests/web/view.test.ts": `import "@/lib/generated";` })).reasons).toEqual([]);
    expect(propose([M("src/lib/leaf.ts")], head({ "src/lib/mid.ts": "export { from" })).reasons[0]).toStartWith("解析失败：src/lib/mid.ts");
  });

  test("lockfile, workflow and preload changes are full triggers, on either side of a rename", () => {
    for (const p of ["bun.lock", "web/bun.lock", ".github/workflows/ci.yml", "tests/preload.ts"]) {
      const r = propose([M(p)], head({ [p]: "x" }));
      expect(r.reasons.length).toBe(1);
      expect(r.reasons[0]).toStartWith(`全量触发：${p}`);
      expect(r.tests).toEqual(head({ [p]: "x" }).paths.filter(isTestFile));
    }
    const renamed = propose([{ status: "R", from: "tests/preload.ts", path: "tests/pre.ts" }], head({ "tests/pre.ts": "" }), side({ ...BASE, "tests/preload.ts": "" }));
    expect(renamed.reasons).toEqual(["全量触发：tests/preload.ts（preload）"]);
  });

  test("a docs-only change keeps the always-run tests (and guard), never an empty list; nothing selectable means full", () => {
    expect(propose([M("docs/x.md")])).toMatchObject({ reasons: [], tests: ALWAYS });
    expect(selectImpactedTests({ mode: "on", changes: [M("docs/x.md")], headPaths: side(BASE).paths, load: () => ({ base: side(BASE), head: side(BASE) }), inputs: INPUTS }))
      .toMatchObject({ run: "selected", tests: ALWAYS, guard: true });
    const bare = { ...INPUTS, alwaysRun: [] };
    expect(propose([M("docs/x.md")], side(BASE), side(BASE), bare).reasons).toEqual(["拟选集为空（不能拿空清单判绿）"]);
    expect(propose([]).reasons).toEqual(["没有改动文件"]);
    expect(propose([M("src/lib/ghost.ts")]).reasons).toEqual(["改动文件不在 head：src/lib/ghost.ts"]);
  });
});

describe("[验收线 3] off / observe / on", () => {
  const all = side(BASE).paths.filter(isTestFile);
  const run = (mode: unknown, changes = [M("src/lib/leaf.ts")], load = () => ({ base: side(BASE), head: side(BASE) })) =>
    selectImpactedTests({ mode, changes, headPaths: side(BASE).paths, load, inputs: INPUTS });
  const picked = [...ALWAYS, "tests/mid.test.ts", "tests/web/view.test.ts"].sort();

  test("the mode reads absent as observe, and only the three exact words; anything else is unknown", () => {
    expect([undefined, null, "off", "observe", "on"].map(ciRelatedChecksMode)).toEqual(["observe", "observe", "off", "observe", "on"]);
    for (const raw of ["", "ON", " on", true, 1, {}, ["on"]]) expect(ciRelatedChecksMode(raw)).toBeNull();
  });

  test("off is the old full run and never parses the repo; an unknown config is full too", () => {
    const boom = () => { throw new Error("must not load"); };
    expect(run("off", undefined, boom)).toMatchObject({ mode: "off", run: "full", tests: all, proposed: null, guard: true });
    expect(run("enabled", undefined, boom)).toMatchObject({ mode: "unknown", run: "full", tests: all, proposed: null, fullReasons: ['ciRelatedChecks 配置未知："enabled"'] });
  });

  test("observe runs everything and only computes the proposal; on runs the proposal", () => {
    expect(run(undefined)).toMatchObject({ mode: "observe", run: "full", tests: all, proposed: picked, fullReasons: [] });
    expect(run("on")).toMatchObject({ mode: "on", run: "selected", tests: picked, proposed: picked });
  });

  test("on with a fallback reason, a failing load or an unreadable diff line runs full with the reasons", () => {
    expect(run("on", [M("bun.lock")], () => ({ base: side(BASE), head: head({ "bun.lock": "" }) }))).toMatchObject({ run: "full", fullReasons: ["全量触发：bun.lock（锁文件）"] });
    expect(run("on", undefined, () => { throw new Error("disk"); })).toMatchObject({ run: "full", tests: all, fullReasons: ["图构建失败：disk"] });
    const bad = selectImpactedTests({ mode: "on", changes: [], badChanges: ["X\tweird"], headPaths: side(BASE).paths, load: () => ({ base: side(BASE), head: side(BASE) }), inputs: INPUTS });
    expect(bad.run).toBe("full");
    expect(bad.fullReasons[0]).toBe("改动行读不懂：X\tweird");
  });

  test("the digest is deterministic and covers what runs", () => {
    expect(run("on").digest).toBe(run("on").digest);
    expect(run("on").digest).not.toBe(run(undefined).digest);
    expect(run("on").digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("git name-status lines parse into changes; anything else is reported, not guessed", () => {
    expect(parseNameStatus("M\ta.ts\nA\tb.ts\nD\tc.ts\nR087\told.ts\tnew.ts\nC100\tx.ts\ty.ts\nT\tl\n\n")).toEqual({ bad: [], changes: [
      { status: "M", path: "a.ts" }, { status: "A", path: "b.ts" }, { status: "D", path: "c.ts" }, { status: "R", from: "old.ts", path: "new.ts" },
      { status: "C", from: "x.ts", path: "y.ts" }, { status: "T", path: "l" }] });
    expect(parseNameStatus("U\tconflict.ts\nR100\tonly-one.ts").bad).toEqual(["U\tconflict.ts", "R100\tonly-one.ts"]);
  });
});

describe("[验收线 4] a pure module beside the existing paths", () => {
  const lib = ["ci-impact-graph.ts", "ci-impact-inputs.ts", "ci-impact-select.ts"];
  test("the three files import only each other and system modules", () => {
    for (const f of lib) {
      const src = readFileSync(join(ROOT, "src", "lib", f), "utf8");
      for (const m of src.matchAll(/^import [^;]*? from "([^"]+)";/gm)) expect(m[1]!).toMatch(/^(node:[\w/]+|\.\/ci-impact-[\w-]+\.js)$/);
    }
  });

  test("no src or scripts file imports the selector yet: trains, the serial driver, manual queues and PM ops are untouched", () => {
    const ls = Bun.spawnSync(["git", "ls-files", "src", "scripts"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().split("\n").filter((p) => /\.ts$/.test(p));
    const users = ls.filter((p) => !p.startsWith("src/lib/ci-impact-") && /ci-impact-(graph|select|inputs)/.test(readFileSync(join(ROOT, p), "utf8")));
    expect(users).toEqual([]);
  });
});

describe("[验收线 2] the real registry against this repo", () => {
  test("every registered module, always-run test and input consumer exists; every input glob still matches a file", () => {
    const ls = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean);
    const i = DEFAULT_IMPACT_INPUTS;
    for (const p of [...i.implicit.map((x) => x.module), ...i.alwaysRun.map((x) => x.test), ...i.inputMap.flatMap((x) => x.consumers)]) expect(existsSync(join(ROOT, p))).toBe(true);
    for (const m of i.inputMap) expect(ls.some((p) => globMatch(m.inputs, p))).toBe(true);
    expect(i.implicit.map((x) => x.module)).toEqual([...new Set(i.implicit.map((x) => x.module))].sort());
    expect(globMatch("**/bun.lock", "bun.lock") && globMatch("**/bun.lock", "web/bun.lock") && !globMatch("docs/**", "src/docs.ts")).toBe(true);
  });
});
