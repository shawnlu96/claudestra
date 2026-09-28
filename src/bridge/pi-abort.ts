/**
 * Pi 的「停」：Pi 的 C-c 只清空输入框，真正的中止在 Claudestra 扩展里（src/pi/abort-control.ts）。bridge 经 ws 发 {type:"abort", id}，
 * 扩展回 {type:"abort_ack", id, result, voided}。voided = 停之前 steer 进去、还没执行就作废的消息（message_id）：
 * 这里逐条告诉发送方「没执行、要的话请重发」——各回到它自己的回信地址（Discord 人回他发消息的频道、API / 网页 / peer 回它的 api 地址、
 * agent 回它自己），和 agent 回复它们走同一条路（镜像开关、peer 的等待都照旧）；同时从补答账、回程槽和看门狗上销掉，免得 bridge 回头又催 Pi 处理它。
 * 扩展在注册帧里声明 abort:true 才发（老扩展收到会默默忽略）；gate 接线在 bridge/interrupt-gate.ts。
 */
import type { ServerWebSocket } from "bun";
import { emitEvent } from "./event-bus.js";
import { newMessageId, newThreadId, type Endpoint, type Envelope } from "./router.js";
import { turnCuts } from "./turn-cuts.js";
import type { TurnTrigger } from "../lib/turn-cuts.js";
import { dropVoidedPendings, type VoidableBooks } from "../lib/pending-reply-scope.js";

