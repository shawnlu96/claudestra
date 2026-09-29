/**
 * Pi 的「停」：Pi 的 C-c 只清空输入框，真正的中止在 Claudestra 扩展里（src/pi/abort-control.ts）。bridge 经 ws 发 {type:"abort", id}，
 * 扩展回 {type:"abort_ack", id, result, voided}。voided = 停之前 steer 进去、还没执行就作废的消息（message_id）：
 * 这里逐条告诉发送方「没执行、要的话请重发」——各回到它自己的回信地址（Discord 人回他发消息的频道、API / 网页 / peer 回它的 api 地址、
 * agent 回它自己），和 agent 回复它们走同一条路（镜像开关、peer 的等待都照旧）；同时从补答账、回程槽和看门狗上销掉，免得 bridge 回头又催 Pi 处理它。
 * 扩展在注册帧里声明 abort:true 才发（老扩展收到会默默忽略）；gate 接线在 bridge/interrupt-gate.ts。
 */
import type { ServerWebSocket } from "bun";
import { emitEvent, getAgentStatus } from "./event-bus.js";
import { readRegistryAgents } from "../lib/registry.js";
import { newMessageId, newThreadId, type Endpoint, type Envelope } from "./router.js";
import { turnCuts } from "./turn-cuts.js";
import type { TurnTrigger } from "../lib/turn-cuts.js";
import { dropVoidedPendings, type VoidableBooks } from "../lib/pending-reply-scope.js";
import { KeyWithdrawnError } from "../lib/esc-guard.js";

type Socket = { send(data: string): void };
interface EchoDeps {
  deliver(env: Envelope): Promise<unknown>;
  /** Discord 通知要带的 owner id（bridge.ts primaryOwnerId） */
  ownerId(): string;
  /** bridge.ts 的几本欠账（取时才读：接线时它们还没初始化） */
  books(): VoidableBooks;
  /** 发送方 agent 暂时不在线：回显进押后队列（落盘），它连回来时按频道取最新连接投（held-flush） */
  hold(env: Envelope): void;
}

let socketOf: (channelId: string) => Socket | undefined = () => undefined;
let echo: EchoDeps | undefined;
/** bridge.ts 启动时接上：频道 → 当前连接，以及回显作废消息要用的投递 */
export function setExtensionSocket(fn: typeof socketOf, deps: EchoDeps): void {
  socketOf = fn;
  echo = deps;
}
/** 频道 → 当前登记的那条连接（bridge/acp-link.ts 认帧的来源、给 ACP 宿主发调用都用它） */
export const extensionSocketOf = (channelId: string): Socket | undefined => socketOf(channelId);

const abortCapable = new Set<string>();
export function setAbortCapable(channelId: string, on: boolean): void {
  if (on) abortCapable.add(channelId);
  else abortCapable.delete(channelId);
}

/** 扩展的中止回执要等多久：它同步调 abort()，正常几毫秒就回；等不到就如实写「已请求、没回执」 */
const ABORT_ACK_MS = 1_500;
/** 等超时之后还认多久迟到的回执：抬头已经发出去了，作废的消息照样要告诉发送方 */
const LATE_ACK_MS = 60_000;
type AbortResult = "aborted" | "idle" | "no_ack" | "failed";
/** done 在等到回执或超时后清掉：超时之后到的回执只补回显 */
type Waiter = { channelId: string; at: number; done?: (r: AbortResult, why?: string) => void };
/** 回执的结果：扩展说没法中止（unsupported：这个 Pi 没有 ctx.abort）或中止抛错（error）= failed，不能当成「本来就空闲」（wf2 pi-8） */
const ackResult = (r: unknown): AbortResult => (r === "aborted" ? "aborted" : r === "idle" ? "idle" : "failed");
const abortWaiters = new Map<string, Waiter>();
const lastAbort = new Map<string, { result: AbortResult; inEditor: number }>();
/** 频道 → 发出中止的时刻：之后第一次 Stop 是叫停的回声（见 stopAfterAbort） */
const abortedAt = new Map<string, number>();
const ABORT_STOP_MS = 120_000;

