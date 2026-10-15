/**
 * 执行器的生产依赖:子进程命令、launchd、tmux 会话、档位、基线、指针子进程、独立进程拉起。
 * 拉起一律 detached(新会话 / 进程组)、stdio 断开、cwd 在维护根:脱离 bridge、tmux、会话进程组与请求超时链,
 * 停 bridge 或 manager 超时都杀不到它。本模块与执行器都不 import 台账 / 身份模块;台账只在 note 子进程里动态加载。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renameStateMode } from "../config-store.js";
import { nodeStateFs } from "../floka-migration/state/fs-adapter.js";
import { REPO_ROOT } from "../repo-root.js";
import { isTestProcess } from "../test-guard.js";
import { tmuxRaw, tmuxRawStrict } from "../tmux-helper.js";
import type { MaintContext } from "./context.js";
import type { ExecDeps } from "./executor.js";
import type { Run, RunResult } from "./probe.js";
import { SERVICE_LABELS, type SessionOps, type SessionSnapshot } from "./services.js";

const RUNNER_PATH = join(REPO_ROOT, "src", "state-maintenance-runner.ts");

const runCmd: Run = async (cmd, timeoutMs = 30_000): Promise<RunResult> => {
  let proc;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    return { code: null, stdout: "", stderr: "", spawnError: (e as NodeJS.ErrnoException).code ?? (e as Error).message };
  }
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  return { code: proc.signalCode ? null : code, stdout, stderr };
};

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** tmux 没有服务器 = 没有会话(不是读失败) */
const NO_SERVER = /no server running|error connecting|no such file/i;

async function listPanes(): Promise<{ windows: string[]; panePids: number[] } | { error: string }> {
  try {
    const out = await tmuxRawStrict(["list-panes", "-a", "-F", "#{session_name}:#{window_name}\t#{pane_pid}"]);
    const rows = out.split("\n").filter(Boolean).map((l) => l.split("\t"));
    return { windows: [...new Set(rows.map((r) => r[0]!))], panePids: rows.map((r) => Number(r[1])).filter((n) => n > 0) };
  } catch (e) {
    return NO_SERVER.test((e as Error).message) ? { windows: [], panePids: [] } : { error: (e as Error).message };
  }
}

/** pane 进程及其全部后代(channel-server、后台作业都在里面) */
async function withDescendants(roots: number[]): Promise<number[] | { error: string }> {
  const r = await runCmd(["ps", "-axo", "pid=,ppid="], 15_000);
  if (r.code !== 0) return { error: `ps 退出码 ${r.code}` };
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of r.stdout.split("\n").map((l) => l.trim().split(/\s+/).map(Number))) {
    if (pid && ppid !== undefined) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out = new Set<number>();
  const walk = (p: number) => { if (out.has(p)) return; out.add(p); for (const k of kids.get(p) ?? []) walk(k); };
  roots.forEach(walk);
  return [...out];
}

const tmuxSessions: SessionOps = {
  snapshot: async (): Promise<SessionSnapshot | { error: string }> => {
    const panes = await listPanes();
    if ("error" in panes) return panes;
    const pids = await withDescendants(panes.panePids);
    return "error" in pids ? pids : { windows: panes.windows, pids };
  },
  stop: async () => void (await tmuxRaw(["kill-server"])),
  windows: async () => {
    const panes = await listPanes();
    return "error" in panes ? [] : panes.windows;
  },
};

/** 拉起独立的 runner 子命令(serve / exec / recover) */
export function spawnRunner(cwd: string, args: string[]): void {
  const child = spawn(process.execPath, [RUNNER_PATH, ...args], { detached: true, stdio: "ignore", cwd, env: process.env });
  child.unref();
}

/** 跑一个短命 runner 子命令并取回它的 JSON 结果(指针子进程:打开即关台账) */
async function runnerJson(args: string[], input: unknown): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn([process.execPath, RUNNER_PATH, ...args], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), 60_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  try {
    return JSON.parse(out) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: `指针子进程退出码 ${code}:${err.trim().split("\n").pop() ?? ""}` }; // 没有 JSON 就把退出原因带回去
  }
}

export const packageVersion = (): string => String((JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "?");

export async function gitHead(): Promise<string> {
  const r = await runCmd(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], 15_000);
  return r.code === 0 ? r.stdout.trim() : `unknown:${r.code}`;
}

/** 测试进程(子进程继承测试标记)永远碰不到真实 launchd 与 tmux:用例只能走到「拒绝」,不会停掉本机服务 */
const testRefusal = (what: string): RunResult => ({ code: null, stdout: "", stderr: "", spawnError: `测试进程不碰真实 ${what}` });

export function realExecDeps(c: MaintContext): ExecDeps {
  const uid = process.getuid?.() ?? -1;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const test = isTestProcess();
  const run: Run = test ? async (cmd) => (cmd[0] === "launchctl" ? testRefusal("launchd") : runCmd(cmd)) : runCmd;
  const sessions: SessionOps = test ? { ...tmuxSessions, snapshot: async () => ({ error: "测试进程不碰真实 tmux" }), stop: async () => {} } : tmuxSessions;
  return {
    ...c, fs: nodeStateFs, version: packageVersion(), now: () => Date.now(), probeGapMs: 2_000, restoreWaitMs: 180_000,
    probe: { run, selfPid: process.pid, uid, labels: SERVICE_LABELS, sleep },
    services: { run, uid, home: c.home, sessions, pidAlive, sleep, drainMs: 60_000 },
    readMode: () => renameStateMode(),
    baseline: gitHead,
    writeNote: (n) => runnerJson(["note", c.maintRoot], { ...n, version: packageVersion(), mode: "on" }),
    flushNotes: () => runnerJson(["note-flush", c.maintRoot], {}),
  };
}
