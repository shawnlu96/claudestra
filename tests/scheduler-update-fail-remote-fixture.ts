/**
 * scheduler-update-fail-remote 的私有子进程：每个用例由原入口（本测试文件）在 `env -i` + `bun --no-env-file test` 的子进程里真跑，
 * 显式临时 HOME / XDG / GH_CONFIG_DIR / STATE / RUNTIME / TMP，BRIDGE_URL 与 HTTP(S) 代理都指向拒连的 127.0.0.1:9。
 * 旧红：fix 单出池前 probeFixStart 用默认 realGh 起真 `gh api repos/o/r/compare/…`，继承父进程 env 与 HOME——本机登录的 gh
 * 会读 keyring 凭据真连 GitHub（404 → 走「gh compare 失败」告警），一次往返 0.8s 起、上限 60s，全量负载下单条用例撞 5s 超时。
 * 子进程里没有 gh 凭据、代理拒连：gh 在本地就失败（exit 4），走同一条告警分支，生产 gate / 配置与断言都不动。
 * 子进程只登记 CLAUDESTRA_UPDTEST_MODE 指定的那一条原用例；父进程核退出码、Ran 1 / 1 pass / 0 fail 与 expect 数，并清掉临时根。
 */
import { Database } from "bun:sqlite";
import { afterAll, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.ts";

// The runner budget covers fixture + ticks; the process deadline also covers imports and preload cleanup.
export const CHILD_TEST_MS = 15_000;
const CHILD_PROCESS_MS = CHILD_TEST_MS + 30_000;
const CLEANUP_MS = 5_000;

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
  timing: { startedAt: number; fixtureMs: number; tickMs: number; cleanupMs: number; testMs: number };
}

/** Report the original isolation receipt and phase timings; closing still runs if receipt creation fails. */
export function reportChild(f: { db: Database; dir: string; close(): void }, timing: Omit<ChildInfo["timing"], "cleanupMs" | "testMs">): void {
  let info: ChildInfo;
  let cleanupMs = 0;
  try {
    const nonce = crypto.randomUUID();
    f.db.run("INSERT INTO meta (project, key, value) VALUES ('updtest', ?, ?)", [`nonce:${nonce}`, nonce]);
    const nonces = (f.db.query("SELECT value FROM meta WHERE project = 'updtest' ORDER BY value").all() as { value: string }[]).map((r) => r.value);
    const e = process.env;
    info = { pid: process.pid, home: e.HOME!, state: e.CLAUDESTRA_STATE_DIR!, runtime: e.CLAUDESTRA_RUNTIME_DIR!, tmp: e.TMPDIR!,
      bridge: e.BRIDGE_URL!, fixtureDir: f.dir, ledger: join(f.dir, "ledger.sqlite"), nonce, nonces,
      timing: { ...timing, cleanupMs: 0, testMs: 0 } };
  } finally {
    const start = performance.now();
    f.close();
    cleanupMs = performance.now() - start;
  }
  info.timing.cleanupMs = cleanupMs;
  info.timing.testMs = Date.now() - timing.startedAt;
  process.stdout.write(`${REPORT}${JSON.stringify(info)}\n`);
}

export interface ChildRun {
  mode: Mode; hook: Hook | null; root: string; code: number | null; out: string; err: string;
  info: ChildInfo | null; ran: number; pass: number; fail: number; expects: number;
  /** 子进程退出后、父进程删临时根之前，它自己的 fixture 目录还在不在（应已由 f.close 删掉） */
  fixtureLeft: boolean; rootRemoved: boolean;
}

const count = (text: string, re: RegExp) => Number(re.exec(text)?.[1] ?? -1);

class ChildDeadline extends Error {}

