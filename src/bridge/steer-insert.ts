/**
 * 插队（insert，Pi / ACP 的 steer）的确认账：回合中 steer 进去的请求，在目标明确回给插队方（reply 到它的频道 / send_to_agent 给它）之前
 * 都算「没确认」，回程簿按「目标还没看到」算（bridge.ts heldFromOf 带上 insertUnseenFrom）——目标回 owner 的话、这一轮和之后任何一轮的
 * 收尾文字都不会被当成对插队方的答复推回去，也不消化它的回程槽。Stop 时不结账：改动前这条押到目标空闲、由它自己开一轮，那一轮的 drain
 * 才是对它的答复；插队后没有「它自己那一轮」，所以只认明确回复（没回复由看门狗照常催）。
 * 账落盘（bridge 重启后不把没确认的放成「已看到」），有效期同押后队列；只在目标被 kill 时整本销。单测 tests/steer-insert.test.ts；
 * 设计 docs/architecture/inbound-route.md「插队」
 */
import { statePath } from "../lib/paths.js";
import { HELD_GIVE_UP_MS } from "./held-queue.js";
import { PersistedMap } from "./persisted-map.js";
import type { Envelope } from "./router.js";

interface Entry { env: Envelope; at: number }
type Book = Record<string, Entry>; // message_id → 那封
const isBook = (v: unknown): boolean =>
  !!v && typeof v === "object" && Object.values(v as object).every((e) => !!e && typeof e === "object" && typeof (e as Entry).at === "number" && !!(e as Entry).env);

let now = (): number => Date.now();
/** 单测注入时钟 */
export const configureSteerInsert = (d: { now: () => number }): void => void (now = d.now);

/** 目标频道 → 它手上还没确认的插队（落盘：ws 剥掉） */
let book = new PersistedMap<Book>(statePath("insert-pending.json"), "插队待确认", isBook);
/** 单测换一本（path = null 只在内存；同一个 path 再开一次 = 模拟 bridge 重启） */
export const openInsertBook = (path: string | null): void => void (book = new PersistedMap<Book>(path, "插队待确认", isBook));

const live = (b: Book | undefined): [string, Entry][] => Object.entries(b ?? {}).filter(([, e]) => now() - e.at < HELD_GIVE_UP_MS);
function put(channelId: string, entries: [string, Entry][]): void {
  if (entries.length) book.set(channelId, Object.fromEntries(entries));
  else book.delete(channelId);
}

/** 插队送进回合了（afterInsertSend）：记一笔，等目标明确回给插队方 */
export function noteInsert(env: Envelope, channelId: string): void {
  if (env.meta.inboundRoute?.action !== "insert" || env.from.kind !== "local") return;
  put(channelId, [...live(book.get(channelId)).filter(([id]) => id !== env.meta.messageId), [env.meta.messageId, { env, at: now() }]]);
}

/** 没确认的插队，形状同押后队列的 unseenFrom：回程簿据此不把目标别的输出当成对插队方的答复 */
export function insertUnseenFrom(target: string): { fromKind: string; fromChannelId?: string; messageId?: string }[] {
  return live(book.get(target)).map(([id, e]) => ({ fromKind: "local", fromChannelId: e.env.from.kind === "local" ? e.env.from.channelId : undefined, messageId: id }));
}

const bare = (n: string | undefined): string => (n ?? "").replace(/^agent-/, "");
/** 目标（replier 频道）明确回了插队方：reply 到它的频道，或 send_to_agent 给它。回别人（含在自己频道回 owner）的不算 */
export function settleInsertReply(replierChannel: string, to: { chatId?: unknown; target?: unknown }): void {
  const b = book.get(replierChannel);
  if (!b) return;
  const answered = ({ env }: Entry): boolean => env.from.kind === "local"
    && (to.chatId === env.from.channelId || (typeof to.target === "string" && !!to.target && bare(to.target) === bare(env.from.agentName)));
  const keep = Object.entries(b).filter(([, e]) => !answered(e));
  if (keep.length !== Object.keys(b).length) put(replierChannel, keep);
}

/** 目标被 kill（/agent/cleanup）：它的账销掉。owner 打字 / 叫停不销 */
export const dropInserts = (channelId: string): void => void book.delete(channelId);
