/**
 * merge-arch-SELECT2：实测读取图的记录器（src/lib/ci-io-trace.ts）。进程内的用例走注入接缝：fs / promises / child_process / Bun 的浅拷贝
 * 和 Bun.Glob 的子类原型，改的是拷贝，不动本进程真的 node:fs（CI 里本进程自己也可能开着记录器）。最后几条起真的子进程，锁住
 * 「环境变量继承 + preload 装上后静态具名导入也被记到」与「不设就零安装」。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installCiIoTrace, type IoRecord, type IoTraceDeps } from "../src/lib/ci-io-trace.ts";
import { selectImpactedTests } from "../src/lib/ci-impact-select.ts";

const ROOT = resolve(import.meta.dir, "..");
const ME = "tests/ci-io-trace.test.ts";
const req = createRequire(import.meta.url);
type Obj = Record<string, unknown>;
const realFs = req("node:fs") as typeof import("node:fs");

function setup() {
  const lines: string[] = [];
  class G extends Bun.Glob {}
  const d: IoTraceDeps = {
    fs: { ...(realFs as unknown as Obj) }, fsp: { ...(req("node:fs/promises") as Obj) }, cp: { ...(req("node:child_process") as Obj) },
    bun: { file: Bun.file, spawn: Bun.spawn, spawnSync: Bun.spawnSync }, glob: G.prototype as unknown as Obj, root: ROOT,
    write: (l) => { lines.push(l); }, realpath: (p) => realFs.realpathSync(p), isFile: (p) => { try { return realFs.statSync(p).isFile(); } catch { return false; } },
  };
  expect(installCiIoTrace({ CI_IO_TRACE: "unused-with-deps" }, d)).toBe(true);
  const fs = d.fs as unknown as typeof import("node:fs"), fsp = d.fsp as unknown as typeof import("node:fs/promises");
  const cp = d.cp as unknown as typeof import("node:child_process"), bun = d.bun as unknown as typeof Bun;
  return { fs, fsp, cp, bun, G, recs: (): IoRecord[] => lines.map((l) => JSON.parse(l) as IoRecord), lines };
}
const at = (p: string) => join(ROOT, p);
const mine = (recs: IoRecord[]) => recs.filter((r) => r.module === ME).map((r) => `${r.kind} ${r.path}`);

describe("只记仓库里的路径", () => {
  test("仓库外、临时目录、.git/、node_modules/ 一律不记；仓库内的同一个文件只记一次", () => {
    const t = setup(), dir = mkdtempSync(join(tmpdir(), "io-trace-")), f = join(dir, "x.txt");
    try {
      writeFileSync(f, "x");
      t.fs.readFileSync(f);
      t.fs.readdirSync(dir);
      t.fs.existsSync("/etc/hosts");
      t.fs.existsSync(at(".git/HEAD"));
      t.fs.existsSync(at("node_modules/oxc-parser/package.json"));
      t.fs.statSync(at("tests"), { throwIfNoEntry: false });
      expect(t.recs()).toEqual([{ module: ME, kind: "read", path: "tests" }]);
      t.fs.readFileSync(at("package.json"));
      t.fs.readFileSync(at("package.json"), "utf8");
      expect(mine(t.recs())).toEqual(["read tests", "read package.json"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("仓库内不存在的路径也记（existsSync 落空同样是依赖），fd 与非 file: URL 不记", () => {
    const t = setup();
    t.fs.existsSync(at("tests/no-such-fixture.json"));
    t.fs.readFileSync(realFs.openSync(at("package.json"), "r")); // the openSync above is the real one: only the fd read reaches the copy
    expect(mine(t.recs())).toEqual(["read tests/no-such-fixture.json"]);
  });
});

describe("各类调用各有一条", () => {
  test("同步：读类与目录类", () => {
    const t = setup();
    t.fs.readFileSync(at("package.json"));
    t.fs.lstatSync(at("bunfig.toml"));
    t.fs.realpathSync.native(at("tsconfig.json"));
    t.fs.readdirSync(at("scripts"));
    expect(mine(t.recs())).toEqual(["read package.json", "read bunfig.toml", "read tsconfig.json", "walk scripts"]);
  });

  test("回调", async () => {
    const t = setup();
    await new Promise((res) => t.fs.readFile(at("package.json"), res));
    await new Promise((res) => t.fs.readdir(at("scripts"), res));
    expect(mine(t.recs())).toEqual(["read package.json", "walk scripts"]);
  });

  test("promises", async () => {
    const t = setup();
    await t.fsp.readFile(at("package.json"));
    await t.fsp.stat(at("bunfig.toml"));
    await t.fsp.readdir(at("scripts"));
    expect(mine(t.recs())).toEqual(["read package.json", "read bunfig.toml", "walk scripts"]);
  });

  test("Bun.file", async () => {
    const t = setup();
    expect((await t.bun.file(at("package.json")).text()).length).toBeGreaterThan(0);
    expect(mine(t.recs())).toEqual(["read package.json"]);
  });

  test("Bun.Glob：scan / scanSync 记扫描的目录（缺省 cwd = 进程 cwd）", async () => {
    const t = setup();
    expect([...new t.G("*.ts").scanSync(at("scripts"))].length).toBeGreaterThan(0);
    for await (const _ of new t.G("*.json").scan({ cwd: at("web") })) void _;
    expect(new t.G("*.ts").match("a.ts")).toBe(true);
    expect(mine(t.recs())).toEqual(["walk scripts", "walk web"]);
  });

  test("spawn：argv 里仓库内的文件记 spawn，cwd 在仓库内的 git 记该目录的 walk；Bun 与 child_process 都记", () => {
    const t = setup();
    expect(t.bun.spawnSync(["cat", "package.json", "--", "no-such-file"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
    expect(t.bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: at("tests"), stdout: "pipe" }).exitCode).toBe(0);
    t.cp.execFileSync("cat", ["bunfig.toml"], { cwd: ROOT });
    t.cp.execSync("cat tsconfig.json", { cwd: ROOT });
    expect(mine(t.recs())).toEqual(["spawn package.json", "walk tests", "spawn bunfig.toml", "spawn tsconfig.json"]);
  });
});

describe("归属", () => {
  test("嵌套调用：栈里每个仓库模块帧各记一条，记录器自己的帧不算", () => {
    const t = setup();
    const sel = selectImpactedTests({ mode: "observe", changes: [], headPaths: [], load: () => {
      t.fs.readFileSync(at("package.json"));
      throw new Error("只要栈");
    } });
    expect(sel.fullReasons.join()).toContain("只要栈");
    expect(t.recs().filter((r) => r.path === "package.json").map((r) => r.module).sort()).toEqual([ME, "src/lib/ci-impact-select.ts"].sort());
    expect(t.recs().some((r) => r.module === "src/lib/ci-io-trace.ts")).toBe(false);
  });
});

describe("真进程", () => {
  const env = (out?: string) => {
    const e: Record<string, string | undefined> = { ...process.env, CI_IO_TRACE: out };
    if (out === undefined) delete e.CI_IO_TRACE;
    return e;
  };
  const read = (f: string): IoRecord[] => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as IoRecord);

  test("仓库根下起的 `bun <仓库文件>` 靠继承的环境变量装上（sync-fs-trace.ts 的顶层 preload），静态具名导入的读取也记到", () => {
    const dir = mkdtempSync(join(tmpdir(), "io-trace-child-")), out = join(dir, "t.jsonl");
    try {
      const r = Bun.spawnSync([process.execPath, "scripts/ci-test-shard.ts", "plan", "8"], { cwd: ROOT, env: env(out), stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).not.toContain("module");
      const recs = read(out);
      expect(recs).toContainEqual({ module: "scripts/ci-test-shard.ts", kind: "read", path: "scripts/ci-test-durations.json" });
      expect(recs).toContainEqual({ module: "scripts/ci-test-shard.ts", kind: "walk", path: "." }); // git ls-files at the root
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("bun test 里由 tests/preload.ts 装上，测试文件顶层静态导入的 readFileSync 也记到", () => {
    const dir = mkdtempSync(join(tmpdir(), "io-trace-test-")), out = join(dir, "t.jsonl");
    try {
      const r = Bun.spawnSync([process.execPath, "test", "tests/ci-io-map.test.ts"], { cwd: ROOT, env: env(out), stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      expect(read(out)).toContainEqual({ module: "tests/ci-io-map.test.ts", kind: "read", path: ".github/workflows/ci.yml" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  test("不设 CI_IO_TRACE（或设成空串，PR 上就是空串）时零安装：装过的标记不在、什么也不写；对照组设了就装上", () => {
    const dir = mkdtempSync(join(tmpdir(), "io-trace-off-")), out = join(dir, "t.jsonl");
    const probe = `require("node:fs").readFileSync("package.json"); console.log(!!globalThis[Symbol.for("claudestra.ciIoTrace")])`;
    const run = (e: Record<string, string | undefined>) =>
      Bun.spawnSync([process.execPath, "-e", probe], { cwd: ROOT, env: e, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    try {
      expect([run(env()), run(env(""))]).toEqual(["false", "false"]);
      expect(realFs.existsSync(out)).toBe(false);
      expect(run(env(out))).toBe("true");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const t: Obj = { readFileSync: realFs.readFileSync };
    expect(installCiIoTrace({}, { fs: t } as unknown as IoTraceDeps)).toBe(false);
    expect(t.readFileSync).toBe(realFs.readFileSync);
  });
});
