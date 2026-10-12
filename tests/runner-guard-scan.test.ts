/**
 * 防漏：tests/ 里被测试 spawn 起来、本身不是 *.test.ts 的执行体，都得在开头调 tests/runner-guard.ts 的 guardRunner()
 * （10-12 runner 按真实 HOME 改写 principals.json 的事故）。新加的 runner 漏调，这里会红。
 *
 * 「被 spawn 的执行体」= *.runner.ts，加上在含 spawn / execFile 的那一行里按文件名点到的 tests/ 下非 .test.ts 文件
 * （`join(import.meta.dir, "x.ts")`、`"tests/x.ts"` 这些写法）。只在 -e 脚本里 import 的 helper、`--preload` 的文件不算执行体。
 */
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";

/** 不写 HOME / 配置目录、所以不加守卫的执行体，写明理由；条目对应的文件不再被 spawn 时这里也会红（免得清单过期） */
const EXEMPT: Record<string, string> = {
  "tests/relay-direct-baseline.ts": "只写 --out 指定的目录（仓库外私密目录，O_EXCL 新建），不写 HOME / 配置目录；也是人手直接跑的测量工具",
};

const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const RUNNER_FILE = /\.runner\.[cm]?[jt]sx?$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name.startsWith(".")) return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : SOURCE.test(e.name) ? [p] : [];
  });
}

/** repo/tests 下被 spawn 的非 .test.ts 执行体（相对 repo 的路径） */
function spawnedExecutables(repo: string): string[] {
  const testsDir = join(repo, "tests");
  const files = walk(testsDir);
  const found = new Set(files.filter((f) => RUNNER_FILE.test(f)));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    if (!/spawn|execFile/.test(src)) continue;
    for (const line of src.split("\n")) {
      if (!/spawn|execFile/.test(line) || /^\s*(import|export)\b/.test(line)) continue;
      // `--preload x.ts` 是给 -e 脚本装的 preload，不是入口
      for (const m of line.replace(/["']--preload["']\s*,\s*(?:\w+\([^)]*\)|["'`][^"'`]*["'`])/g, "").matchAll(/["'`]([^"'`\s$]+\.[cm]?[jt]sx?)["'`]/g)) {
        for (const p of [resolve(dirname(f), m[1]), resolve(repo, m[1])]) {
          const rel = relative(testsDir, p);
          if (!rel.startsWith("..") && !TEST_FILE.test(p) && existsSync(p)) found.add(p);
        }
      }
    }
  }
  return [...found].map((p) => relative(repo, p)).sort();
}