/** 扩展的中止回执。from = 发来回执的连接：只认这个频道当前的连接（别的连接对上 id 也不算） */
export function onAbortAck(msg: { id?: unknown; result?: unknown; voided?: unknown; inEditor?: unknown; error?: unknown }, from: Socket): void {
  const w = abortWaiters.get(String(msg.id));
  if (!w || socketOf(w.channelId) !== from) return;
  abortWaiters.delete(String(msg.id));
  const done = w.done;
  w.done = undefined;
  const ids = Array.isArray(msg.voided) ? [...new Set(msg.voided.filter((x): x is string => typeof x === "string"))] : [];
  // 先回显再放行：放行之后停字那条会 record() 一条 cut、清掉「这一回合送到了哪些」，就查不到发送方了
  if (ids.length) void settleVoided(w.channelId, ids, w.at);
  if (!done) return; // 迟到的回执：只补回显
  const result = ackResult(msg.result);
  lastAbort.set(w.channelId, { result, inEditor: Number(msg.inEditor) || 0 });
  done(result, result === "failed" ? String(msg.error ?? msg.result ?? "") : undefined);
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
 * 发中止之前登记，那次 Stop 跳过它，留给停字那一轮去答。停完调返回的函数：过 waitMs（且赶在调用方的等待到期前）还没人答，就结成一句「已叫停」，不回 null。
 * 没有同步等待（网页 wait:0）不登记。
 */
export function holdStopWait(env: Envelope, channelId: string, agent: string, waitMs = STOP_WAIT_MS): ((text: string) => void) | undefined {
  const queues = echo?.books().pendingApiRequests;
  const id = env.meta.messageId;
  const find = () => [...(queues?.values() ?? [])].flat().find((p) => p.messageId === id);
  const w = find(); // 看 waitUntil：这时 resolve 还没挂（api-routes 在 deliver 返回后才挂）
  if (!echo || env.from.kind !== "api" || !w || !(w.waitUntil || w.resolve)) return undefined;
  const ids = stopWaits.get(channelId) ?? new Set<string>();
  stopWaits.set(channelId, ids.add(id));
  const d = echo, { tokenId, name } = env.from;
  return (text) => {
    setTimeout(() => {
      ids.delete(id);
      if (!ids.size && stopWaits.get(channelId) === ids) stopWaits.delete(channelId);
      if (!find()) return; // 停字那一轮已经答了（认领走了）
      const from: Endpoint = { kind: "local", channelId, agentName: agent, ws: socketOf(channelId) as ServerWebSocket<unknown> };
      const meta = { messageId: newMessageId("stopped"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId(), inReplyTo: id };
      void d.deliver({ from, to: { kind: "api", tokenId, name }, intent: "response", content: text, meta })
        .catch((e: Error) => console.error(`⚠️ 「已叫停」答复发给 ${name} 失败: ${e.message}`));
    }, Math.max(0, Math.min(waitMs, (w.waitUntil ?? Infinity) - Date.now() - 1_500))).unref?.(); // 赶在调用方自己等超时之前，别让它拿到 timedOut
  };
}

/** 请 Pi 扩展中止当前回合：真中止了 / 没回执 = ["abort"]，本来就空闲 = []；没连着、扩展太旧、扩展回执说中止不了 = 抛错（调用方如实回报，不说「已打断」） */
export async function extensionAbort(channelId: string, wanted?: () => boolean): Promise<readonly string[]> {
  if (wanted && !wanted()) throw new KeyWithdrawnError("中止请求没发：发出那一刻已经不需要了"); // 到下面 ws.send 之间没有 await
  const ws = socketOf(channelId);
  if (!ws) throw new Error("Pi 会话没连着 bridge，中止请求发不过去");
  if (!abortCapable.has(channelId)) throw new Error("这个 Pi 会话的 Claudestra 扩展太旧、不会中止（重启这个 agent 换上新扩展）");
  const id = `abort_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const at = Date.now();
  abortedAt.set(channelId, at); // 发之前记：回执和 Stop 几毫秒内先后到
  let why = "";
  const r = await new Promise<AbortResult>((resolve) => {
    const w: Waiter = { channelId, at, done: (x, reason) => ((why = reason ?? ""), resolve(x)) };
    abortWaiters.set(id, w);
    setTimeout(() => {
      if (!w.done) return;
      w.done = undefined;
      resolve("no_ack");
      setTimeout(() => abortWaiters.get(id) === w && abortWaiters.delete(id), LATE_ACK_MS);
    }, ABORT_ACK_MS);
    ws.send(JSON.stringify({ type: "abort", id }));
  });
  if (r === "idle" || r === "failed") abortedAt.delete(channelId);
  if (r === "failed") throw new Error(`Pi 扩展没能中止当前回合（${why || "未说明原因"}）`);
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

/** 回显的文案 + 日志里怎么称呼这些消息（Pi 作废 / Codex 没投进去） */
type Notice = { text(agent: string, t: TurnTrigger, toSender: boolean): string; what: string };
const piVoided: Notice = { text: (agent, t, toSender) => voidedNotice(agent, [t], toSender), what: "停之前 steer 进去、还没执行的" };

/** 作废的消息：先销账（找不到发送方的也按 id 销），再逐条告诉发送方。发送方的查找同步做完（调用方随后会清送达记录）；返回真告诉到的条数 */
function settleVoided(channelId: string, ids: readonly string[], abortAt: number, notice: Notice = piVoided): Promise<number> {
  const found = ids.map((id) => turnCuts.deliveredMessage(channelId, id)).filter((t): t is NonNullable<typeof t> => !!t);
  if (!echo) return Promise.resolve(0);
  const agentOf = new Map(found.filter((t) => t.fromKind === "local" && t.replyTo).map((t) => [t.messageId, t.replyTo]));
  const voided = ids.map((messageId) => ({ messageId, agentChannel: agentOf.get(messageId) }));
  const n = dropVoidedPendings(echo.books(), channelId, voided, abortAt);
  if (n) console.log(`⏹ 作废的 ${ids.length} 条消息从补答账 / 看门狗销掉 ${n} 条`);
  return found.length ? echoVoided(echo, channelId, found, notice) : Promise.resolve(0);
}

/** deliver 的结果是不是没送到（错误 / 丢弃）；测试替身返回 undefined 算送到 */
const notSent = (r: unknown): boolean => ["error", "dropped"].includes(String((r as { outcome?: { kind?: string } } | undefined)?.outcome?.kind));

/**
 * 逐条回显，等投递结果再数：送到了，或者发给本机 agent 的押进了押后队列（落盘，它连回来 / 空闲时按频道取最新连接投）才算告诉到。
 * 本机 agent 不在线、投递报错 / 被丢 / 抛错都押进队列；API / 用户没有队列，没送到就不算——settled 少报，channel-server 自己兜底说
 * （T52 复审 #204 P2：删了回程却没告诉，还报 settled=1）
 */
async function echoVoided(d: EchoDeps, channelId: string, found: readonly (TurnTrigger & { agent?: string })[], notice: Notice): Promise<number> {
  const agent = found.find((t) => t.agent)?.agent ?? "这个 agent";
  const jobs: Promise<boolean>[] = [];
  for (const t of found) {
    const dest = voidedEchoTo(t);
    let to: Endpoint | undefined;
    if (dest?.kind === "user") to = { kind: "user", userId: d.ownerId(), channelId: dest.address };
    if (dest?.kind === "api") to = { kind: "api", tokenId: dest.address, name: t.fromName };
    const ws = dest?.kind === "local" ? socketOf(dest.address) : undefined;
    if (dest?.kind === "local") to = { kind: "local", channelId: dest.address, agentName: t.fromName, ws: ws as ServerWebSocket<unknown> };
    if (!to) continue; // bridge 自己的通知：没有回信地址，它的消息反正没执行
    const text = notice.text(agent, t, to.kind !== "user");
    // response + inReplyTo：那条请求就此了结（不再算「还没回复」、API / peer 的等待拿到这句）；API 回程按 agent 频道认，from 记成这个 agent
    const from: Endpoint = to.kind === "api" ? { kind: "local", channelId, agentName: agent, ws: socketOf(channelId) as ServerWebSocket<unknown> } : { kind: "bridge", label: "pi-abort" };
    const meta = { messageId: newMessageId("voided"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId(), inReplyTo: t.messageId };
    const env: Envelope = { from, to, intent: "response", content: text, meta: to.kind === "local" ? { ...meta, waitForIdle: true } : meta };
    const local = to.kind === "local" ? to : null;
    const hold = () => (local ? (d.hold({ ...env, to: { ...local, ws: undefined as never } }), true) : false);
    if (local && !ws) { jobs.push(Promise.resolve(hold())); continue; }
    jobs.push(d.deliver(env).then((r) => !notSent(r) || hold(), (e: Error) => (console.error(`⚠️ 作废回显发给 ${t.fromName} 失败: ${e.message}`), hold())));
    if (to.kind === "user") emitEvent({ agent, chatId: to.channelId, type: "chat_message", data: { direction: "out", from: "bridge", text, notice: true } });
  }
  const told = (await Promise.all(jobs)).filter(Boolean).length;
  console.log(`⏹ ${agent}：${notice.what} ${found.length} 条已作废，告诉了发送方 ${told} 条${told < found.length ? `（${found.length - told} 条没告诉到：bridge 通知没有回信地址 / 送不到）` : ""}`);
  return told;
}

/**
 * Codex 投递失败（channel-server 的 codex_undelivered：不在线 / 认不准线程 / codex queue 报错）：消息没进 Codex，不会有回合、也不会有 hook。
 * 走和 Pi 作废消息同一套——只了结这一条（按 messageId 销补答账、回程槽，回信地址收到一条带 inReplyTo 的 response，API / peer 的等待拿到这句），
 * 不补整轮的 StopFailure：同一个 agent 可能正在跑上一条，整轮收尾会把它的等待、状态一起结掉（T52 He 审 #204 P1）。
 * 也不替它宣告完成：Codex 空不空闲 bridge 推不准（按消息推算、事件环、原生回合账九轮复审都找得出漏洞），「工作中」只等真实的
 * Stop / StopFailure 来收；还挂着 thinking 就在频道里标一句。已知残留：失败且确实没有回合时会一直挂到下一次真实收尾，结构上的
 * 解法在 T60 ACP（prompt 有没有返回就是忙闲）。返回 settled = 告诉了几条发送方，0 = channel-server 自己兜底说。
 */
export async function onCodexUndelivered(
  msg: { requestId?: unknown; channelId?: unknown; messageId?: unknown; reason?: unknown }, ws: Socket, own: boolean, d: UndeliveredDeps = {},
): Promise<void> {
  const channelId = typeof msg.channelId === "string" ? msg.channelId : "";
  const messageId = typeof msg.messageId === "string" ? msg.messageId : "";
  const reason = typeof msg.reason === "string" && msg.reason.trim() ? msg.reason.trim().slice(0, 400) : "⚠️ 消息没能投进 Codex";
  let settled = 0;
  if (own && channelId && messageId) {
    const known = turnCuts.deliveredMessage(channelId, messageId)?.agent ?? turnCuts.agentOn(channelId);
    const told = settleVoided(channelId, [messageId], Date.now(), { text: () => reason, what: "没投进 Codex 的" }); // 先查发送方，再清送达记录
    turnCuts.dropUndelivered(channelId, messageId);
    settled = await told;
    // bridge 重启后投递记录是空的：agent 按频道从 registry 查
    const agent = known ?? (await (d.agentOf ?? agentFromRegistry)(channelId));
    if (agent) noteStuck(agent, channelId);
  }
  ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: { settled } }));
}

type UndeliveredDeps = {
  /** 投递记录里查不到时按频道找 agent（测试注入；默认读 registry） */
  agentOf?(channelId: string): Promise<string | undefined>;
};

/** registry 读不到就当查无此 agent：最坏这次不在频道里标那一句，发送方照样收到了失败回显 */
const agentFromRegistry = async (channelId: string): Promise<string | undefined> =>
  (await readRegistryAgents().catch((e: Error) => (console.warn(`⚠️ 投递失败读 registry 失败: ${e.message}`), []))).find((a) => a.channelId === channelId)?.name;

const namesOf = (agent: string) => [agent, agent.replace(/^agent-/, ""), `agent-${agent.replace(/^agent-/, "")}`];

/** 还挂着「工作中」：在频道里标一句投递失败、没替它宣告完成（不动状态） */
function noteStuck(agent: string, channelId: string): void {
  const who = namesOf(agent).find((n) => getAgentStatus(n) === "thinking");
  if (!who) return;
  const text = "⚠️ 有消息没投进 Codex，这一回合是否还在跑拿不准，bridge 没有替它宣告完成；卡住的话打断一下或重发。";
  emitEvent({ agent: who, chatId: channelId, type: "chat_message", data: { direction: "out", from: "bridge", text, notice: true } });
}
