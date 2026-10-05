/**
 * scheduler-update-fail-remote 的私有子进程：每个用例由原入口（本测试文件）在 `env -i` + `bun --no-env-file test` 的子进程里真跑，
 * 显式临时 HOME / XDG / GH_CONFIG_DIR / STATE / RUNTIME / TMP，BRIDGE_URL 与 HTTP(S) 代理都指向拒连的 127.0.0.1:9。
 * 旧红：fix 单出池前 probeFixStart 用默认 realGh 起真 `gh api repos/o/r/compare/…`，继承父进程 env 与 HOME——本机登录的 gh
 * 会读 keyring 凭据真连 GitHub（404 → 走「gh compare 失败」告警），一次往返 0.8s 起、上限 60s，全量负载下单条用例撞 5s 超时。
 * 子进程里没有 gh 凭据、代理拒连：gh 在本地就失败（exit 4），走同一条告警分支，生产 gate / 配置与断言都不动。
 * 子进程只登记 CLAUDESTRA_UPDTEST_MODE 指定的那一条原用例；父进程核退出码、Ran 1 / 1 pass / 0 fail 与 expect 数，并清掉临时根。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

export const MODES = ["hex", "plain", "secret"] as const;
export type Mode = (typeof MODES)[number];
/** 每条原用例跑完的 expect() 数：少了即断言被跳过或提前返回 */
const EXPECTS: Record<Mode, number> = { hex: 13, plain: 10, secret: 17 };

const MODE_ENV = "CLAUDESTRA_UPDTEST_MODE";
const HOOK_ENV = "CLAUDESTRA_UPDTEST_HOOK";
const REPORT = "UPDTEST-CHILD ";
const REFUSED = "http://127.0.0.1:9";
const ENTRY = join(import.meta.dir, "scheduler-update-fail-remote.test.ts");

/** corrupt：故意改坏一条子断言；failSetup：fixture 建好后 setup 抛错（finally 照常关库） */
export type Hook = "corrupt" | "failSetup";
export interface Child { mode: Mode; hook: Hook | null }

/** 子进程侧：本进程是不是父进程起的私有子进程、跑哪条 */
export function childCase(): Child | null {
  const mode = process.env[MODE_ENV] as Mode | undefined;
  if (!mode) return null;
  if (!MODES.includes(mode)) throw new Error(`未知 ${MODE_ENV}=${mode}`);
  const hook = process.env[HOOK_ENV] || null;
  if (hook !== null && hook !== "corrupt" && hook !== "failSetup") throw new Error(`未知 ${HOOK_ENV}=${hook}`);
  return { mode, hook };
}

export interface ChildInfo {
  pid: number; home: string; state: string; runtime: string; tmp: string; bridge: string;
  fixtureDir: string; ledger: string; nonce: string; nonces: string[];
}

/** 子进程侧、关库之前：往本用例自己的台账写一个随机 key 再读回全部，连同私有目录报给父进程 */
export function reportChild(f: { db: Database; dir: string }): void {
  const nonce = crypto.randomUUID();
  f.db.run("INSERT INTO meta (project, key, value) VALUES ('updtest', ?, ?)", [`nonce:${nonce}`, nonce]);
  const nonces = (f.db.query("SELECT value FROM meta WHERE project = 'updtest' ORDER BY value").all() as { value: string }[]).map((r) => r.value);
  const e = process.env;
  const info: ChildInfo = { pid: process.pid, home: e.HOME!, state: e.CLAUDESTRA_STATE_DIR!, runtime: e.CLAUDESTRA_RUNTIME_DIR!, tmp: e.TMPDIR!,
    bridge: e.BRIDGE_URL!, fixtureDir: f.dir, ledger: join(f.dir, "ledger.sqlite"), nonce, nonces };
  process.stdout.write(`${REPORT}${JSON.stringify(info)}\n`);
}

