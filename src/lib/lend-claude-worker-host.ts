/** Claude 的轻量宿主：保留原终端供 manager 就绪探测，独立看门狗与信号收尾负责终止子进程和清理配置。 */
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { receiveClaudeToken } from "./lend-claude-worker-auth.js";
import { archiveClaudeWorker } from "./lend-claude-worker-archive.js";
import { CLAUDE_LEND_ROOT } from "./lend-claude-worker-session.js";
import { type ClaudeWorkerPlan } from "./lend-claude-worker.js";
import { CLAUDE_LEND_TOKEN } from "./lend-claude-worker-capacity.js";
import { lendWatchdog, WATCHDOG_EVERY_MS } from "./lend-watchdog.js";
import { childPidsInPsOutput, killPidsEscalating } from "./tmux-helper.js";
import { redactSecrets } from "./usage-classify.js";

interface Child { pid: number; exited: Promise<number> }
interface HostIo {
  receive(path: string): Promise<string>;
  spawn(plan: ClaudeWorkerPlan, token: string): Child;
  stop(child: Child): Promise<void>;
  reason(): string | null;
  cleanup(): void | Promise<void>;
  log(text: string): void;
  intervalMs?: number;
}

/** 清理在 child 退出 / 停止之后；重复信号共享同一次 stop，失败也不遗留凭据目录。 */
export async function runClaudeWorker(plan: ClaudeWorkerPlan, io: HostIo): Promise<number> {
  let child: Child | undefined;
  let stopping: Promise<void> | undefined;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    if (child && !stopping) stopping = io.stop(child);
    return stopping;
  };
  const onSignal = () => { void stop(); };
  const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
  signals.forEach((s) => process.on(s, onSignal));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const before = io.reason();
    if (before) { io.log(`Claude worker 不起：${before}`); return 1; }
    const token = await io.receive(plan.authSocket);
    const after = io.reason();
    if (cancelled || after) { io.log(`Claude worker 不起：${after ?? "已收到停止信号"}`); return 1; }
    child = io.spawn(plan, token);
    timer = setInterval(() => {
      const why = io.reason();
      if (why && !cancelled) { io.log(`Claude worker 自停：${why}`); void stop(); }
    }, io.intervalMs ?? WATCHDOG_EVERY_MS);
    return await child.exited;
  } finally {
    if (timer) clearInterval(timer);
    try { await stop(); } finally {
      signals.forEach((s) => process.removeListener(s, onSignal));
      await io.cleanup();
    }
  }
}

/** 杀掉 Claude 的后代（MCP / Bash 等）再杀本体，避免只杀 CLI 留下外来 shell。 */
async function stopTree(child: Child): Promise<void> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const ps = await new Response(proc.stdout).text();
  const code = await proc.exited;
  const pids = new Set([child.pid]);
  if (code === 0) for (const pid of pids) for (const kid of childPidsInPsOutput(ps, pid)) pids.add(kid);
  const left = await killPidsEscalating([...pids].reverse(), 1500);
  if (left.length) throw new Error("Claude worker 子进程未确认退出");
}

/** 顶层失败转换为退出码，宿主不重试；记录脱敏原因供 owner 排查，清理成功才给成功提示。 */
export async function runClaudeWorkerHost(plan: ClaudeWorkerPlan, io: HostIo): Promise<number> {
  let token = "", cleaned = false;
  try {
    return await runClaudeWorker(plan, { ...io,
      receive: async (path) => { token = await io.receive(path); return token; },
      cleanup: async () => { await io.cleanup(); cleaned = true; },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safe = redactSecrets(token ? message.split(token).join("[redacted]") : message);
    // 子进程宿主以非零退出码报告失败，继续抛出只会重复日志；调用方按退出码处理。
    io.log(`Claude 出借启动或停止失败：${safe}；${cleaned ? "配置目录已清理" : "配置目录清理未确认，请检查隔离目录"}`);
    return 1;
  }
}

if (import.meta.main) {
  const file = process.argv[2];
  const plan = JSON.parse(readFileSync(file, "utf8")) as ClaudeWorkerPlan;
  if (!/^agent-lend-[\w-]+$/.test(plan.agent) || dirname(plan.dir) !== resolve(CLAUDE_LEND_ROOT, plan.agent)
    || resolve(file) !== resolve(plan.dir, "launch.json") || resolve(plan.cwd) !== process.cwd()) throw new Error("Claude 出借启动计划路径不匹配");
  unlinkSync(file);
  const log = (text: string) => console.error(`[lend] ${text}`);
  const reason = lendWatchdog(plan.agent, log);
  process.exitCode = await runClaudeWorkerHost(plan, { reason, log, receive: receiveClaudeToken, stop: stopTree,
    spawn: (p, token) => Bun.spawn(p.argv, { cwd: p.cwd, env: { ...p.env, [CLAUDE_LEND_TOKEN]: token }, stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
    cleanup: async () => {
      try { await archiveClaudeWorker(plan, log); } finally { rmSync(plan.dir, { recursive: true, force: true }); }
    } });
}
