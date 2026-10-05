/**
 * 守门隔离的消息有了结果之后，把挂在它上面的回程收拾好（tests/guard-dropped.test.ts）：
 *   - 丢弃（owner 点丢弃 / 24 h 超时 / 溢出）：API 请求（网页 / guest / peer 的 wait 调用方与线程轮询）拿到一条「没送达」的说明，
 *     等待已过期（2 h）或 bridge 重启过的，也给原线程写上终态；send_to_agent 的槽撤掉这一条并告诉发件 agent。
 *   - 放行：API 等待已过期 / 重启丢了的，按原 threadId 补登，agent 的答复才回得到原线程；send_to_agent 的槽重置送达计时。
 * 不收拾的话，这些等待要么干等到超时，要么被之后某一轮的回复当成它的答复结掉。
 */
import { newMessageId, newThreadId, type Delivery, type Envelope, type LocalEndpoint } from "./router.js";

interface ApiWaiterLike {
  messageId?: string;
  threadId: string;
  tokenId: string;
  tokenName?: string;
  agentName: string;
  agentChannelId: string;
  ts?: number;
  resolve?: (r: { reply: string | null; threadId: string; agent: string; error?: string }) => void;
}
type ThreadResult = { result: { reply: string | null; threadId: string; agent: string; error?: string }; ts: number; tokenId?: string; messageId?: string; agentChannelId?: string };

export interface GuardDroppedBooks {
  apiQueues: Map<string, ApiWaiterLike[]>;
  threadResults: Map<string, ThreadResult>;
  /** api-routes.ts apiReqKey：同一 token × 频道一个队列 */
  reqKey: (tokenId: string, channelId: string) => string;
  dropAgentRequest: (target: string, caller: string, messageId: string) => void;
  /** 回程簿 touchDelivered：消息这才真正送到 target 手上，重置它的送达计时 */
  touchDelivered: (target: string, env: Envelope) => void;
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  deliver: (env: Envelope) => Promise<Delivery>;
}
type Item = { id: string; agent: string; regName?: string; env: Envelope; to: { channelId: string } };
const apiFrom = (env: Envelope): { tokenId: string; name?: string } | null => {
  const f = env.from as { kind: string; tokenId?: string; name?: string };
  return f.kind === "api" && f.tokenId ? { tokenId: f.tokenId, name: f.name } : null;
};
const hasWaiter = (books: GuardDroppedBooks, id: string): boolean => [...books.apiQueues.values()].some((q) => q.some((w) => w.messageId === id));

export function settleGuardDropped(item: Item, books: GuardDroppedBooks, now = Date.now()): void {
  const reply = `（这条消息被 Chat Guard 隔离后丢弃，没有送达 ${item.agent}）`;
  let settled = false;
  for (const [key, queue] of [...books.apiQueues.entries()]) {
    const hit = queue.filter((w) => w.messageId === item.id);
    if (!hit.length) continue;
    const left = queue.filter((w) => w.messageId !== item.id);
    if (left.length) books.apiQueues.set(key, left);
    else books.apiQueues.delete(key);
    for (const w of hit) {
      const result = { reply, threadId: w.threadId, agent: w.agentName, error: "guard_dropped" };
      books.threadResults.set(w.threadId, { result, ts: now, tokenId: w.tokenId, messageId: w.messageId, agentChannelId: w.agentChannelId });
      w.resolve?.(result);
      settled = true;
    }
  }
  const api = apiFrom(item.env);
  const threadId = item.env.meta.threadId;
  if (!settled && api && threadId && !books.threadResults.has(threadId)) { // 等待已过期 / 重启丢了：线程轮询照样拿到终态
    const result = { reply, threadId, agent: item.regName ?? item.agent, error: "guard_dropped" };
    books.threadResults.set(threadId, { result, ts: now, tokenId: api.tokenId, messageId: item.id, agentChannelId: item.to.channelId });
  }
  const from = item.env.from;
  if (from.kind !== "local" || !from.channelId) return;
  books.dropAgentRequest(item.to.channelId, from.channelId, item.id);
  const c = books.client(from.channelId);
  if (!c) return; // 发件 agent 不在线：槽已撤，它上线后不会再等这条
  void books.deliver({
    from: { kind: "bridge", label: "chat-guard" },
    to: { kind: "local", channelId: from.channelId, ws: c.ws, cwd: c.cwd },
    intent: "notification",
    content: `🛡 你发给 ${item.agent} 的消息被它的 Chat Guard 隔离后丢弃，没有送达（消息 id ${item.id}），不用再等它的回复。`,
    meta: { messageId: newMessageId("guard"), triggerKind: "bridge_synth", ts: new Date(now).toISOString(), threadId: newThreadId() },
  });
}

/** 只给原本就是 API 请求（intent=request）的补登：卡片答复等 response 本来没有等待，凭空补一个会抢走真正请求的答复 */
export function settleGuardReleased(item: Item, books: GuardDroppedBooks, now = Date.now()): void {
  const api = item.env.intent === "request" ? apiFrom(item.env) : null;
  const threadId = item.env.meta.threadId;
  for (const q of books.apiQueues.values()) for (const w of q) if (w.messageId === item.id) w.ts = now; // 已有的等待续期：隔离的时间不算在 2 h 里
  if (api && threadId && !hasWaiter(books, item.id)) {
    const key = books.reqKey(api.tokenId, item.to.channelId);
    const entry: ApiWaiterLike = {
      tokenId: api.tokenId, tokenName: api.name ?? api.tokenId, agentChannelId: item.to.channelId, agentName: item.regName ?? item.agent, threadId, messageId: item.id, ts: now,
    };
    books.apiQueues.set(key, [...(books.apiQueues.get(key) ?? []), entry]);
  }
  books.touchDelivered(item.to.channelId, item.env);
}
