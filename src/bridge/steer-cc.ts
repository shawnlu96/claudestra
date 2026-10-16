/**
 * 插队（insert）的确认账：回合中送进去的请求，在目标明确回给插队方（reply 到它的频道 / send_to_agent 给它）之前都算「没确认」。
 * - 没确认的按「目标还没看到」算（bridge.ts heldFromOf 带上 insertUnseenFrom）：目标回 owner 的话、这一轮的收尾文字都不会被当成
 *   对插队方的答复推回去，也不消化它的回程槽（tests/steer-cc.test.ts「误认答复」）；
 * - CC 的 channel 插队要「至少送达一次」：工具间隙到的会被包成不可信外部消息、出队后不再投。Stop 时看 CC 会话记录：作为附件插进来的、
 *   没落盘的，把原文压进押后队列补投（随押后队列落盘、24 小时老化、叫停抬头、同一发送方的先后顺序都照押后队列的规矩）；还排在 CC
 *   自己队列里的 / 已作为正常一轮投过的不补，也不催看门狗（CC 正要处理它）。Pi / ACP 的 steer 是真送进了回合，Stop 时只销账。
 * 账落盘（bridge 重启还在），有效期同押后队列；StopFailure / 叫停中止 / owner 打字都不销，只在目标被 kill 时销。版本闸也在这里（判据 lib/steer-cc.ts）。
 * 设计 docs/architecture/inbound-route.md「插队」「CC 实测」
 */
import { readRegistryAgents } from "../lib/registry.js";
import { statePath } from "../lib/paths.js";
import { sessionJsonlPath } from "../lib/session-source.js";
import { CC_INSERT_MIN_VERSION, ccInsertState, ccInToolWindow, ccVersionOf, isRedeliverText, needsRedeliver, redeliverHead, versionAtLeast } from "../lib/steer-cc.js";
import { HELD_GIVE_UP_MS, type HeldQueue } from "./held-queue.js";
import { PersistedMap } from "./persisted-map.js";
import type { Envelope, LocalEndpoint } from "./router.js";

/** 会话记录只读尾部这么多：版本每条记录都带，插队那条只会在当前回合附近 */
const TAIL_BYTES = 1_000_000;

interface Entry { env: Envelope; at: number; via: "steer" | "channel" }
type Book = Record<string, Entry>; // message_id → 那封
const isBook = (v: unknown): boolean =>
  !!v && typeof v === "object" && Object.values(v as object).every((e) => !!e && typeof e === "object" && typeof (e as Entry).at === "number" && !!(e as Entry).env);

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

/** 目标频道 → 它手上还没确认的插队（落盘：ws 剥掉，补投时用 Stop 那一刻的连接） */
let book = new PersistedMap<Book>(statePath("insert-pending.json"), "插队待确认", isBook);
/** 单测换一本（path = null 只在内存；同一个 path 再开一次 = 模拟 bridge 重启） */
export const openInsertBook = (path: string | null): void => void (book = new PersistedMap<Book>(path, "插队待确认", isBook));

/**
 * CC 现在能不能插：版本闸（读得到运行中 CC 的版本、不低于实测过的最低版本，预发布版不算）+ 正在执行工具（只有这时会插进当前回合；
 * 推理 / 出字时到的进 CC 自己的队列，owner 一按 Escape 就被当新一轮立刻投）。任一不满足 = 插不进（insert 按排队，走押后队列）
 */
export async function ccInsertAllowed(channelId: string): Promise<boolean> {
  const tail = await deps.tail(channelId).catch((e: Error) => (console.warn(`⚠️ 插队版本闸：读会话记录失败，按插不进: ${e.message}`), null));
  return !!tail && versionAtLeast(ccVersionOf(tail), CC_INSERT_MIN_VERSION) && ccInToolWindow(tail);
}

const live = (b: Book | undefined, now: number): [string, Entry][] => Object.entries(b ?? {}).filter(([, e]) => now - e.at < HELD_GIVE_UP_MS);
function put(channelId: string, b: Book): void {
  if (Object.keys(b).length) book.set(channelId, b);
  else book.delete(channelId);
}

