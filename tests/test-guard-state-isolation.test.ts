/**
 * 10-03 事故的端到端回归：子进程走 tests/preload.ts + lib/paths.ts（和真实 bun test 一样），按 peer-* 测试的做法删
 * STATE_DIR 下的 principals.json，再看「生产目录」里的哨兵文件还在不在。生产目录一律由一次性的哨兵目录扮演：要扮演
 * 「不在临时目录下」就得真的不在，所以建在仓库的 node_modules/.cache 下（gitignore、用完即删）；仓库本身在临时目录下时跳过。
 * 运行目录的用例只比路径字符串（子进程只 import paths、不碰 tmux），生产默认值写死在 paths.ts，没法换成哨兵。
 * 只 import 修复前也有的导出：同一个文件能拿去旧代码上跑，复现修复前的失败。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../src/lib/repo-root.ts";
import { pathsOverlap } from "../src/lib/sandbox.ts";
import { isUnderTempDir } from "../src/lib/test-guard.ts";

const PROD_RUNTIME = "/tmp/claude-orchestrator";
const SENTINEL_BASE = join(REPO_ROOT, "node_modules", ".cache", "cstra-test-sentinels");
const SENTINEL_OK = !isUnderTempDir(SENTINEL_BASE);
const SCRIPT = `const p = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/paths.ts"))});
const { rmSync } = await import("node:fs");
rmSync(p.statePath("principals.json"), { force: true });
console.log(JSON.stringify({ env: process.env.CLAUDESTRA_STATE_DIR ?? null, state: p.STATE_DIR, sock: p.TMUX_SOCK }));`;

type Probe = { env: string | null; state: string; sock: string };
let fakeHome = "";
const roots: string[] = [];

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "tgsi-home-"));
});
afterAll(() => {
  for (const d of [fakeHome, ...roots]) rmSync(d, { recursive: true, force: true });
});

/** HOME 一律是临时的假 HOME（闸失效时默认目录也落不到真实 home）；状态 / 运行目录只带 extra 里给的 */
function probe(extra: Record<string, string>): Probe {
  const env: Record<string, string | undefined> = { ...process.env, HOME: fakeHome, ...extra };
  for (const k of ["CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR"]) if (!(k in extra)) delete env[k];
  const r = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "preload.ts"), "-e", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`子进程退出码 ${r.exitCode}\n${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim().split("\n").pop() || "null") as Probe;
}

/** 扮演生产目录的哨兵：<root>/<sub>/principals.json */
function sentinel(sub: string): { root: string; dir: string; marker: string } {
  mkdirSync(SENTINEL_BASE, { recursive: true });
  const root = mkdtempSync(join(SENTINEL_BASE, "s-"));
  roots.push(root);
  const dir = join(root, sub);
  mkdirSync(dir);
  writeFileSync(join(dir, "principals.json"), "{}");
  return { root, dir, marker: join(dir, "principals.json") };
}

const REPLACED = { replaced: true, underTemp: true, outsideProd: true, envAgrees: true, prodIntact: true };
function verdict(got: Probe, given: string, prod?: { root: string; marker: string }) {
  return {
    replaced: resolve(got.state) !== resolve(given), underTemp: isUnderTempDir(got.state),
    outsideProd: prod ? !pathsOverlap(got.state, prod.root) : true, envAgrees: got.env === got.state,
    prodIntact: prod ? existsSync(prod.marker) : true,
  };
}

describe("状态目录：不在临时目录下的一律换成临时目录，哨兵扮演的生产目录不被删", () => {
  const cases: Array<[string, string, (dir: string) => string]> = [
    ["1 伪造 HOME + 继承来的生产路径（事故原样）", ".claude-orchestrator", (dir) => dir],
    ["2 非默认的真实路径（不在临时目录下，也不是任何 home 的默认目录）", "custom-state", (dir) => dir],
    ["3a 状态目录本身是临时目录下的软链，指向生产目录", ".claude-orchestrator", (dir) => {
      const link = join(fakeHome, "state-link");
      symlinkSync(dir, link);
      return link;
    }],
    ["3b 字面上在临时目录下、用 .. 跳出去", ".claude-orchestrator", (dir) => `${tmpdir()}/${"../".repeat(64)}${dir.slice(1)}`],
    ["3c 末尾带 /", ".claude-orchestrator", (dir) => `${dir}/`],
  ];
  for (const [name, sub, given] of cases) {
    test.skipIf(!SENTINEL_OK)(name, () => {
      const prod = sentinel(sub);
      const dir = given(prod.dir);
      expect(verdict(probe({ CLAUDESTRA_STATE_DIR: dir }), dir, prod)).toEqual(REPLACED);
    }, 30_000);
  }

  test("4 临时目录边界：/tmpfoo 只是前缀相同、不在 /tmp 下 → 换", () => {
    const dir = "/tmpfoo/.claude-orchestrator"; // / 下非 root 建不出来，闸失效时子进程也写不到
    expect(verdict(probe({ CLAUDESTRA_STATE_DIR: dir }), dir)).toEqual(REPLACED);
  }, 30_000);

  test("4 临时目录边界：tmpdir 本身、它的子目录（含末尾 / 和不出界的 ..）照用", () => {
    for (const dir of [tmpdir(), join(tmpdir(), "tgsi-state"), `${join(tmpdir(), "tgsi-state")}/`, `${tmpdir()}/a/../tgsi-state`]) {
      const got = probe({ CLAUDESTRA_STATE_DIR: dir });
      expect({ dir, kept: got.state, env: got.env }).toEqual({ dir, kept: dir, env: dir });
    }
  }, 30_000);
});

describe("5 运行目录：TMUX_SOCK 不落在生产的 /tmp/claude-orchestrator", () => {
  const replaced = (sock: string) => ({ outsideProd: !pathsOverlap(sock, PROD_RUNTIME), underTemp: isUnderTempDir(sock) });
  for (const dir of [undefined, PROD_RUNTIME, `${PROD_RUNTIME}/`, "/tmp/x/../claude-orchestrator", `${PROD_RUNTIME}/sub`, "/tmpfoo/run"]) {
    test(`CLAUDESTRA_RUNTIME_DIR=${dir ?? "（没设）"} → 换成临时目录`, () => {
      const got = probe(dir === undefined ? {} : { CLAUDESTRA_RUNTIME_DIR: dir });
      expect({ sock: got.sock, ...replaced(got.sock) }).toEqual({ sock: got.sock, outsideProd: true, underTemp: true });
    }, 30_000);
  }

  test("测试自己的临时运行目录照用", () => {
    const dir = join(tmpdir(), "tgsi-run");
    expect(probe({ CLAUDESTRA_RUNTIME_DIR: dir }).sock).toBe(join(dir, "master.sock"));
  }, 30_000);
});
