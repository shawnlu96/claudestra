/**
 * 收件箱（台账 i15，codex 复核意见「可见、可拉取的未读收件箱」）：agent 调 check_inbox，把排队给它的 agent 消息
 * （它在回合中时别的 agent 发来、押在 bridge/held-queue.ts 里等 Stop 的那些）现在就领回来，作为工具结果交给它——
 * 工具结果是回合中一定送得到的通道，不像 channel 通知在回合开头会被静默丢掉。
 *
 * 领取 = 租约，不是出队：工具结果丢了、客户端断线、回合被取消都不该丢整批（codex 2026-09-28 复核）。agent 处理完用
 * check_inbox({ ack: batchId }) 确认才出队；租约内 Stop 不再投，INBOX_LEASE_MS 没确认就在回合结束时按普通消息重投
 * （message_id 不变，重复由收件方识别）。和 Stop 后的投递用同一把频道锁（held.claim）。设计稿 docs/15-inbox.md。
 */
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { AgentCallBook } from "./agent-calls.js";
import { INBOX_LEASE_MS, leaseActive, type HeldItem, type HeldQueue } from "./held-queue.js";
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

/** 一批最多这么多条、这么多字（工具结果太长模型读不全）；单条超过字数上限的不放进批里，回合结束时完整送达 */
const MAX_TAKE = 10;
const MAX_CHARS = 16_000;
const isAgentMsg = (i: HeldItem) => i.env.from.kind === "local";

type Result = { result: { n: number; text: string } } | { error: string };

/** 确认一批：这批的条目出队落盘（只认本频道、租约里记的 batchId） */
function ackBatch(d: InboxDeps, channelId: string, batchId: string): number {
  const mine = (d.held.get(channelId) ?? []).filter((i) => i.lease?.batchId === batchId);
  for (const it of mine) d.held.remove(channelId, it);
  return mine.length;
}

const PREVIEW_CHARS = 2_000;

async function entryText(d: InboxDeps, it: HeldItem, now: number): Promise<string> {
  const from = it.env.from.kind === "local" ? it.env.from.agentName || it.env.from.channelId : "?";
  const mins = Math.max(0, Math.round((now - it.heldAt) / 60_000));
  return `── 来自 ${from} · message_id=${it.env.meta.messageId} · 排队 ${mins} 分钟 ──\n${await d.render(it.env)}`;
}

function batchText(batchId: string, texts: string[], note: string, left: number): string {
  const head = `[📬 收件箱 ${batchId}：${texts.length} 条${left > 0 ? `，还有 ${left} 条` : ""}。${note}`
    + `处理完调 check_inbox({ ack: "${batchId}" }) 确认（会顺带领下一批）；${INBOX_LEASE_MS / 60_000} 分钟内不确认，这批会在你回合结束时按普通消息重新送达（message_id 不变）。答复别的 agent 用 send_to_agent。]`;
  return [head, ...texts.map((t, k) => t.replace("── 来自", `── ${k + 1}/${texts.length} · 来自`))].join("\n\n");
}

export async function takeInbox(ws: ServerWebSocket<unknown>, now = Date.now(), ack?: string): Promise<Result> {
  if (!deps) return { error: "bridge 还没初始化收件箱" };
  const d = deps;
  const channelId = [...d.clients.entries()].find(([, c]) => c.ws === ws)?.[0];
  if (!channelId) return { error: "认不出你是哪个 agent（频道没注册）" };
  if (!d.held.claim(channelId)) {
    return { result: { n: 0, text: "收件箱正在按普通消息投递给你（这一轮刚结束？），稍后就到，不用再查。" } };
  }
  try {
    const acked = ack ? ackBatch(d, channelId, ack) : 0;
    const ackNote = ack ? (acked ? `已确认 ${ack}（${acked} 条出队）。` : `${ack} 没有待确认的条目（已确认过，或租约过期后已按普通消息送达）。`) : "";
    const q = d.held.get(channelId) ?? [];
    // 没带 ack、手上还有没确认的一批（工具结果丢了 / 回合被取消 / 忘了 ack）：原样重给这批，不续租、不领新的
    const open = ack ? [] : q.filter((i) => isAgentMsg(i) && leaseActive(i, now));
    if (open.length) {
      const batchId = open[0].lease!.batchId;
      const mine = open.filter((i) => i.lease!.batchId === batchId);
      const texts = await Promise.all(mine.map((it) => entryText(d, it, now)));
      return { result: { n: mine.length, text: batchText(batchId, texts, "这是你领过还没确认的一批，原样重给。", 0) } };
    }
    const free = q.filter((i) => isAgentMsg(i) && !leaseActive(i, now));
    const picked: { it: HeldItem; text: string }[] = [];
    const previews: string[] = [];
    let chars = 0;
    for (const it of free) {
      if (picked.length >= MAX_TAKE) break;
      const text = await entryText(d, it, now);
      if (text.length > MAX_CHARS) {
        // 太长的不进批（租约只管整条）：先给开头，全文回合结束时按普通消息送达
        previews.push(`${text.slice(0, PREVIEW_CHARS)}\n…（这条共 ${text.length} 字，这里只给开头；全文在你这一轮结束时送达，不用领）`);
        continue;
      }
      if (chars + text.length > MAX_CHARS) continue; // 这批放不下的等下一批（后面短的还能放进来）
      picked.push({ it, text });
      chars += text.length;
    }
    if (!picked.length) return { result: { n: 0, text: [`${ackNote}收件箱里没有可领取的消息。`, ...previews].join("\n\n") } };
    const batchId = `inbox_${randomUUID().slice(0, 8)}`; // 毫秒会撞：同一毫秒两次领取会被绑成一批
    // 先 touch 再落租约（和押后投递同序）：落盘后、touch 前崩溃，重启时回程簿会带着旧钟被当成过期扫掉
    for (const { it } of picked) d.calls.touch(channelId, it.env.from.kind === "local" ? it.env.from.channelId : undefined); // 这些请求这会儿才真正到它手上
    for (const { it } of picked) {
      it.lease = { batchId, at: now };
      d.emitIn(channelId, it.env);
    }
    d.held.persist();
    const left = free.length - picked.length - previews.length;
    return { result: { n: picked.length, text: [batchText(batchId, picked.map((p) => p.text), ackNote, left), ...previews].join("\n\n") } };
  } finally {
    d.held.release(channelId);
  }
}