/** 在任何写盘 / 动态 import 之前，顶层调了从 ./runner-guard.ts 引进来的 guardRunner() */
function callsGuard(src: string): boolean {
  if (!/^import\s*\{[^}]*\bguardRunner\b[^}]*\}\s*from\s*["']\.{1,2}\/(?:[\w.-]+\/)*runner-guard(?:\.ts)?["'];?\s*$/m.test(src)) return false;
  if (/\bimport\.meta\.main\b/.test(src)) return /^if \(import\.meta\.main\) \{\n(?:\s*\/\/.*\n)*\s+guardRunner\(\);?\n/m.test(src);
  const call = /^guardRunner\(\);?\s*$/m.exec(src);
  if (!call) return false;
  const firstEffect = /\b(?:writeFileSync|appendFileSync|mkdirSync|mkdtempSync|rmSync|renameSync|copyFileSync|Bun\.write|await\s+import)\s*\(/.exec(src);
  return !firstEffect || call.index < firstEffect.index;
}

function unguarded(repo: string, exempt: Record<string, string> = EXEMPT): string[] {
  return spawnedExecutables(repo).filter((f) => !(f in exempt) && !callsGuard(readFileSync(join(repo, f), "utf8")));
}

const REPO = resolve(import.meta.dir, "..");

test("[验收线 4] tests/ 里每个被 spawn 的非 .test.ts 执行体都调了守卫", () => {
  const spawned = spawnedExecutables(REPO);
  expect(spawned).toContain("tests/api-route-parity.runner.ts");
  expect(unguarded(REPO)).toEqual([]);
  // 豁免清单不过期：每条都还是被 spawn 的执行体
  for (const f of Object.keys(EXEMPT)) expect(spawned).toContain(f);
});

const root = mkdtempSync(join(tmpdir(), "cstra-runner-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 拷一份真实 runner + 起它的测试到假仓库，按需改动 runner 的源码 */
function fakeRepo(edit: (runner: string) => string, extra: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(root, "repo-"));
  mkdirSync(join(repo, "tests"));
  const runner = readFileSync(join(REPO, "tests/api-route-parity.runner.ts"), "utf8");
  writeFileSync(join(repo, "tests/api-route-parity.runner.ts"), edit(runner));
  writeFileSync(join(repo, "tests/api-route-parity.test.ts"), readFileSync(join(REPO, "tests/api-route-parity.test.ts"), "utf8"));
  for (const [name, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  }
  return repo;
}

test("[验收线 4] 故意去掉 runner 的守卫调用 → 红", () => {
  expect(unguarded(fakeRepo((s) => s))).toEqual([]);
  expect(unguarded(fakeRepo((s) => s.replace(/^guardRunner\(\);\n/m, "")))).toEqual(["tests/api-route-parity.runner.ts"]);
  // 只 import 不调、注释掉、挪到写盘之后，都算没调
  expect(unguarded(fakeRepo((s) => s.replace(/^guardRunner\(\);$/m, "// guardRunner();")))).toEqual(["tests/api-route-parity.runner.ts"]);
  expect(unguarded(fakeRepo((s) => s.replace(/^guardRunner\(\);\n/m, "") + "\nguardRunner();\n"))).toEqual(["tests/api-route-parity.runner.ts"]);
  expect(unguarded(fakeRepo((s) => s.replace(/^import \{ guardRunner \}.*\n/m, "const guardRunner = () => {};\n")))).toEqual(["tests/api-route-parity.runner.ts"]);
});

test("[验收线 4] 新加的执行体（spawn 点名的 helper、*.runner.ts）没调守卫 → 红", () => {
  const helper = `import { writeFileSync } from "fs";\nwriteFileSync(process.env.HOME + "/x", "1");\n`;
  const spawner = [
    `import { join } from "path";`,
    `Bun.spawnSync([process.execPath, "--preload", "./only-imported.ts", "-e", "1"]);`,
    `Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "only-imported.ts"), "-e", "1"]);`,
    `Bun.spawnSync([process.execPath, join(import.meta.dir, "new-writer.ts")]);`,
    `Bun.spawnSync([process.execPath, "tests/sub/deep-writer.ts"]);`,
    "",
  ].join("\n");
  const repo = fakeRepo((s) => s, {
    "tests/new-writer.ts": helper,
    "tests/sub/deep-writer.ts": helper,
    "tests/other.runner.ts": helper,
    "tests/new-writer.test.ts": spawner,
    // 只被 import 的 helper 不算执行体
    "tests/only-imported.ts": helper,
  });
  expect(unguarded(repo)).toEqual(["tests/new-writer.ts", "tests/other.runner.ts", "tests/sub/deep-writer.ts"]);
  expect(spawnedExecutables(repo)).not.toContain("tests/only-imported.ts");
  const guarded = `import { guardRunner } from "../runner-guard.ts";\n\nguardRunner();\n${helper}`;
  writeFileSync(join(repo, "tests/sub/deep-writer.ts"), guarded);
  expect(unguarded(repo)).toEqual(["tests/new-writer.ts", "tests/other.runner.ts"]);
  expect(unguarded(repo, { "tests/new-writer.ts": "x", "tests/other.runner.ts": "y" })).toEqual([]);
});

test("[验收线 4] 兼当模块的执行体：守卫要在 import.meta.main 分支第一句", () => {
  const world = readFileSync(join(REPO, "tests/scheduler-merge-reclaim-world.ts"), "utf8");
  const spawner = `Bun.spawnSync({ cmd: [process.execPath, join(REPO_ROOT, "tests/scheduler-merge-reclaim-world.ts")] });\n`;
  const repo = fakeRepo((s) => s, { "tests/scheduler-merge-reclaim-world.ts": world, "tests/scheduler-merge-reclaim.test.ts": spawner });
  expect(spawnedExecutables(repo)).toContain("tests/scheduler-merge-reclaim-world.ts");
  expect(unguarded(repo)).toEqual([]);
  writeFileSync(join(repo, "tests/scheduler-merge-reclaim-world.ts"), world.replace(/^\s+guardRunner\(\);\n/m, ""));
  expect(unguarded(repo)).toEqual(["tests/scheduler-merge-reclaim-world.ts"]);
  // 挪到分支里的写盘之后也算漏
  writeFileSync(join(repo, "tests/scheduler-merge-reclaim-world.ts"), world.replace(/^(\s+)guardRunner\(\);\n(.*\n)/m, "$2$1guardRunner();\n"));
  expect(unguarded(repo)).toEqual(["tests/scheduler-merge-reclaim-world.ts"]);
});
