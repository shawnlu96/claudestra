/**
 * turnState（lib/turn-state.ts）的取数一侧：查 registry 拿窗口和运行时、抓屏、读事件态、读后台活动。
 * 押后闸 / flush / 抢占（bridge.ts）、Discord 抢占（window-ops 注入）、Autopilot（mission.ts）共用这一份，
 * 免得「忙不忙」又散回四套判据。
 */
import { readRegistryAgents } from "../lib/registry.js";
import { MASTER_SESSION, tmuxRawStrict, windowTarget } from "../lib/tmux-helper.js";
import { turnState, type TurnState } from "../lib/turn-state.js";
import { hasActiveBgActivities } from "./bg-activity-watcher.js";
import { getAgentStatus } from "./event-bus.js";

const norm = (agent: string) => agent.replace(/^agent-/, "");
/** 大总管的窗口：固定是 master 会话的 index 0（名字只是标签，见 tmux-helper MASTER_WINDOW_NAME） */
export const MASTER_WINDOW = `${MASTER_SESSION}:0`;

/** 事件态：名字两侧都可能带 agent- 前缀（master 另说），两种都查 */
function statusOf(agent: string) {
  return getAgentStatus(agent) ?? getAgentStatus(norm(agent)) ?? getAgentStatus(`agent-${norm(agent)}`);
}

/** 按已知窗口判：win 为 null（窗口不在 / 查不到）时只剩事件态可用 */
export async function probeTurnAt(win: string | null, runtime: string | undefined, agent: string): Promise<TurnState> {
  let pane: string | null = null;
  if (win) {
    try {
      pane = await tmuxRawStrict(["capture-pane", "-t", win, "-p"]); // Strict：出错要走 catch 记成未知，别拿空串去判
    } catch {
      pane = null; // 抓屏失败 = 画面未知，turnState 按 unknown 处理（押后闸放行、抢占不打断）
    }
  }
  return turnState({ pane, status: statusOf(agent), runtime, bgActive: hasActiveBgActivities(agent) });
}

/** 频道 → 窗口和运行时：master 固定是 master:0，其余从 registry 找；查不到窗口 = null */
export async function resolveTurnWindow(channelId: string, controlChannelId: string): Promise<{ win: string | null; runtime?: string }> {
  if (controlChannelId && channelId === controlChannelId) return { win: MASTER_WINDOW };
  // registry 读不到：当作查无窗口，只剩事件态可判，不让投递路径因此抛错
  const regs = await readRegistryAgents().catch((e) => (console.warn(`⚠️ 判忙读 registry 失败: ${(e as Error).message}`), []));
  const reg = regs.find((a) => a.channelId === channelId);
  return { win: reg ? windowTarget(reg.name) : null, runtime: reg?.runtime };
}

/** 按频道判（bridge 的投递路径） */
export async function probeTurn(channelId: string, agent: string, controlChannelId: string): Promise<TurnState> {
  const { win, runtime } = await resolveTurnWindow(channelId, controlChannelId);
  return probeTurnAt(win, runtime, agent);
}
