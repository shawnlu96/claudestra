/**
 * CC 的插队「至少送达一次」：回合中直投的 channel 通知，工具间隙到的会被 CC 包成不可信外部消息插进回合、出队后不再投，
 * 模型可能不理（实测 3/3 没照做）。所以投出去先记账，目标对发送方 reply / send_to_agent 就销账；回合 Stop 时还没销的，
 * 看 CC 会话记录：作为附件插进来的、或根本没落盘的，按普通消息补投原文一次（按 message_id 去重）；还排在 CC 自己队列里的不补
 * （CC 马上另起一轮正常投，补了就是两份）。另管版本闸：只有实测过的 CC 版本才直投（判据在 lib/steer-cc.ts）。
 * 单测 tests/steer-cc.test.ts；设计 docs/architecture/inbound-route.md「CC 实测」
 */
import { readRegistryAgents } from "../lib/registry.js";
import { sessionJsonlPath } from "../lib/session-source.js";
import { CC_INSERT_MIN_VERSION, ccInsertState, ccVersionOf, needsRedeliver, REDELIVER_HEAD, versionAtLeast } from "../lib/steer-cc.js";
import type { Envelope, LocalEndpoint } from "./router.js";

/** 会话记录只读尾部这么多：版本每条记录都带，插队那条只会在当前回合附近 */
const TAIL_BYTES = 1_000_000;
/** 记账超过这么久还没 Stop（会话挂了 / 被重启）就不补了：那时补投的原文多半已过时 */
const PENDING_TTL_MS = 30 * 60_000;
/** 补投过的 message_id 记最近这么多条（去重 + 补投那封不再问 Jev） */
const REDELIVERED_KEEP = 500;

interface Deps {
  /** 这个频道的 CC 会话记录尾部；找不到 = null */
  tail: (channelId: string) => Promise<string | null>;
  now: () => number;
}
let deps: Deps = {
  tail: async (ch) => {
    const reg = (await readRegistryAgents()).find((a) => a.channelId === ch);
    const cwd = reg?.cwd?.replace(/^~/, process.env.HOME || "~");
    const p = reg?.sessionId && cwd ? sessionJsonlPath(reg.runtime, cwd, reg.sessionId) : null;
    if (!p) return null;
    const f = Bun.file(p);
    if (!(await f.exists())) return null;
    return f.slice(Math.max(0, f.size - TAIL_BYTES)).text();
  },
  now: () => Date.now(),
};
export const configureSteerCc = (d: Partial<Deps>): void => void (deps = { ...deps, ...d });

const pending = new Map<string, Map<string, { env: Envelope; at: number }>>(); // 目标频道 → message_id → 那封
const redelivered = new Set<string>();

/** 版本闸：读得到运行中 CC 的版本、且不低于实测过的最低版本才直投；读不到 / 更低 = 插不进（insert 按排队） */
export async function ccInsertAllowed(channelId: string): Promise<boolean> {
  const tail = await deps.tail(channelId).catch((e: Error) => (console.warn(`⚠️ 插队版本闸：读会话记录失败，按插不进: ${e.message}`), null));
  return versionAtLeast(tail ? ccVersionOf(tail) : null, CC_INSERT_MIN_VERSION);
}

/** 回合中经 channel 插队送出去了：记账，等回复或 Stop */
export function noteChannelInsert(env: Envelope, channelId: string): void {
  const book = pending.get(channelId) ?? new Map();
  book.set(env.meta.messageId, { env, at: deps.now() });
  pending.set(channelId, book);
}

const bare = (n: string | undefined): string => (n ?? "").replace(/^agent-/, "");
/** 目标（replier 频道）回了发送方：reply 到发送方频道，或 send_to_agent 给发送方。回别人的不算 */
export function settleInsertReply(replierChannel: string, to: { chatId?: unknown; target?: unknown }): void {
  const book = pending.get(replierChannel);
  if (!book) return;
  for (const [id, { env }] of book) {
    if (env.from.kind !== "local") continue;
    if (to.chatId === env.from.channelId || (typeof to.target === "string" && to.target && bare(to.target) === bare(env.from.agentName))) book.delete(id);
  }
  if (!book.size) pending.delete(replierChannel);
}

/** owner 叫停 / 在频道里打字 / agent 被 kill：它作为目标或发送方的账一起销（同 bridge.ts clearInterAgentPendingsForChannel） */
export function dropInserts(channelId: string): void {
  pending.delete(channelId);
  for (const [ch, book] of pending) {
    for (const [id, { env }] of book) if (env.from.kind === "local" && env.from.channelId === channelId) book.delete(id);
    if (!book.size) pending.delete(ch);
  }
}

/** 补投的那封：投递时不再问 Jev（否则目标又忙时可能再插一次，又进这本账） */
export const isInsertRedelivery = (env: Envelope): boolean => redelivered.has(env.meta.messageId) && env.content.startsWith(REDELIVER_HEAD);

/**
 * 目标这一轮正常结束（Stop）时调：还没销的账逐条看 CC 那边的状态，该补的按普通消息补投原文（新抬头，去掉插队结论，同一个 message_id、
 * 回程归属不变），返回补投了几条（调用方据此不再发看门狗那句催促：补投的这封自己会重新挂看门狗）。读不到会话记录按没落盘补（宁可多送一次）
 */
export async function redeliverInserts(channelId: string, send: (env: Envelope) => Promise<unknown>, to: LocalEndpoint | undefined): Promise<number> {
  const book = pending.get(channelId);
  pending.delete(channelId);
  if (!book || !to) return 0;
  const now = deps.now();
  const live = [...book.values()].filter((p) => now - p.at < PENDING_TTL_MS && !redelivered.has(p.env.meta.messageId));
  if (!live.length) return 0;
  const tail = await deps.tail(channelId).catch((e: Error) => (console.warn(`⚠️ 插队补投：读会话记录失败，按没落盘补投: ${e.message}`), null));
  let n = 0;
  for (const { env } of live) {
    const state = tail === null ? "absent" : ccInsertState(tail, env.meta.messageId);
    if (!needsRedeliver(state)) continue;
    redelivered.add(env.meta.messageId);
    if (redelivered.size > REDELIVERED_KEEP) redelivered.delete(redelivered.values().next().value!);
    const { inboundRoute: _route, ...meta } = env.meta;
    console.log(`↩︎ 插队补投：${to.agentName ?? channelId} 没回 ${env.meta.messageId}（CC 那边 ${state}），按普通消息再投一次原文`);
    await send({ ...env, to, content: `${REDELIVER_HEAD}\n\n${env.content}`, meta });
    n++;
  }
  return n;
}
