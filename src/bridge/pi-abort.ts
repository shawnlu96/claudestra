/**
 * Pi 的「停」：Pi 的 C-c 只清空输入框，真正的中止在 Claudestra 扩展里（src/pi/abort-control.ts）。bridge 经 ws 发 {type:"abort", id}，
 * 扩展回 {type:"abort_ack", id, result, voided}。voided = 停之前 steer 进去、还没执行就作废的消息（message_id）：
 * 这里逐条告诉发送方「没执行、要的话请重发」——人发的在这个 agent 的频道（Discord + 网页）里说一声，agent 发的回到它自己那里。
 * 扩展在注册帧里声明 abort:true 才发（老扩展收到会默默忽略）；gate 接线在 bridge/interrupt-gate.ts。
 */
import type { ServerWebSocket } from "bun";
import { emitEvent } from "./event-bus.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { turnCuts } from "./turn-cuts.js";
import type { TurnTrigger } from "../lib/turn-cuts.js";

type Socket = { send(data: string): void };
interface EchoDeps {
  deliver(env: Envelope): Promise<unknown>;
  /** Discord 通知要带的 owner id（bridge.ts primaryOwnerId） */
  ownerId(): string;
}

let socketOf: (channelId: string) => Socket | undefined = () => undefined;
let echo: EchoDeps | undefined;
/** bridge.ts 启动时接上：频道 → 当前连接，以及回显作废消息要用的投递 */
export function setExtensionSocket(fn: typeof socketOf, deps: EchoDeps): void {
  socketOf = fn;
  echo = deps;
}

const abortCapable = new Set<string>();
export function setAbortCapable(channelId: string, on: boolean): void {
  if (on) abortCapable.add(channelId);
  else abortCapable.delete(channelId);
}

/** 扩展的中止回执要等多久：它同步调 abort()，正常几毫秒就回；等不到就如实写「已请求、没回执」 */
const ABORT_ACK_MS = 1_500;
type AbortResult = "aborted" | "idle" | "no_ack";
const abortWaiters = new Map<string, { channelId: string; done: (r: AbortResult) => void }>();
const lastAbort = new Map<string, { result: AbortResult; inEditor: number }>();

export function onAbortAck(msg: { id?: unknown; result?: unknown; voided?: unknown; inEditor?: unknown }): void {
  const w = abortWaiters.get(String(msg.id));
  if (!w) return;
  abortWaiters.delete(String(msg.id));
  const ids = Array.isArray(msg.voided) ? msg.voided.filter((x): x is string => typeof x === "string") : [];
  // 先回显再放行：放行之后停字那条会 record() 一条 cut、清掉「这一回合送到了哪些」，就查不到发送方了
  if (ids.length) echoVoided(w.channelId, ids);
  lastAbort.set(w.channelId, { result: msg.result === "aborted" ? "aborted" : "idle", inEditor: Number(msg.inEditor) || 0 });
  w.done(msg.result === "aborted" ? "aborted" : "idle");
}

/** 这个频道最近一次请 Pi 扩展中止的结果（停字抬头照实写：真停了 / 已请求没回执；inEditor = 作废的消息里几条被 Pi 退回了输入框） */
export const lastAbortResult = (channelId: string): { result: AbortResult; inEditor: number } | undefined => lastAbort.get(channelId);

/** 请 Pi 扩展中止当前回合：真中止了 / 没回执 = ["abort"]，本来就空闲 = []；没连着、扩展太旧不会中止 = 抛错（调用方如实回报，不说「已打断」） */
export async function extensionAbort(channelId: string): Promise<readonly string[]> {
  const ws = socketOf(channelId);
  if (!ws) throw new Error("Pi 会话没连着 bridge，中止请求发不过去");
  if (!abortCapable.has(channelId)) throw new Error("这个 Pi 会话的 Claudestra 扩展太旧、不会中止（重启这个 agent 换上新扩展）");
  const id = `abort_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await new Promise<AbortResult>((resolve) => {
    abortWaiters.set(id, { channelId, done: resolve });
    setTimeout(() => abortWaiters.delete(id) && resolve("no_ack"), ABORT_ACK_MS);
    ws.send(JSON.stringify({ type: "abort", id }));
  });
  if (r === "no_ack") lastAbort.set(channelId, { result: r, inEditor: 0 });
  return r === "idle" ? [] : ["abort"];
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

/** 作废消息的回显文案（单测 tests/pi-abort-control.test.ts） */
export function voidedNotice(agent: string, trigs: readonly TurnTrigger[], toAgent: boolean): string {
  const list = trigs.map((t) => `${toAgent ? "" : `${t.fromName}：`}「${clip(t.excerpt)}」`).join("、");
  return toAgent
    ? `[⏹ bridge] 你发给 ${agent} 的${list}在它被叫停之前送到、还没执行，已作废，不会执行。还要的话请重发。`
    : `[⏹ bridge] ${agent} 被叫停之前送到、还没执行的消息已作废，不会执行：${list}。还要的话请重发。`;
}

function echoVoided(channelId: string, ids: readonly string[]): void {
  const found = ids.map((id) => turnCuts.deliveredMessage(channelId, id));
  const trigs = found.filter((t): t is TurnTrigger => !!t);
  if (!echo || !trigs.length) return;
  const agent = found.find((t) => t?.agent)?.agent ?? "这个 agent";
  const base = { from: { kind: "bridge" as const, label: "pi-abort" }, intent: "notification" as const };
  const meta = () => ({ messageId: newMessageId("voided"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId() });
  const humans = trigs.filter((t) => t.fromKind === "user" || t.fromKind === "api");
  if (humans.length) {
    const text = voidedNotice(agent, humans, false);
    void echo.deliver({ ...base, to: { kind: "user", userId: echo.ownerId(), channelId }, content: text, meta: meta() })
      .catch((e: Error) => console.error(`⚠️ 作废回显发到 Discord 失败（网页照样看得到）: ${e.message}`));
    emitEvent({ agent, chatId: channelId, type: "chat_message", data: { direction: "out", from: "bridge", text, notice: true } });
  }
  for (const t of trigs.filter((x) => x.fromKind === "local")) {
    const ws = socketOf(t.replyTo);
    if (!ws) continue; // 发送方 agent 不在线：没法告诉它，它的消息反正没执行
    const to = { kind: "local" as const, channelId: t.replyTo, agentName: t.fromName, ws: ws as ServerWebSocket<unknown> };
    void echo.deliver({ ...base, to, content: voidedNotice(agent, [t], true), meta: { ...meta(), waitForIdle: true } })
      .catch((e: Error) => console.error(`⚠️ 作废回显发给 ${t.fromName} 失败: ${e.message}`));
  }
  console.log(`⏹ ${agent}：停之前 steer 进去、还没执行的 ${trigs.length} 条已作废并告诉发送方`);
}
