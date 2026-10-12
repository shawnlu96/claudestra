/**
 * merge-arch-IMPACT1: src/lib/ci-impact-graph.ts — what the oxc scanner records (edges, non-literal loads, repo io), how specs
 * resolve (.js → .ts, extensionless, index, tsconfig alias, external, unresolved) and the closures over cycles.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSync } from "oxc-parser";
import {
  buildGraph, forwardClosure, isTestFile, oxcScanner, type OxcParseSync, resolveSpec, reverseClosure, tsconfigAliases, withEdges,
} from "../src/lib/ci-impact-graph.js";

const scan = oxcScanner(parseSync as unknown as OxcParseSync);
const specs = (src: string, file = "src/a.ts") => scan(file, src).specs.map((s) => `${s.kind}:${s.spec}`).sort();
const repo = (files: Record<string, string>) => ({ paths: Object.keys(files), read: (p: string) => files[p]! });
const ALIAS = [{ prefix: "@/", target: "web/" }];

describe("[验收线 1] the scanner sees every literal edge", () => {
  test("static, export-from, type-only, literal dynamic / template, require, TS import types, import-equals, URL and Worker", () => {
    const src = [
      `import { a } from "./a.js"; import type { T } from "./t.js"; import { type U } from "./u"; import "./side";`,
      `export * from "./star.js"; export { e } from "./e"; export type { X } from "./x.js";`,
      "const d = await import(\"./d.js\"); const tl = await import(`./tl.js`); const r = require(\"./r\");",
      `let q: import("./ty").T; import eq = require("./eq");`,
      `const u = new URL("./fixture.json", import.meta.url); const w = new Worker("./worker.ts");`,
    ].join("\n");
    expect(specs(src)).toEqual([
      "dynamic:./d.js", "dynamic:./tl.js", "dynamic:./worker.ts", "require:./eq", "require:./r", "static:./a.js", "static:./e", "static:./side",
      "static:./star.js", "static:./u", "type:./t.js", "type:./ty", "type:./x.js", "url:./fixture.json",
    ]);
  });

  test("imports inside comments and strings are not edges", () => {
    expect(specs(`// import "./c1.js"\n/* import("./c2.js") */ const s = "import('./c3.js')"; const t = \`require("./c4")\`;`)).toEqual([]);
  });

  test("non-literal loads are recorded with their line, never resolved", () => {
    const s = scan("src/a.ts", "const a = 1;\nawait import(name);\nrequire(p);\nawait import(`./${n}.js`);\nnew URL(`./${f}`, import.meta.url);");
    expect(s.dynamic.map((d) => d.split(":")[0]).sort()).toEqual(["2", "3", "4", "5"]);
    expect(s.specs).toEqual([]);
  });

  test("repo io: locating the repo is separate from reading, walking and spawning", () => {
    expect(scan("t.ts", `const x = 1;`).io).toEqual([]);
    expect(scan("t.ts", `readFileSync(join(import.meta.dir, "x"));`).io).toEqual(["locate", "read"]);
    expect(scan("t.ts", `for (const f of readdirSync(REPO_ROOT)) f;`).io).toEqual(["locate", "walk"]);
    expect(scan("t.ts", `new Bun.Glob("**").scanSync(process.cwd());`).io).toEqual(["locate", "walk"]);
    expect(scan("t.ts", "Bun.spawnSync([\"git\"], { cwd: SRC_DIR }); $`ls`;").io).toEqual(["locate", "spawn"]);
    // a regex .exec() is not a subprocess; a directory URL only locates
    expect(scan("t.ts", `/x/.exec("y"); const root = new URL("../", import.meta.url);`).io).toEqual(["locate"]);
  });

  test("a parse error is reported, not thrown", () => {
    expect(scan("src/bad.ts", "import { from ;").error).toBeString();
  });
});

