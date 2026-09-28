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

/** 频道 → 当前连接（bridge.ts 启动时接上）：Pi 的中止经 ws 发给扩展 */
let socketOf: (channelId: string) => { send(data: string): void } | undefined = () => undefined;
export function setExtensionSocket(fn: typeof socketOf): void {
  socketOf = fn;
}

/** 注册帧里声明的能力：Codex 会打字投递、Pi 扩展会中止并回执（老扩展不声明：收到 abort 会默默忽略） */
const abortCapable = new Set<string>();
export function noteRuntimeCaps(channelId: string, msg: { typeIn?: unknown; abort?: unknown }): void {
  turnCuts.setCodexTypeIn(channelId, msg.typeIn === true);
  if (msg.abort === true) abortCapable.add(channelId);
  else abortCapable.delete(channelId);
}

/** 扩展的中止回执要等多久：它同步调 abort()，正常几毫秒就回；等不到就如实写「已请求、没回执」 */
const ABORT_ACK_MS = 1_500;
type AbortResult = "aborted" | "idle" | "no_ack";
const abortWaiters = new Map<string, (r: AbortResult) => void>();
const lastAbort = new Map<string, AbortResult>();
export function onAbortAck(msg: { id?: unknown; result?: unknown }): void {
  const done = abortWaiters.get(String(msg.id));
  abortWaiters.delete(String(msg.id));
  done?.(msg.result === "aborted" ? "aborted" : "idle");
}
/** 这个频道最近一次请 Pi 扩展中止的结果（停字抬头照实写：真停了 / 已请求没回执） */
export const lastAbortResult = (channelId: string): AbortResult | undefined => lastAbort.get(channelId);

/** 请 Pi 扩展中止当前回合：真中止了 / 没回执 = ["abort"]，本来就空闲 = []；没连着、扩展太旧不会中止 = 抛错（调用方如实回报，不说「已打断」） */
async function extensionAbort(channelId: string): Promise<readonly string[]> {
  const ws = socketOf(channelId);
  if (!ws) throw new Error("Pi 会话没连着 bridge，中止请求发不过去");
  if (!abortCapable.has(channelId)) throw new Error("这个 Pi 会话的 Claudestra 扩展太旧、不会中止（重启这个 agent 换上新扩展）");
  const id = `abort_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await new Promise<AbortResult>((resolve) => {
    abortWaiters.set(id, resolve);
    setTimeout(() => abortWaiters.delete(id) && resolve("no_ack"), ABORT_ACK_MS);
    ws.send(JSON.stringify({ type: "abort", id }));
  });
  lastAbort.set(channelId, r);
  return r === "idle" ? [] : ["abort"];
}

export const interruptGate = createInterruptGate({
  resolve: (ch) => resolveTurnWindow(ch, controlChannelId()),
  probe: probeTurnAt,
  interrupt: async (win, runtime, ch, kind) => {
    turnCuts.noteKeySent(ch, kind); // 先记：Codex 的打断回报 0.5 秒就到
    if (controlFor(runtime).abortVia === "extension") return extensionAbort(ch);
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
