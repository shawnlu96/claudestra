/**
 * 「列不出来」与「一个都没有」分开的 agent 窗口清单。listAgentWindows 在 tmux 出错时静默返回 []，
 * 对「要不要删频道 / 关窗口」这种判断是反的：窗口其实在，却被当成不在（tests/resumable-ops.test.ts）。
 */
import { AGENT_PREFIX, MASTER_SESSION, tmuxRawStrict } from "./tmux-helper.js";

/** tmux 没起 / master session 不存在 = 确实没有窗口；其余失败 = 不知道 */
const NO_WINDOWS_RE = /no server running|can't find session|error connecting to|no such file or directory/i;

/** master session 里的 agent-* 窗口 [{name, id}]；null = 查不到（调用方按「不确定」处理，不删不关） */
export async function agentWindowsOrNull(): Promise<Array<{ name: string; id: string }> | null> {
  let out: string;
  try {
    out = await tmuxRawStrict(["list-windows", "-t", MASTER_SESSION, "-F", "#{window_name}\t#{window_id}"]);
  } catch (e) {
    return NO_WINDOWS_RE.test((e as Error).message) ? [] : null;
  }
  return out.split("\n").map((l) => l.trim().split("\t")).filter(([n, id]) => n?.startsWith(AGENT_PREFIX) && id).map(([name, id]) => ({ name: name!, id: id! }));
}