describe("[验收线 1] spec resolution", () => {
  const files = new Set(["src/lib/a.ts", "src/lib/b.tsx", "src/lib/dir/index.ts", "web/lib/x.ts", "tests/t.test.ts", "data/d.json", "src/lib/m.mts"]);
  const has = (p: string) => files.has(p);
  const r = (from: string, spec: string) => resolveSpec(from, spec, has, ALIAS);

  test(".js names the .ts / .tsx file, extensionless and directory specs find the file / index", () => {
    expect(r("src/x.ts", "./lib/a.js")).toEqual({ kind: "file", path: "src/lib/a.ts" });
    expect(r("src/lib/z.ts", "./b.js")).toEqual({ kind: "file", path: "src/lib/b.tsx" });
    expect(r("tests/t.test.ts", "../src/lib/a")).toEqual({ kind: "file", path: "src/lib/a.ts" });
    expect(r("tests/t.test.ts", "../src/lib/a.ts")).toEqual({ kind: "file", path: "src/lib/a.ts" });
    expect(r("src/x.ts", "./lib/dir")).toEqual({ kind: "file", path: "src/lib/dir/index.ts" });
    expect(r("src/x.ts", "./lib/m.mjs")).toEqual({ kind: "file", path: "src/lib/m.mts" });
    expect(r("src/x.ts", "../data/d.json")).toEqual({ kind: "file", path: "data/d.json" });
  });

  test("the tsconfig alias resolves from anywhere; bare and node: specs are external; missing and escaping specs are unresolved", () => {
    expect(r("tests/t.test.ts", "@/lib/x")).toEqual({ kind: "file", path: "web/lib/x.ts" });
    expect(r("web/a/b.ts", "@/lib/x.js")).toEqual({ kind: "file", path: "web/lib/x.ts" });
    for (const s of ["zod", "node:fs", "bun:test", "@scope/pkg"]) expect(r("src/x.ts", s)).toEqual({ kind: "external" });
    expect(r("src/x.ts", "./node_modules/zod/index.js")).toEqual({ kind: "external" });
    expect(r("src/x.ts", "./lib/missing.js")).toEqual({ kind: "unresolved" });
    expect(r("src/x.ts", "../../outside.js")).toEqual({ kind: "unresolved" });
    expect(r("src/x.ts", "@/lib/gone")).toEqual({ kind: "unresolved" });
  });

  test("tsconfig paths (JSONC with comments) become prefix aliases; the repo's own tsconfig maps @/ to web/", () => {
    expect(tsconfigAliases(`{ // c\n "compilerOptions": { "paths": { "@/*": ["./web/*"], "x": ["y"] } } }`)).toEqual(ALIAS);
    expect(tsconfigAliases(`{ "compilerOptions": { "baseUrl": "src", "paths": { "~/*": ["lib/*"] } } }`)).toEqual([{ prefix: "~/", target: "src/lib/" }]);
    expect(tsconfigAliases(readFileSync(join(import.meta.dir, "..", "tsconfig.json"), "utf8"))).toEqual(ALIAS);
  });

  test("test discovery is bun's rule", () => {
    for (const p of ["tests/a.test.ts", "web/x_spec.tsx", "tests/b.test.mjs"]) expect(isTestFile(p)).toBe(true);
    for (const p of ["tests/helper.ts", "tests/fixtures/x.json", "node_modules/p/a.test.ts"]) expect(isTestFile(p)).toBe(false);
  });
});

describe("[验收线 1] graph and closures", () => {
  const files = {
    "src/lib/leaf.ts": `export const leaf = 1;`,
    "src/lib/mid.ts": `export { leaf } from "./leaf.js";`,
    "src/lib/cy-a.ts": `import { b } from "./cy-b.js"; export const a = b;`,
    "src/lib/cy-b.ts": `import { leaf } from "./leaf.js"; import("./cy-a.js"); export const b = leaf;`,
    "web/lib/w.ts": `import { mid } from "../../src/lib/mid";`,
    "tests/a.test.ts": `import "../src/lib/mid.js";`,
    "tests/b.test.ts": `import "../src/lib/cy-a.js";`,
    "tests/w.test.ts": `import "@/lib/w";`,
    "tests/c.test.ts": `import "./missing.js"; await import(x);`,
  };
  const g = buildGraph(repo(files), scan, ALIAS);

  test("deps are resolved and sorted; unresolved and dynamic loads are listed by module", () => {
    expect(g.deps.get("src/lib/cy-b.ts")).toEqual(["src/lib/cy-a.ts", "src/lib/leaf.ts"]);
    expect(g.unresolved).toEqual([{ from: "tests/c.test.ts", spec: "./missing.js" }]);
    expect(g.dynamic.map((d) => d.from)).toEqual(["tests/c.test.ts"]);
  });

  test("reverse closure is transitive, crosses directories through the alias and terminates on cycles", () => {
    const hit = reverseClosure(g, ["src/lib/leaf.ts"]);
    expect([...hit].filter(isTestFile).sort()).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/w.test.ts"]);
    expect([...reverseClosure(g, ["src/lib/cy-a.ts"])].sort()).toEqual(["src/lib/cy-a.ts", "src/lib/cy-b.ts", "tests/b.test.ts"]);
    expect([...forwardClosure(g, ["tests/b.test.ts"])].sort()).toEqual(["src/lib/cy-a.ts", "src/lib/cy-b.ts", "src/lib/leaf.ts", "tests/b.test.ts"]);
  });

  test("withEdges adds hidden edges on a copy and ignores unknown modules", () => {
    const g2 = withEdges(g, [{ from: "tests/c.test.ts", to: ["src/lib/leaf.ts"] }, { from: "nope.ts", to: ["src/lib/leaf.ts"] }]);
    expect(reverseClosure(g2, ["src/lib/leaf.ts"]).has("tests/c.test.ts")).toBe(true);
    expect(reverseClosure(g, ["src/lib/leaf.ts"]).has("tests/c.test.ts")).toBe(false);
    expect(g2.deps.has("nope.ts")).toBe(false);
  });
});
