/**
 * 出借 worker（ACP 宿主）还在不在跑：读不到一律 unknown，绝不当成「不在」。
 * tmuxRaw 吞退出码、ps 失败时输出为空，都会把一次读失败变成否定答案；lend 循环曾因此把正在审查的 worker 判死
 * （i28-R5a，~/.claude-orchestrator/ledger/reviews/i28-R5a-rootcause.md）。所以这里 tmux 走 tmuxRawStrict、ps 核退出码。
 * 存活以宿主进程为准：窗口里任一 pane 的进程树（pane 进程本身及所有后代）里有命令行带 src/acp-host.ts 的进程才算在跑；
 * 只看第一个 pane / 直接子进程时，分屏或包一层 wrapper 就会把活宿主当成 no_host 杀掉（i28-R5a r1 P1-1）。窗口在、树里没有宿主 = no_host。
 * tests/lend-health.test.ts。
 */
import { CLAUDE_LEND_HOST } from "./lend-claude-worker.js";
import { MASTER_SESSION, tmuxRawStrict, windowTarget } from "./tmux-helper.js";

export type WorkerLiveness = "running" | "unknown" | "no_window" | "no_host";

/** 三次读；任何一次抛错 = 这一轮不知道 */
export interface LivenessIo {
  windows(): Promise<string[]>;
  /** 窗口里所有 pane 的 pane_pid */
  panePids(name: string): Promise<number[]>;
  /** `ps -ww -eo pid=,ppid=,command=` 的输出 */
  ps(): Promise<string>;
}

const HOST_SCRIPT = "/src/acp-host.ts";

/** 同一份 ps 快照里判这些 pane 的进程树里有没有宿主；没找到宿主时，有 pane 进程不在快照里（pane 正在关、两次读之间变了）= unknown */
export function acpHostVerdict(panePids: number[], psOut: string): "running" | "no_host" | "unknown" {
  const kids = new Map<number, number[]>();
  const cmd = new Map<number, string>();
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    cmd.set(pid, m[3]);
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const roots = panePids.filter((p) => cmd.has(p));
  const seen = new Set<number>();
  for (const queue = [...roots]; queue.length; ) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    if ([HOST_SCRIPT, CLAUDE_LEND_HOST].some((script) => cmd.get(pid)?.includes(script))) return "running";
    queue.push(...(kids.get(pid) ?? []));
  }
  return roots.length && roots.length === panePids.length ? "no_host" : "unknown";
}

export async function probeAcpWorker(name: string, io: LivenessIo = defaultIo): Promise<WorkerLiveness> {
  let names: string[];
  try { names = await io.windows(); } catch { return "unknown"; /* tmux 读失败：不知道，调用方不判死 */ }
  if (!names.includes(name)) return "no_window";
  try {
    return acpHostVerdict(await io.panePids(name), await io.ps());
  } catch {
    return "unknown"; // pane / ps 读不到：同上
  }
}

async function psSnapshot(): Promise<string> {
  const proc = Bun.spawn(["ps", "-ww", "-eo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 || !out.trim()) throw new Error(`ps 失败（exit ${code}）`);
  return out;
}

export const defaultIo: LivenessIo = {
  windows: async () => (await tmuxRawStrict(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}"])).split("\n"),
  panePids: async (name) => {
    const pids = (await tmuxRawStrict(["list-panes", "-t", windowTarget(name), "-F", "#{pane_pid}"])).split("\n").filter((l) => l.trim()).map((l) => Number(l));
    if (!pids.length || pids.some((p) => !Number.isInteger(p) || p <= 0)) throw new Error(`${name} 的 pane pid 读不出来`);
    return pids;
  },
  ps: psSnapshot,
};
