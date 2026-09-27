/**
 * 收件箱（台账 i15，codex 复核意见「可见、可拉取的未读收件箱」）：agent 调 check_inbox，把排队给它的 agent 消息
 * （它在回合中时别的 agent 发来、押在 bridge/held-queue.ts 里等 Stop 的那些）现在就取回，作为工具结果交给它——
 * 工具结果是回合中一定送得到的通道，不像 channel 通知在回合开头会被静默丢掉。
 *
 * 取走即出队落盘（回合结束不会再送一遍）；工具结果发出去之前 bridge 崩了会丢这几条——窗口只有一次 ws 往返，
 * 可接受。和 Stop 后的投递用同一把频道锁（held.claim），不会一条送两次。回合中自动提醒见设计稿 docs/15-inbox.md。
 */
import type { ServerWebSocket } from "bun";
import type { AgentCallBook } from "./agent-calls.js";
import type { HeldItem, HeldQueue } from "./held-queue.js";
import type { Envelope } from "./router.js";

export interface InboxDeps {
  clients: Map<string, { ws: ServerWebSocket<unknown> }>;
  held: HeldQueue;
  calls: AgentCallBook;
  /** 和正常投递同一个渲染（「[🤖 来自 X]」抬头等） */
  render: (env: Envelope) => Promise<string>;
  /** 网页镜像：和正常投递一样画成一条入站气泡 */
  emitIn: (channelId: string, env: Envelope) => void;
}
let deps: InboxDeps | null = null;
export function initInbox(d: InboxDeps): void {
  deps = d;
}

/** 一次最多取这么多，太多就分几次（工具结果太长模型读不全） */
const MAX_TAKE = 10;
const isAgentMsg = (i: HeldItem) => i.env.from.kind === "local";

type Result = { result: { n: number; text: string } } | { error: string };

export async function takeInbox(ws: ServerWebSocket<unknown>, now = Date.now()): Promise<Result> {
  if (!deps) return { error: "bridge 还没初始化收件箱" };
  const d = deps;
  const channelId = [...d.clients.entries()].find(([, c]) => c.ws === ws)?.[0];
  if (!channelId) return { error: "认不出你是哪个 agent（频道没注册）" };
  if (!d.held.claim(channelId)) {
    return { result: { n: 0, text: "收件箱正在按普通消息投递给你（这一轮刚结束？），稍后就到，不用再查。" } };
  }
  try {
    const items = (d.held.get(channelId) ?? []).filter(isAgentMsg).slice(0, MAX_TAKE);
    if (!items.length) return { result: { n: 0, text: "收件箱是空的：没有排队给你的消息。" } };
    const parts: string[] = [];
    for (const [k, it] of items.entries()) {
      const from = it.env.from.kind === "local" ? it.env.from.agentName || it.env.from.channelId : "?";
      const mins = Math.max(0, Math.round((now - it.heldAt) / 60_000));
      parts.push(`── ${k + 1}/${items.length} · 来自 ${from} · message_id=${it.env.meta.messageId} · 排队 ${mins} 分钟 ──\n${await d.render(it.env)}`);
    }
    for (const it of items) {
      d.held.remove(channelId, it);
      d.emitIn(channelId, it.env);
    }
    d.calls.touch(channelId); // 对方的请求这会儿才真正到它手上：回程失效钟从现在起算
    const left = (d.held.get(channelId) ?? []).filter(isAgentMsg).length;
    const head = `[📬 收件箱：取回 ${items.length} 条排队的消息${left ? `，还剩 ${left} 条，处理完再调一次 check_inbox` : ""}。答复别的 agent 用 send_to_agent。]`;
    return { result: { n: items.length, text: [head, ...parts].join("\n\n") } };
  } finally {
    d.held.release(channelId);
  }
}