/** 插队送进回合了（afterInsertSend）：记一笔，等目标回给插队方或 Stop */
export function noteInsert(env: Envelope, channelId: string): void {
  const via = env.meta.inboundRoute?.via;
  if (!via || env.from.kind !== "local") return;
  const now = deps.now();
  put(channelId, { ...Object.fromEntries(live(book.get(channelId), now)), [env.meta.messageId]: { env, at: now, via } });
}

/** 没确认的插队，形状同押后队列的 unseenFrom：回程簿据此不把目标别的输出当成对插队方的答复 */
export function insertUnseenFrom(target: string): { fromKind: string; fromChannelId?: string; messageId?: string }[] {
  return live(book.get(target), deps.now()).map(([id, e]) => ({ fromKind: "local", fromChannelId: e.env.from.kind === "local" ? e.env.from.channelId : undefined, messageId: id }));
}

const bare = (n: string | undefined): string => (n ?? "").replace(/^agent-/, "");
/** 目标（replier 频道）明确回了插队方：reply 到它的频道，或 send_to_agent 给它。回别人（含在自己频道回 owner）的不算 */
export function settleInsertReply(replierChannel: string, to: { chatId?: unknown; target?: unknown }): void {
  const b = book.get(replierChannel);
  if (!b) return;
  const keep = Object.entries(b).filter(([, { env }]) => {
    if (env.from.kind !== "local") return true;
    return !(to.chatId === env.from.channelId || (typeof to.target === "string" && !!to.target && bare(to.target) === bare(env.from.agentName)));
  });
  if (keep.length !== Object.keys(b).length) put(replierChannel, Object.fromEntries(keep));
}

/** 目标被 kill（/agent/cleanup）：它的账销掉。owner 打字 / 叫停不销——那条还要补投，叫停后的抬头由押后队列加 */
export const dropInserts = (channelId: string): void => void book.delete(channelId);

/** 补投的那封：投递时不再问 Jev（否则目标又忙时可能再插一次）。按正文抬头认，bridge 重启后从押后队列放出来也认得 */
export const isInsertRedelivery = (env: Envelope): boolean => isRedeliverText(env.content);

export interface StopSettle { redelivered: number; quiet: boolean }
/**
 * 目标这一轮正常结束（Stop）时调（StopFailure / 叫停中止不调，账留到之后一次正常 Stop）。逐笔销账：steer 的直接销；
 * channel 的看 CC 那边的状态，该补的把原文压进押后队列（新抬头、去掉插队结论、同一个 message_id 回程归属不变）并安排 flush。
 * 返回补投几条、有没有「CC 正要处理」的（quiet）：两者任一为真调用方就不发看门狗那句催促——补投那封投出时自己会重新挂看门狗
 */
export async function settleInsertsAtStop(channelId: string, d: { held: Pick<HeldQueue, "holdEnv">; flush: () => void; to: LocalEndpoint }): Promise<StopSettle> {
  const entries = live(book.get(channelId), deps.now());
  book.delete(channelId);
  const out: StopSettle = { redelivered: 0, quiet: false };
  const cc = entries.filter(([, e]) => e.via === "channel");
  if (!cc.length) return out;
  const tail = await deps.tail(channelId).catch((e: Error) => (console.warn(`⚠️ 插队补投：读会话记录失败，按没落盘补投: ${e.message}`), null));
  for (const [id, { env }] of cc) {
    const state = tail === null ? "absent" : ccInsertState(tail, id);
    if (!needsRedeliver(state)) {
      out.quiet = true;
      continue;
    }
    const { inboundRoute: _route, ...meta } = env.meta;
    console.log(`↩︎ 插队补投：${d.to.agentName ?? channelId} 没回 ${id}（CC 那边 ${state}），原文进押后队列再投一次`);
    d.held.holdEnv({ ...env, to: d.to, content: `${redeliverHead(state)}\n\n${env.content}`, meta });
    out.redelivered++;
  }
  if (out.redelivered) d.flush();
  return out;
}
