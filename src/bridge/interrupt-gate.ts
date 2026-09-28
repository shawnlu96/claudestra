/**
 * lib/interrupt-gate.ts 的接线：bridge 里所有打断键都从这里发（deliverToLocal 与 Discord 入站的人类消息抢占、
 * 停止按钮、/interrupt、API 打断端点），共用一份按频道的串行队列和冷却。
 */
import { createInterruptGate } from "../lib/interrupt-gate.js";
import { recordMetric } from "../lib/metrics.js";
import { interruptWindow } from "../lib/runtimes/window-ops.js";
import { emitEvent } from "./event-bus.js";
import { probeTurnAt, resolveTurnWindow } from "./turn-probe.js";

const controlChannelId = () => process.env.CONTROL_CHANNEL_ID || "";

export const interruptGate = createInterruptGate({
  resolve: (ch) => resolveTurnWindow(ch, controlChannelId()),
  probe: probeTurnAt,
  interrupt: interruptWindow,
  onPreempted: (agent, channelId) => {
    recordMetric("agent_interrupt", { channelId, agent, meta: { trigger: "preempt" } });
    // 让前端给被掐的回合标「已打断」(与手动停止同一事件形状)
    emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
    console.log(`⚡ 抢占打断 ${agent}（人类补充消息优先处理）`);
  },
  sleep: (ms) => Bun.sleep(ms),
});
