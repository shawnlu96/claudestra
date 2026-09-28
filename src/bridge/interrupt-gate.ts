/**
 * lib/interrupt-gate.ts 的接线：bridge 里所有打断键都从这里发（deliverToLocal 与 Discord 入站的人类消息抢占、
 * 停止按钮、/interrupt、API 打断端点），共用一份按频道的串行队列和冷却。
 */
import { createInterruptGate } from "../lib/interrupt-gate.js";
import { recordMetric } from "../lib/metrics.js";
import { readRegistryAgents } from "../lib/registry.js";
import { interruptWindow } from "../lib/runtimes/window-ops.js";
import { MASTER_SESSION, windowTarget } from "../lib/tmux-helper.js";
import { windowWallWait } from "../lib/wall-screen.js";
import { emitEvent } from "./event-bus.js";
import { probeTurnAt, resolveTurnWindow } from "./turn-probe.js";

const controlChannelId = () => process.env.CONTROL_CHANNEL_ID || "";

export const interruptGate = createInterruptGate({
  resolve: (ch) => resolveTurnWindow(ch, controlChannelId()),
  probe: probeTurnAt,
  wallWait: async (win) => !!(await windowWallWait(win)), // 抓不到屏：交给 probe 按老规矩判（它也抓不到就是 unknown，不发键）
  interrupt: interruptWindow,
  onPreempted: (agent, channelId) => {
    recordMetric("agent_interrupt", { channelId, agent, meta: { trigger: "preempt" } });
    // 让前端给被掐的回合标「已打断」(与手动停止同一事件形状)
    emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
    console.log(`⚡ 抢占打断 ${agent}（人类补充消息优先处理）`);
  },
  sleep: (ms) => Bun.sleep(ms),
});

/** 按 agent 名手动打断（API 端点）：大总管（"master" / "0"）不在 registry 的普通条目里，按 Claude Code 的 master:0 处理 */
export async function interruptAgentByName(name: string, channelId: string): Promise<{ keys: readonly string[]; deduped?: true }> {
  const isMaster = name === "master" || name === "0";
  const regs = isMaster ? [] : await readRegistryAgents().catch(() => []); // 读不到就当 CC 发 C-c：人要停，宁可发
  const runtime = regs.find((a) => a.name === name)?.runtime;
  return interruptGate.manual(channelId, isMaster ? `${MASTER_SESSION}:0` : windowTarget(name), runtime);
}
