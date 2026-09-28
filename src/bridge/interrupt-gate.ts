/**
 * lib/interrupt-gate.ts 的接线：bridge 里所有打断键都从这里发（deliverToLocal 与 Discord 入站的人类消息抢占、
 * 停止按钮、/interrupt、API 打断端点），共用一份按频道的串行队列和冷却。
 */
import { createInterruptGate } from "../lib/interrupt-gate.js";
import { recordMetric } from "../lib/metrics.js";
import { controlFor } from "../lib/runtimes/index.js";
import { interruptWindow } from "../lib/runtimes/window-ops.js";
import { emitEvent } from "./event-bus.js";
import { probeTurnAt, resolveTurnWindow } from "./turn-probe.js";
import { turnCuts } from "./turn-cuts.js";

const controlChannelId = () => process.env.CONTROL_CHANNEL_ID || "";

/** 请运行时扩展中止当前回合（Pi）：bridge.ts 启动时接上（发 ws {type:"abort"}），返回是否发出去了 */
let extensionAbort: (channelId: string) => boolean = () => false;
export function setExtensionAbort(fn: (channelId: string) => boolean): void {
  extensionAbort = fn;
}

export const interruptGate = createInterruptGate({
  resolve: (ch) => resolveTurnWindow(ch, controlChannelId()),
  probe: probeTurnAt,
  interrupt: async (win, runtime, ch, kind) => {
    turnCuts.noteKeySent(ch, kind); // 先记：Codex 的打断回报 0.5 秒就到
    if (controlFor(runtime).abortVia === "extension") return extensionAbort(ch) ? ["abort"] : [];
    return interruptWindow(win, runtime);
  },
  allow: (ch, runtime, stop) => turnCuts.mayBridgeInterrupt(ch, runtime, stop),
  onPreempted: (agent, channelId) => {
    recordMetric("agent_interrupt", { channelId, agent, meta: { trigger: "preempt" } });
    // 让前端给被掐的回合标「已打断」(与手动停止同一事件形状)
    emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt" } });
    console.log(`⚡ 抢占打断 ${agent}（人类补充消息优先处理）`);
  },
  sleep: (ms) => Bun.sleep(ms),
});
