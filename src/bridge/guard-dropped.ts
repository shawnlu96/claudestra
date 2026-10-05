/**
 * 隔离中的消息被丢弃（owner 点丢弃 / 24 h 超时 / 隔离区溢出）之后，结掉挂在它上面的回程：
 *   - API 请求（网页 / guest / peer 的 wait 调用方与线程轮询）：拿到一条「没送达」的说明，不再干等；
 *   - send_to_agent 的回程槽：撤掉这一条请求，并告诉发件 agent 没送到。
 * 不结的话，这些等待要么干等到超时，要么被之后某一轮的回复当成它的答复结掉（tests/guard-dropped.test.ts）。
 */
import { newMessageId, newThreadId, type Delivery, type Envelope, type LocalEndpoint } from "./router.js";

interface ApiWaiterLike {
  messageId?: string;
  threadId: string;
  tokenId: string;
  agentName: string;
  agentChannelId: string;
  resolve?: (r: { reply: string | null; threadId: string; agent: string; error?: string }) => void;
}

export interface GuardDroppedBooks {
  apiQueues: Map<string, ApiWaiterLike[]>;
  threadResults: Map<string, { result: { reply: string | null; threadId: string; agent: string; error?: string }; ts: number; tokenId?: string; messageId?: string; agentChannelId?: string }>;
  dropAgentRequest: (target: string, caller: string, messageId: string) => void;
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  deliver: (env: Envelope) => Promise<Delivery>;
}

export function settleGuardDropped(item: { id: string; agent: string; env: Envelope; to: { channelId: string } }, books: GuardDroppedBooks, now = Date.now()): void {
  const reply = `（这条消息被 Chat Guard 隔离后丢弃，没有送达 ${item.agent}）`;
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
    }
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