type Socket = { send(data: string): void };
interface EchoDeps {
  deliver(env: Envelope): Promise<unknown>;
  /** Discord 通知要带的 owner id（bridge.ts primaryOwnerId） */
  ownerId(): string;
  /** bridge.ts 的几本欠账（取时才读：接线时它们还没初始化） */
  books(): VoidableBooks;
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
/** 等超时之后还认多久迟到的回执：抬头已经发出去了，作废的消息照样要告诉发送方 */
const LATE_ACK_MS = 60_000;
type AbortResult = "aborted" | "idle" | "no_ack";
/** done 在等到回执或超时后清掉：超时之后到的回执只补回显 */
type Waiter = { channelId: string; at: number; done?: (r: AbortResult) => void };
const abortWaiters = new Map<string, Waiter>();
const lastAbort = new Map<string, { result: AbortResult; inEditor: number }>();
/** 频道 → 发出中止的时刻：之后第一次 Stop 是叫停的回声（见 stopAfterAbort） */
const abortedAt = new Map<string, number>();
const ABORT_STOP_MS = 120_000;

/** 扩展的中止回执。from = 发来回执的连接：只认这个频道当前的连接（别的连接对上 id 也不算） */
export function onAbortAck(msg: { id?: unknown; result?: unknown; voided?: unknown; inEditor?: unknown }, from: Socket): void {
  const w = abortWaiters.get(String(msg.id));
  if (!w || socketOf(w.channelId) !== from) return;
  abortWaiters.delete(String(msg.id));
  const done = w.done;
  w.done = undefined;
  const ids = Array.isArray(msg.voided) ? [...new Set(msg.voided.filter((x): x is string => typeof x === "string"))] : [];
  // 先回显再放行：放行之后停字那条会 record() 一条 cut、清掉「这一回合送到了哪些」，就查不到发送方了
  if (ids.length) settleVoided(w.channelId, ids, w.at);
  if (!done) return; // 迟到的回执：只补回显
  lastAbort.set(w.channelId, { result: msg.result === "aborted" ? "aborted" : "idle", inEditor: Number(msg.inEditor) || 0 });
  done(msg.result === "aborted" ? "aborted" : "idle");
}

/** 这个频道最近一次请 Pi 扩展中止的结果（停字抬头照实写：真停了 / 已请求没回执；inEditor = 作废的消息里几条被 Pi 退回了输入框） */
export const lastAbortResult = (channelId: string): { result: AbortResult; inEditor: number } | undefined => lastAbort.get(channelId);

/**
 * Pi 的 Stop 到了：是不是叫停之后的第一次（取一次就清）。是的话 bridge 不做补 reply 拦截——叫停后 Pi 马上 settle 报 Stop，
 * 拦截会注入提醒再开一轮，等于 bridge 自己把刚停住的 Pi 拉起来（wf2 pi-1）。按 bridge 发出中止算，老扩展也兜得住。
 */
export function stopAfterAbort(channelId: string, now = Date.now()): boolean {
  const at = abortedAt.get(channelId);
  return abortedAt.delete(channelId) && at !== undefined && now - at < ABORT_STOP_MS;
}

/** 停字那一轮迟迟不来（比如 Pi 中止后一直 idle）时，停字自己的同步等待最多等这么久就回「已叫停」 */
const STOP_WAIT_MS = 30_000;
/** 频道 → 在同步等待的 Pi 停字（messageId）：叫停引起的那次 Stop 的兜底收尾跳过它们（bridge.ts 用 stopWaitIds） */
const stopWaits = new Map<string, Set<string>>();
export const stopWaitIds = (channelId: string): ReadonlySet<string> => stopWaits.get(channelId) ?? new Set();

/**
 * Pi 的停字自己的 API 同步等待（adv5 P2-1）：叫停引起的那次 Stop 会把挂着的 API 请求按空答复结掉，连这条「停」也算进去——
 * 发中止之前登记，那次 Stop 跳过它，留给停字那一轮去答。停完调返回的函数：过 waitMs 还没人答，就结成一句「已叫停」（附中止回执），不回 null。
 * 没有同步等待（网页 wait:0）不登记。
 */
export function holdStopWait(env: Envelope, channelId: string, agent: string, waitMs = STOP_WAIT_MS): ((text: string) => void) | undefined {
  const queues = echo?.books().pendingApiRequests;
  const id = env.meta.messageId;
  const waiting = () => [...(queues?.values() ?? [])].some((q) => q.some((p) => p.messageId === id && !!p.resolve));
  if (!echo || env.from.kind !== "api" || !waiting()) return undefined;
  const ids = stopWaits.get(channelId) ?? new Set<string>();
  stopWaits.set(channelId, ids.add(id));
  const d = echo, { tokenId, name } = env.from;
  return (text) => {
    setTimeout(() => {
      ids.delete(id);
      if (!ids.size && stopWaits.get(channelId) === ids) stopWaits.delete(channelId);
      if (!waiting()) return; // 停字那一轮已经答了
      const from: Endpoint = { kind: "local", channelId, agentName: agent, ws: socketOf(channelId) as ServerWebSocket<unknown> };
      const meta = { messageId: newMessageId("stopped"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId(), inReplyTo: id };
      void d.deliver({ from, to: { kind: "api", tokenId, name }, intent: "response", content: text, meta })
        .catch((e: Error) => console.error(`⚠️ 「已叫停」答复发给 ${name} 失败: ${e.message}`));
    }, waitMs).unref?.();
  };
}

/** 请 Pi 扩展中止当前回合：真中止了 / 没回执 = ["abort"]，本来就空闲 = []；没连着、扩展太旧不会中止 = 抛错（调用方如实回报，不说「已打断」） */
export async function extensionAbort(channelId: string): Promise<readonly string[]> {
  const ws = socketOf(channelId);
  if (!ws) throw new Error("Pi 会话没连着 bridge，中止请求发不过去");
  if (!abortCapable.has(channelId)) throw new Error("这个 Pi 会话的 Claudestra 扩展太旧、不会中止（重启这个 agent 换上新扩展）");
  const id = `abort_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const at = Date.now();
  abortedAt.set(channelId, at); // 发之前记：回执和 Stop 几毫秒内先后到
  const r = await new Promise<AbortResult>((resolve) => {
    const w: Waiter = { channelId, at, done: resolve };
    abortWaiters.set(id, w);
    setTimeout(() => {
      if (!w.done) return;
      w.done = undefined;
      resolve("no_ack");
      setTimeout(() => abortWaiters.get(id) === w && abortWaiters.delete(id), LATE_ACK_MS);
    }, ABORT_ACK_MS);
    ws.send(JSON.stringify({ type: "abort", id }));
  });
  if (r === "idle") abortedAt.delete(channelId);
  if (r === "no_ack") lastAbort.set(channelId, { result: r, inEditor: 0 });
  return r === "idle" ? [] : ["abort"];
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

/** 作废回显的文案（单测 tests/pi-abort-control.test.ts）。toSender = 直接对发送方说（API / peer / agent），否则是在频道里说给人看 */
export function voidedNotice(agent: string, trigs: readonly TurnTrigger[], toSender: boolean): string {
  const list = trigs.map((t) => `${toSender ? "" : `${t.fromName}：`}「${clip(t.excerpt)}」`).join("、");
  return toSender
    ? `[⏹ bridge] 你发给 ${agent} 的${list}在它被叫停之前送到、还没执行，已作废，不会执行。还要的话请重发。`
    : `[⏹ bridge] ${agent} 被叫停之前送到、还没执行的消息已作废，不会执行：${list}。还要的话请重发。`;
}

/** 一条作废消息的回显发到哪：它自己的回信地址。bridge 自己的通知不回显（null） */
export function voidedEchoTo(t: TurnTrigger): { kind: "user" | "api" | "local"; address: string } | null {
  if (t.fromKind === "user" && t.replyTo) return { kind: "user", address: t.replyTo };
  if (t.fromKind === "api" && t.replyTo.startsWith("api:")) return { kind: "api", address: t.replyTo.slice(4) };
  if (t.fromKind === "local" && t.replyTo) return { kind: "local", address: t.replyTo };
  return null;
}

/** 作废的消息：先销账（找不到发送方的也按 id 销），再逐条告诉发送方 */
function settleVoided(channelId: string, ids: readonly string[], abortAt: number): void {
  const found = ids.map((id) => turnCuts.deliveredMessage(channelId, id)).filter((t): t is NonNullable<typeof t> => !!t);
  if (!echo) return;
  const agentOf = new Map(found.filter((t) => t.fromKind === "local" && t.replyTo).map((t) => [t.messageId, t.replyTo]));
  const voided = ids.map((messageId) => ({ messageId, agentChannel: agentOf.get(messageId) }));
  const n = dropVoidedPendings(echo.books(), channelId, voided, abortAt);
  if (n) console.log(`⏹ 作废的 ${ids.length} 条消息从补答账 / 看门狗销掉 ${n} 条`);
  if (found.length) echoVoided(echo, channelId, found);
}

function echoVoided(d: EchoDeps, channelId: string, found: readonly (TurnTrigger & { agent?: string })[]): void {
  const agent = found.find((t) => t.agent)?.agent ?? "这个 agent";
  let sent = 0;
  for (const t of found) {
    const dest = voidedEchoTo(t);
    let to: Endpoint | undefined;
    if (dest?.kind === "user") to = { kind: "user", userId: d.ownerId(), channelId: dest.address };
    if (dest?.kind === "api") to = { kind: "api", tokenId: dest.address, name: t.fromName };
    const ws = dest?.kind === "local" ? socketOf(dest.address) : undefined;
    if (ws) to = { kind: "local", channelId: dest!.address, agentName: t.fromName, ws: ws as ServerWebSocket<unknown> };
    if (!to) continue; // bridge 自己的通知、发送方 agent 不在线：没法告诉它，它的消息反正没执行
    const text = voidedNotice(agent, [t], to.kind !== "user");
    // response + inReplyTo：那条请求就此了结（不再算「还没回复」、API / peer 的等待拿到这句）；API 回程按 agent 频道认，from 记成这个 agent
    const from: Endpoint = to.kind === "api" ? { kind: "local", channelId, agentName: agent, ws: socketOf(channelId) as ServerWebSocket<unknown> } : { kind: "bridge", label: "pi-abort" };
    const meta = { messageId: newMessageId("voided"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId(), inReplyTo: t.messageId };
    void d.deliver({ from, to, intent: "response", content: text, meta: to.kind === "local" ? { ...meta, waitForIdle: true } : meta })
      .catch((e: Error) => console.error(`⚠️ 作废回显发给 ${t.fromName} 失败: ${e.message}`));
    if (to.kind === "user") emitEvent({ agent, chatId: to.channelId, type: "chat_message", data: { direction: "out", from: "bridge", text, notice: true } });
    sent++;
  }
  console.log(`⏹ ${agent}：停之前 steer 进去、还没执行的 ${found.length} 条已作废，告诉了发送方 ${sent} 条${sent < found.length ? `（${found.length - sent} 条没法告诉：bridge 通知 / 发送方不在线）` : ""}`);
}