/** A cleared timer also bounds pipe draining, not just the direct child's exit. */
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ChildDeadline(`UPDTEST process deadline ${ms}ms exceeded`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

/** Only ESRCH means successful cleanup; report any other failure instead of hiding it. */
function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try { process.kill(-pid, signal); } catch (error) {
    // An already exited owned process group needs no further signal.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Bun test skips process exit hooks on a runner timeout; retain ownership of detached gh groups until close. */
export function trackChildProcesses(): void {
  const spawn = childProcess.spawn;
  const groups = new Set<{ pid: number; closed: Promise<void> }>();
  const watcher = spyOn(childProcess, "spawn").mockImplementation(((...args: unknown[]) => {
    const child = Reflect.apply(spawn, childProcess, args) as ReturnType<typeof spawn>;
    const options = (Array.isArray(args[1]) ? args[2] : args[1]) as { detached?: boolean } | undefined;
    if (child.pid && options?.detached) {
      let closed!: () => void;
      const owned = { pid: child.pid, closed: new Promise<void>((resolve) => { closed = resolve; }) };
      groups.add(owned);
      child.once("close", () => { groups.delete(owned); closed(); });
    }
    return child;
  }) as typeof spawn);
  afterAll(async () => {
    try {
      const owned = [...groups];
      for (const group of owned) signalGroup(group.pid, "SIGKILL");
      await deadline(Promise.all(owned.map((group) => group.closed)), CLEANUP_MS);
    } finally { watcher.mockRestore(); }
  }, CLEANUP_MS + 1_000);
}

/** TERM lets runBounded's exit hooks reap its detached gh groups before the final group KILL. */
async function reap(child: Bun.Subprocess, output: Promise<unknown>): Promise<void> {
  const drained = Promise.all([child.exited, output]);
  const graceMs = 1_000;
  try {
    signalGroup(child.pid, "SIGTERM");
    try { await deadline(drained, graceMs); } catch (error) {
      // Only the grace deadline triggers escalation; output and exit errors remain visible.
      if (!(error instanceof ChildDeadline)) throw error;
    }
  } finally { signalGroup(child.pid, "SIGKILL"); }
  await deadline(drained, CLEANUP_MS - graceMs);
}

/**
 * Parent waits for a bounded child run, then reaps its private process group and removes its root on every exit path.
 * parentState is a private contamination sentinel in the env -i launcher's outer environment.
 * waitMs can only shorten the deadline, for isolated timeout/descendant cleanup probes.
 */
export async function runChild(mode: Mode, hook: Hook | null = null, parentState?: string, waitMs = CHILD_PROCESS_MS): Promise<ChildRun> {
  if (!(waitMs > 0 && waitMs <= CHILD_PROCESS_MS)) throw new Error("invalid UPDTEST process budget");
  const start = Date.now();
  const root = mkdtempSync(join(tmpdir(), "updtest-child-"));
  let result: Omit<ChildRun, "rootRemoved"> | undefined;
  let pid: number | undefined, reaped = false;
  try {
    const dirs = Object.fromEntries(["home", "config", "state", "runtime", "tmp"].map((name) => [name, join(root, name)]));
    for (const dir of Object.values(dirs)) mkdirSync(dir);
    const env = testChildEnv({
      HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, GH_CONFIG_DIR: join(dirs.config, "gh"),
      CLAUDESTRA_STATE_DIR: dirs.state, CLAUDESTRA_RUNTIME_DIR: dirs.runtime, TMPDIR: dirs.tmp, TMP: dirs.tmp, TEMP: dirs.tmp,
      HTTPS_PROXY: REFUSED, HTTP_PROXY: REFUSED, ALL_PROXY: REFUSED, https_proxy: REFUSED, http_proxy: REFUSED, all_proxy: REFUSED,
      // gh telemetry forks a detached sender that can recreate HOME after the fixture exits.
      GH_TELEMETRY: "false", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", [MODE_ENV]: mode, ...(hook ? { [HOOK_ENV]: hook } : {}),
    });
    const child = Bun.spawn(["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), process.execPath, "--no-env-file", "test", ENTRY], {
      cwd: join(import.meta.dir, ".."), env: testChildEnv({ CLAUDESTRA_STATE_DIR: parentState }), stdout: "pipe", stderr: "pipe", detached: true,
    });
    pid = child.pid;
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    try {
      const [out, err, code] = await deadline(output, waitMs);
      const lines = out.split("\n").filter((l) => l.startsWith(REPORT));
      const info = lines.length === 1 ? JSON.parse(lines[0]!.slice(REPORT.length)) as ChildInfo : null;
      result = { mode, hook, root, code, out, err, info, fixtureLeft: info ? existsSync(info.fixtureDir) : false,
        ran: count(err, /\bRan (\d+) tests?\b/), pass: count(err, /^\s*(\d+) pass$/m), fail: count(err, /^\s*(\d+) fail$/m),
        expects: count(err, /^\s*(\d+) expect\(\) calls?$/m) };
    } finally {
      await reap(child, output);
      reaped = true;
    }
  } finally {
    const cleanupStart = performance.now();
    rmSync(root, { recursive: true, force: true });
    const timing = result?.info?.timing;
    console.log("UPDTEST-RUN", JSON.stringify({ mode, hook, root, pid, reaped, code: result?.code,
      ran: result?.ran, pass: result?.pass, fail: result?.fail, expects: result?.expects, fixtureLeft: result?.fixtureLeft,
      startupMs: timing ? timing.startedAt - start : null, ...timing, rootCleanupMs: performance.now() - cleanupStart,
      totalMs: Date.now() - start, rootRemoved: !existsSync(root) }));
  }
  return { ...result!, rootRemoved: !existsSync(root) };
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
