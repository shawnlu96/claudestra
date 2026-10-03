/**
 * agent 在不在跑（三态），给「宿主没连上时能不能只写 registry、说下次启动生效」用：只有确定停了才 false。
 * windowHasChildProcess 把 ps 失败 / 输出为空当成「没有子进程」，dead 判据另有 pane 双采样兜着，这里没有，不能用它。
 * 窗口清单查不到（tmux 出错）、list-panes / ps 非零退出或输出不完整一律 null。tests/agent-liveness.test.ts
 */
import { agentWindowsOrNull } from "./agent-windows.js";
import { hasChildInPsOutput, tmuxRawStrict, windowTarget } from "./tmux-helper.js";

/** 窗口里有没有进程：true / false 只在 tmux 与 ps 都正常退出、输出完整时给，其余 null */
async function windowChildProbe(target: string): Promise<boolean | null> {
  let pidRaw: string;
  try {
    pidRaw = await tmuxRawStrict(["list-panes", "-t", target, "-F", "#{pane_pid}"]);
  } catch (e) {
    console.warn(`[liveness] list-panes ${target} 失败，按不确定处理：${(e as Error).message}`);
    return null;
  }
  const pid = parseInt(pidRaw.split("\n")[0] || "", 10);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const proc = Bun.spawn(["ps", "-eo", "ppid="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0 || !out.trim()) return null; // ps 至少列出它自己：空输出 = 结果不完整
  return hasChildInPsOutput(out, pid);
}

/** true = 在跑；false = 确定没在跑（没有窗口，或窗口里宿主已退出、launcher 会按 registry 重起）；null = 查不清 */
export async function agentLiveness(agent: string): Promise<boolean | null> {
  const windows = await agentWindowsOrNull();
  if (windows === null) return null;
  if (!windows.some((w) => w.name === agent)) return false;
  return windowChildProbe(windowTarget(agent));
}