export interface ChildRun {
  mode: Mode; hook: Hook | null; root: string; code: number | null; out: string; err: string;
  info: ChildInfo | null; ran: number; pass: number; fail: number; expects: number;
  /** 子进程退出后、父进程删临时根之前，它自己的 fixture 目录还在不在（应已由 f.close 删掉） */
  fixtureLeft: boolean; rootRemoved: boolean;
}

const count = (text: string, re: RegExp) => Number(re.exec(text)?.[1] ?? -1);

/** 父进程侧：起一个私有子进程跑原入口里的一条原用例，await 退出后删临时根；不在这里判对错 */
export async function runChild(mode: Mode, hook: Hook | null = null): Promise<ChildRun> {
  const root = mkdtempSync(join(tmpdir(), "updtest-child-"));
  const dirs = Object.fromEntries(["home", "config", "state", "runtime", "tmp"].map((name) => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  const env = testChildEnv({
    HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, GH_CONFIG_DIR: join(dirs.config, "gh"),
    CLAUDESTRA_STATE_DIR: dirs.state, CLAUDESTRA_RUNTIME_DIR: dirs.runtime, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
    HTTPS_PROXY: REFUSED, HTTP_PROXY: REFUSED, ALL_PROXY: REFUSED, https_proxy: REFUSED, http_proxy: REFUSED, all_proxy: REFUSED,
    GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", [MODE_ENV]: mode, ...(hook ? { [HOOK_ENV]: hook } : {}),
  });
  const child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", "test", ENTRY], {
    cwd: join(import.meta.dir, ".."), env: testChildEnv(), stdout: "pipe", stderr: "pipe",
  });
  let out = "", err = "", code: number | null = null;
  try {
    [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  const lines = out.split("\n").filter((l) => l.startsWith(REPORT));
  const info = lines.length === 1 ? JSON.parse(lines[0]!.slice(REPORT.length)) as ChildInfo : null;
  const fixtureLeft = info ? existsSync(info.fixtureDir) : false;
  rmSync(root, { recursive: true, force: true });
  return { mode, hook, root, code, out, err, info, fixtureLeft, rootRemoved: !existsSync(root),
    ran: count(err, /\bRan (\d+) tests?\b/), pass: count(err, /^\s*(\d+) pass$/m), fail: count(err, /^\s*(\d+) fail$/m),
    expects: count(err, /^\s*(\d+) expect\(\) calls?$/m) };
}

/** 一条子进程跑绿的全部条件；任一不满足就抛（带子进程输出尾部），父入口据此失败 */
export function assertChildPassed(r: ChildRun): ChildInfo {
  const why = [
    r.code !== 0 && `退出码 ${r.code}`,
    r.ran !== 1 && `Ran ${r.ran}（应为 1）`,
    r.pass !== 1 && `${r.pass} pass（应为 1）`,
    r.fail !== 0 && `${r.fail} fail（应为 0）`,
    r.expects !== EXPECTS[r.mode] && `${r.expects} expect() calls（应为 ${EXPECTS[r.mode]}）`,
    !r.info && "没有恰好一行子进程报告",
    r.fixtureLeft && "子进程退出后 fixture 目录没被它自己关库删掉",
    !r.rootRemoved && "临时根没删掉",
  ].filter(Boolean);
  if (why.length) throw new Error(`私有子进程 ${r.mode}${r.hook ? `/${r.hook}` : ""} 不算通过：${why.join("；")}\n${(r.out + r.err).slice(-6000)}`);
  const info = r.info!;
  const inRoot = (p: string) => p === r.root || p.startsWith(`${r.root}/`);
  const own = [info.home, info.state, info.runtime, info.tmp, info.fixtureDir].filter((p) => !inRoot(p));
  if (own.length || info.bridge !== "ws://127.0.0.1:9" || info.nonces.join() !== info.nonce) {
    throw new Error(`私有子进程 ${r.mode} 的目录 / 连接 / key 不是自己的：${JSON.stringify(info)}`);
  }
  return info;
}
