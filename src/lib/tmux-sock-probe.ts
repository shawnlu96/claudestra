/**
 * master 会话三态探测 + 同路径 tmux 服务进程查找 + USR1 自愈判定（SOCKGUARD1）。
 *
 * 为什么不能把「查询失败」当「不存在」：tmux 客户端连接得到 ECONNREFUSED / ENOENT 时，能自启服务的命令（new-session）
 * 会拿锁、unlink 旧套接字、另起服务（tmux 3.7b client.c:128 判 errno、:159 unlink）。launcher 一次查询被拒就 new-session，
 * 老服务（窗口都在）的套接字被删，换上一个空服务，后面的批量复活和「全员空闲」全部建立在空服务上。
 * 所以 absent 只认三种确定情况（套接字不在且无同路径服务；连上了但没有 master；残留套接字：被拒、无同路径服务、lsof 无持有者），
 * 其余一律 unknown，交给调用方不动手。残留套接字不由 launcher 删，new-session 自己会 unlink。tests/tmux-sock-probe.test.ts。
 */
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { MASTER_SESSION, TMUX_SOCK, tmuxRawStrict } from "./tmux-helper.js";
import { TmuxCommandError } from "./tmux-failure.js";

export type SockProbeState = "exists" | "absent" | "unknown";
export interface TmuxServerProc { pid: number; ppid: number; command: string }

export interface SockProbe {
  state: SockProbeState;
  /** 一句话原因，进日志 */
  why: string;
  /** list-sessions 的退出码；null = 超时被杀或没跑（套接字不在就不跑） */
  code: number | null;
  /** stderr 前 200 字 */
  stderr: string;
  ms: number;
  sock: "present" | "missing" | "error";
  inode: number | null;
  /** 连接被拒或连接时套接字已不在：USR1 自愈的前提之一 */
  refused: boolean;
  /** 同路径 tmux 服务进程（PPID=1）；null = 没查或 ps 失败。只在非 exists 时查 */
  servers: TmuxServerProc[] | null;
  /** 残留套接字：文件在、ECONNREFUSED、无同路径服务、lsof 无持有者（服务被 SIGKILL 留下的） */
  stale: boolean;
}

export interface SockProbePorts {
  sockPath: string;
  /** 不存在时抛 code=ENOENT 的错误（同 fs.statSync） */
  stat: (path: string) => { ino: number };
  listSessions: () => Promise<{ code: number | null; out: string; err: string }>;
  /** `ps -ww -axo pid=,ppid=,command=` 的原文；失败就抛 */
  ps: () => Promise<string>;
  /** `lsof -t -- <path>`：exit 1 且两路输出全空 = 没有持有者；别的非 0 / 超时（code null）= 查不了 */
  lsof: (path: string) => Promise<{ code: number | null; out: string; err: string }>;
  realpath: (path: string) => string;
  now: () => number;
}

const PROBE_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 10_000;

/** 目录走 realpath（macOS 的 /tmp → /private/tmp），文件名原样：套接字本身可能已经不在 */
export function normSockPath(path: string, realpath: (p: string) => string = realpathSync): string {
  try { return join(realpath(dirname(path)), basename(path)); } catch { return path; /* 目录都读不了：按原串比，最坏是认不出同路径进程，调用方得到的仍是 unknown 而不是误判 */ }
}

/** 命令行里 `-S <path>` / `-S<path>` 的路径；argv[0] 不是 tmux 的不算（别把参数里提到 tmux 的进程认成服务） */
export function sockArgOf(command: string): string | null {
  const argv = command.trim().split(/\s+/);
  if (basename(argv[0] ?? "") !== "tmux") return null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "-S") return argv[i + 1] ?? null;
    if (argv[i].startsWith("-S") && argv[i].length > 2) return argv[i].slice(2);
  }
  return null;
}

/** 进程表里命令行带同一个 `-S` 路径、PPID=1 的 tmux 服务进程（服务 fork 后父进程是 1；客户端的父进程是调用它的 shell / daemon） */
export function sameSockServers(psOut: string, sockPath: string, realpath: (p: string) => string = realpathSync): TmuxServerProc[] {
  const want = normSockPath(sockPath, realpath);
  const out: TmuxServerProc[] = [];
  for (const line of psOut.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const proc = { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] };
    const arg = sockArgOf(proc.command);
    if (proc.ppid === 1 && arg && normSockPath(arg, realpath) === want) out.push(proc);
  }
  return out;
}

/** tmux 失败的分类：被拒（no server running）/ 连接时套接字不在 = refused；超时、权限等 = 其他 */
export function tmuxFailureRefused(err: string): boolean {
  return /no server running on /.test(err) || /error connecting to .*\(No such file or directory\)/.test(err);
}

