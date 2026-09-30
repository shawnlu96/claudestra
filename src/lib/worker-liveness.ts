/**
 * 出借 worker（ACP 宿主）还在不在跑：读不到一律 unknown，绝不当成「不在」。
 * tmuxRaw 吞退出码、ps 失败时输出为空，都会把一次读失败变成否定答案；lend 循环曾因此把正在审查的 worker 判死
 * （i28-R5a，~/.claude-orchestrator/ledger/reviews/i28-R5a-rootcause.md）。所以这里 tmux 走 tmuxRawStrict、ps 核退出码。
 * 存活以宿主进程为准：pane 进程本身或它的直接子进程命令行里有 src/acp-host.ts 才算在跑；窗口在、壳里没有宿主 = no_host。
 * tests/worker-liveness.test.ts。
 */
import { MASTER_SESSION, tmuxRawStrict, windowTarget } from "./tmux-helper.js";

export type WorkerLiveness = "running" | "unknown" | "no_window" | "no_host";

/** 三次读；任何一次抛错 = 这一轮不知道 */
export interface LivenessIo {
  windows(): Promise<string[]>;
  panePid(name: string): Promise<number>;
  /** `ps -ww -eo pid=,ppid=,command=` 的输出 */
  ps(): Promise<string>;
}

const HOST_SCRIPT = "/src/acp-host.ts";

/** 同一份 ps 快照里判 pane 下有没有宿主；pane 进程不在快照里（窗口正在关、快照不一致）= unknown */
export function acpHostVerdict(panePid: number, psOut: string): "running" | "no_host" | "unknown" {
  let paneSeen = false;
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    if (pid === panePid) paneSeen = true;
    if ((pid === panePid || ppid === panePid) && m[3].includes(HOST_SCRIPT)) return "running";
  }
  return paneSeen ? "no_host" : "unknown";
}

export async function probeAcpWorker(name: string, io: LivenessIo = defaultIo): Promise<WorkerLiveness> {
  let names: string[];
  try { names = await io.windows(); } catch { return "unknown"; /* tmux 读失败：不知道，调用方不判死 */ }
  if (!names.includes(name)) return "no_window";
  try {
    return acpHostVerdict(await io.panePid(name), await io.ps());
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
  panePid: async (name) => {
    const pid = parseInt((await tmuxRawStrict(["list-panes", "-t", windowTarget(name), "-F", "#{pane_pid}"])).split("\n")[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error(`${name} 的 pane pid 读不出来`);
    return pid;
  },
  ps: psSnapshot,
};
