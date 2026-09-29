/**
 * lib/interrupt-gate.ts 的接线：bridge 里所有打断键都从这里发（deliverToLocal 与 Discord 入站的人类消息抢占、
 * 停止按钮、/interrupt、API 打断端点），共用一份按频道的串行队列和冷却。
 */
import { createInterruptGate } from "../lib/interrupt-gate.js";
import { recordMetric } from "../lib/metrics.js";
import { controlFor } from "../lib/runtimes/index.js";
import { interruptWindow } from "../lib/runtimes/window-ops.js";
import { windowWallWait } from "../lib/wall-screen.js";
import { emitEvent } from "./event-bus.js";
import { extensionAbort, setAbortCapable } from "./pi-abort.js";
import { isAcpChannel, noteAcpChannel } from "./acp-state.js";
export { onAbortAck, onCodexUndelivered, setExtensionSocket, stopAfterAbort, stopWaitIds } from "./pi-abort.js"; // bridge.ts 只从这里接打断相关的线
export { HTTP_IDLE_TIMEOUT_S } from "../lib/esc-guard.js";
import { probeTurnAt, resolveTurnWindow } from "./turn-probe.js";
import { turnCuts } from "./turn-cuts.js";

const controlChannelId = () => process.env.CONTROL_CHANNEL_ID || "";

/** 注册帧里声明的能力：Codex 会打字投递（老 channel-server 不声明：打断后消息会卡在 queue）、Pi 扩展会中止并回执（老扩展收到 abort 默默忽略） */
export function noteRuntimeCaps(channelId: string, msg: { typeIn?: unknown; abort?: unknown; transport?: unknown }): void {
  turnCuts.setCodexTypeIn(channelId, msg.typeIn === true);
  setAbortCapable(channelId, msg.abort === true);
  noteAcpChannel(channelId, msg.transport); // ACP 宿主（src/acp-host.ts）：打断走 abort 帧 → session/cancel，不发键
}

export const interruptGate = createInterruptGate({
  resolve: (ch) => resolveTurnWindow(ch, controlChannelId()),
  probe: probeTurnAt,
  wallWait: async (win) => !!(await windowWallWait(win)), // 抓不到屏：交给 probe 按老规矩判（它也抓不到就是 unknown，不发键）
  interrupt: async (win, runtime, ch, kind, wanted) => {
    const undo = turnCuts.noteKeySent(ch, kind); // 先记：Codex 的打断回报 0.5 秒就到
    const send = () => (controlFor(runtime, isAcpChannel(ch) ? "acp" : "tmux").abortVia === "extension" ? extensionAbort(ch, wanted) : interruptWindow(win, runtime, wanted));
    // 撤回（一个键都没发）要还原：不然几秒内真人在终端按的打断会被认成 bridge 发的键，owner 的「停」记不下
    return send().catch((e: Error) => { if (e.name === "KeyWithdrawnError") undo(); throw e; });
  },
  allow: (ch, runtime, stop) => turnCuts.mayBridgeInterrupt(ch, runtime, stop),
  onPreempted: (agent, channelId) => {
    recordMetric("agent_interrupt", { channelId, agent, meta: { trigger: "preempt" } });
    // 保持 interrupt 触发语义供旧客户端识别，cause 让新客户端说清这是新消息自动抢占。
    emitEvent({ agent, chatId: channelId, type: "agent_status", data: { status: "done", trigger: "interrupt", cause: "preempt" } });
    console.log(`⚡ 抢占打断 ${agent}（人类补充消息优先处理）`);
  },
  sleep: (ms) => Bun.sleep(ms),
});