export async function masterSessionProbe(ports: SockProbePorts = LIVE_PROBE_PORTS): Promise<SockProbe> {
  const t0 = ports.now();
  const done = (p: Omit<SockProbe, "ms" | "stale">, stale = false): SockProbe => ({ ...p, stale, ms: ports.now() - t0 });
  const servers = async (): Promise<TmuxServerProc[] | null> => {
    try { return sameSockServers(await ports.ps(), ports.sockPath, ports.realpath); } catch { return null; /* ps 失败：调用方把 null 当「不知道」，不会判 absent */ }
  };
  let inode: number | null = null;
  try {
    inode = ports.stat(ports.sockPath).ino;
  } catch (e) {
    const base = { code: null, stderr: "", inode: null, refused: true } as const;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return done({ ...base, state: "unknown", why: `套接字 stat 失败：${(e as Error).message}`.slice(0, 200), sock: "error", refused: false, servers: null });
    }
    const s = await servers();
    if (s === null) return done({ ...base, state: "unknown", why: "套接字不存在，进程表读不了", sock: "missing", servers: null });
    if (s.length) return done({ ...base, state: "unknown", why: `套接字不存在，但同路径服务进程还在（pid ${s.map((p) => p.pid).join(",")}）`, sock: "missing", servers: s });
    return done({ ...base, state: "absent", why: "套接字不存在且没有同路径服务进程", sock: "missing", servers: s });
  }
  const r = await ports.listSessions();
  const stderr = r.err.slice(0, 200);
  if (r.code === 0) {
    const has = r.out.split("\n").includes(MASTER_SESSION);
    return done({ state: has ? "exists" : "absent", why: has ? "master 在" : "连上了服务，没有 master", code: 0, stderr, sock: "present", inode, refused: false,
      servers: has ? null : await servers() });
  }
  const refused = r.code !== null && r.code < 128 && tmuxFailureRefused(r.err);
  const why = r.code === null || r.code >= 128 ? "查询超时" : refused ? "连接被拒" : "查询失败";
  const s = await servers();
  const base = { code: r.code, stderr, sock: "present", inode, refused, servers: s } as const;
  if (!refused || !/no server running on /.test(r.err) || s === null || s.length) return done({ ...base, state: "unknown", why });
  const holders = await sockHolders(ports);
  if (holders === null) return done({ ...base, state: "unknown", why: "连接被拒、无同路径服务进程，lsof 查不了持有者" });
  if (holders.length) return done({ ...base, state: "unknown", why: `连接被拒、无同路径服务进程，但套接字有持有者（pid ${holders.join(",")}）` });
  return done({ ...base, state: "absent", why: "残留套接字：无服务进程、无持有者" }, true);
}

/** 打开着这个套接字路径的进程 pid；null = lsof 不可用 / 报错 / 超时（调用方一律当 unknown） */
async function sockHolders(ports: SockProbePorts): Promise<number[] | null> {
  let r: { code: number | null; out: string; err: string };
  try { r = await ports.lsof(normSockPath(ports.sockPath, ports.realpath)); } catch { return null; /* 起不了 lsof：按查不了算，调用方不新建 */ }
  if (r.code === 1 && !r.out.trim() && !r.err.trim()) return [];
  if (r.code !== 0) return null;
  const pids = r.out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return pids.length ? pids : null;
}

async function liveListSessions(): Promise<{ code: number | null; out: string; err: string }> {
  try {
    return { code: 0, out: await tmuxRawStrict(["list-sessions", "-F", "#{session_name}"], { timeoutMs: PROBE_TIMEOUT_MS }), err: "" };
  } catch (e) {
    if (e instanceof TmuxCommandError) return { code: e.code, out: "", err: e.stderr };
    return { code: null, out: "", err: (e as Error).message }; // 起不了 tmux 子进程等：按超时一类算 unknown
  }
}

async function liveLsof(path: string): Promise<{ code: number | null; out: string; err: string }> {
  const proc = Bun.spawn(["lsof", "-t", "--", path], { stdout: "pipe", stderr: "pipe", timeout: LSOF_TIMEOUT_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.signalCode ? null : code, out, err };
}

async function livePs(): Promise<string> {
  const proc = Bun.spawn(["ps", "-ww", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !out.trim()) throw new Error(`ps 失败（exit ${code}）`);
  return out;
}

export const LIVE_PROBE_PORTS: SockProbePorts = {
  sockPath: TMUX_SOCK,
  stat: (p) => statSync(p),
  listSessions: liveListSessions,
  ps: livePs,
  lsof: liveLsof,
  realpath: realpathSync,
  now: () => Date.now(),
};

export type SockHealMode = "off" | "observe" | "on";
export type SockHealPlan =
  | { kind: "none" }
  | { kind: "signal"; pid: number }
  | { kind: "observe"; pid: number }
  | { kind: "alert"; why: string };

/**
 * 老服务还活着、套接字丢了（不存在或被拒）时怎么办。只对「恰好一个、PPID=1、命令行带同一 -S」的服务进程发 USR1
 * （tmux 3.7b server.c:445 收到 USR1 重建套接字）；两个以上任何档都不动；三档都不新建（新建由调用方另外拦）。
 */
export function planSockHeal(p: SockProbe, mode: SockHealMode): SockHealPlan {
  if (p.state !== "unknown" || !(p.sock === "missing" || p.refused) || p.servers === null) return { kind: "none" };
  if (p.servers.length === 0) return { kind: "alert", why: `套接字连不上，进程表里没有同路径服务进程，但${p.why}；不新建，下一轮再查` };
  if (p.servers.length > 1) return { kind: "alert", why: `同路径服务进程有 ${p.servers.length} 个（pid ${p.servers.map((s) => s.pid).join(",")}），不发信号，等人处理` };
  const pid = p.servers[0].pid;
  if (mode === "on") return { kind: "signal", pid };
  if (mode === "observe") return { kind: "observe", pid };
  return { kind: "alert", why: `套接字丢了，老服务 pid ${pid} 还在；tmuxSockHeal=off，不发信号，等人处理（kill -USR1 ${pid} 可让它重建套接字）` };
}
