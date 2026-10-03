/**
 * 收件箱（台账 i15，codex 复核意见「可见、可拉取的未读收件箱」）：agent 调 check_inbox，把排队给它的消息
 * （它在回合中时押在 bridge/held-queue.ts 里等 Stop 的 agent 消息、owner 消息、卡片答复、peer 消息，以及给 PM 的执行者提问通知；
 * 其余 bridge 通知和 guest 的不领，见 takeable）现在就领回来，作为工具结果交给它，执行者提问、owner 和卡片答复排在批首——
 * 走的是工具结果这条通道，不是回合开头会被静默丢掉的 channel 通知；工具结果本身也可能丢（断线 / 回合取消），所以要租约。
 *
 * 领取 = 租约，不是出队：工具结果丢了、客户端断线、回合被取消都不该丢整批（codex 2026-09-28 复核）。agent 处理完用
 * check_inbox({ ack: batchId }) 确认才出队；租约内 Stop 不再投，INBOX_LEASE_MS 没确认就在回合结束时按普通消息重投
 * （message_id 不变，重复由收件方识别）。和 Stop 后的投递用同一把频道锁（held.claim）。设计稿 docs/15-inbox.md。
 */
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type { AgentCallBook } from "./agent-calls.js";
import { emitEvent } from "./event-bus.js";
import { markIfHeldAcrossStop } from "./held-flush.js";
import { inboundEventData } from "./inbound-event.js";
import { ownedHeldItems } from "./pm-held-transfer.js";
import { heldKindOf, INBOX_LEASE_MS, inboxTakeable, leaseActive, notifyHeldSettled, type HeldItem, type HeldQueue } from "./held-queue.js";
import type { Envelope } from "./router.js";
import { inboxEntryHead } from "../lib/inbox-batch.js";

export interface InboxDeps {
  clients: Map<string, { ws: ServerWebSocket<unknown> }>;
  held: HeldQueue;
  calls: AgentCallBook;
  /** 和正常投递同一个渲染（「[🤖 来自 X]」抬头等） */
  render: (env: Envelope) => Promise<string>;
  /** 网页镜像（本机 agent 消息）：和正常投递一样画成一条入站气泡；人 / peer 的见 mirrorIn */
  emitIn: (channelId: string, env: Envelope) => void;
  /** owner 最近一次叫停的时刻（turnCuts.stoppedAt）；不给 = 按需加载 bridge/turn-cuts.ts 的单例（它读状态文件、挂 event-bus，单测注入） */
  stoppedAt?: (channelId: string) => number | undefined;
}
let deps: InboxDeps | null = null;
export function initInbox(d: InboxDeps): void {
  deps = d;
}

/** 一批最多这么多条、这么多字（工具结果太长模型读不全）；单条超过字数上限的不放进批里，回合结束时完整送达 */
const MAX_TAKE = 10;
const MAX_CHARS = 16_000;
/**
 * 给 PM 的执行者提问通知（lib/order-ask.ts 经 sendLedgerNotice 投的 ledger-ask:<askId>）：PM 在长回合里时它押到回合结束才到，
 * 远端执行者干等（i28-ASK4，C6 卡了约 20 分钟）。check_inbox 也领它，排在批首；别的 bridge 通知仍不领（班子通知要走送达回调）。
 */
const isAskNotice = (i: HeldItem): boolean =>
  i.env.from.kind === "bridge" && i.env.from.label === "ledger" && /^ledger-ask:ask_[A-Za-z0-9]+$/.test(i.env.meta.messageId ?? "");
const takeable = (i: HeldItem): boolean => inboxTakeable(i) || isAskNotice(i);

/** 执行者提问、owner 本人和卡片答复排在批首（提问最前），其余按到达顺序 */
const ownerFirst = (q: HeldItem[]): HeldItem[] => {
  const rank = (i: HeldItem) => isAskNotice(i) ? 0 : ["ask", "owner"].includes(heldKindOf(i.env)) ? 1 : 2;
  return [0, 1, 2].flatMap((r) => q.filter((i) => rank(i) === r));
};

type Result = { result: { n: number; text: string } } | { error: string };

/** 确认一批：这批的条目出队落盘（只认本频道、租约里记的 batchId），和押后投递一样报送达（网页「丢进工作台」据此标已送达） */
function ackBatch(d: InboxDeps, channelId: string, batchId: string, owned: HeldItem[]): number {
  const mine = owned.filter((i) => i.lease?.batchId === batchId);
  for (const it of mine) {
    d.held.remove(channelId, it);
    notifyHeldSettled(it.env, "delivered");
  }
  return mine.length;
}

const PREVIEW_CHARS = 2_000;
/** 正文预算：给抬头 / 分隔留 1000 字，整个工具结果不超过 MAX_CHARS；超过预算的单条只给开头 */
const BUDGET = MAX_CHARS - 1_000;
const MAX_PREVIEWS = 3;

/** 放进工具结果的一条：放得下给全文，放不下给开头 + 分页读入口（read = message_id） */
async function fitEntry(d: InboxDeps, it: HeldItem, now: number): Promise<{ text: string; long: boolean }> {
  const text = await entryText(d, it, now);
  if (text.length <= BUDGET) return { text, long: false };
  const hint = `要现在看全文用 check_inbox({ read: "${it.env.meta.messageId}" }) 分页读，否则这一轮结束时送达`;
  return { text: `${text.slice(0, PREVIEW_CHARS)}\n…（这条共 ${text.length} 字，这里只给开头；${hint}）`, long: true };
}

async function entryText(d: InboxDeps, it: HeldItem, now: number): Promise<string> {
  const from = senderLabel(it.env);
  const mins = Math.max(0, Math.round((now - it.heldAt) / 60_000));
  // 和押后补投同一个叫停抬头（held-flush.ts）：停之前押下的批准，领到时也要知道先别照做
  markIfHeldAcrossStop(it, d.stoppedAt ? d.stoppedAt(it.to.channelId) : (await import("./turn-cuts.js")).turnCuts.stoppedAt(it.to.channelId));
  const back = it.env.from.kind === "local" || isAskNotice(it) ? "" : ` · 回复用 reply，chat_id=${replyBackOf(it.env)}`;
  return `${inboxEntryHead(from, it.env.meta.messageId, mins, back)}\n${await d.render(it.env)}`; // 抬头格式和历史解析共用（lib/inbox-batch.ts）
}

/** 回程地址：和正常投递给 agent 的 chat_id 同一规则（bridge.ts resolveReplyBackChannel）——这条从哪个会话来，reply 就发回哪里 */
function replyBackOf(env: Envelope): string {
  const f = env.from;
  return f.kind === "api" ? `api:${f.tokenId}` : f.kind === "user" || f.kind === "local" ? f.channelId : "";
}

/**
 * 网页镜像：本机 agent 消息照旧走注入的 emitIn。人 / peer 的用正常投递同一份负载（inboundEventData：卡片答复的 askId / wire、附件），
 * 挂在和「排队中」标记同一个 agent 名下（bridge/held-web.ts），网页才能对上那条排队气泡摘掉标记
 */
function mirrorIn(d: InboxDeps, channelId: string, it: HeldItem): void {
  const f = it.env.from;
  if (f.kind === "local") return d.emitIn(channelId, it.env);
  const who: Record<string, string> = f.kind === "api" ? { user: f.name, user_id: `api:${f.tokenId}` } : f.kind === "user" ? { user: f.username ?? "", user_id: f.userId } : {};
  const agent = it.to.agentName || (channelId === process.env.CONTROL_CHANNEL_ID ? "master" : "");
  if (agent) emitEvent({ agent, chatId: channelId, type: "chat_message", data: inboundEventData(it.env, who) });
}

function senderLabel(env: Envelope): string {
  const f = env.from;
  if (f.kind === "local") return f.agentName || f.channelId;
  if (f.kind === "bridge" && f.label === "ledger") return "台账（执行者提问）";
  const kind = heldKindOf(env);
  if (kind === "ask") return "owner 的卡片答复";
  if (kind === "owner") return "owner";
  return f.kind === "api" ? `peer ${f.peer}` : "?";
}

function batchText(batchId: string, texts: string[], note: string, left: number): string {
  const head = `[📬 收件箱 ${batchId}：${texts.length} 条${left > 0 ? `，还有 ${left} 条` : ""}。${note}`
    + `处理完调 check_inbox({ ack: "${batchId}" }) 确认（会顺带领下一批）；${INBOX_LEASE_MS / 60_000} 分钟内不确认，这批会在你回合结束时按普通消息重新送达（message_id 不变）。答复别的 agent 用 send_to_agent，答复 owner / peer 用各条抬头里给的 chat_id 调 reply。]`;
  return [head, ...texts.map((t, k) => t.replace("── 来自", `── ${k + 1}/${texts.length} · 来自`))].join("\n\n");
}

const PAGE_CHARS = 12_000;

/** 分页读一条（太长进不了批的）：第一次读就给它单独打租约，读完照样 ack 确认，全文不会在回合结束时再投一遍 */
async function readPaged(d: InboxDeps, channelId: string, readId: string, page: number, now: number, owned: HeldItem[]): Promise<Result> {
  const q = owned.filter(takeable);
  // 也认 thread_id：旧版的分页读入口给的是 thread_id，agent 手里可能还拿着
  const it = q.find((i) => i.env.meta.messageId === readId) ?? q.find((i) => i.env.meta.threadId === readId);
  if (!it) return { result: { n: 0, text: `收件箱里没有 ${readId}（已确认过，或已按普通消息送达）。` } };
  const { messageId } = it.env.meta;
  if (!leaseActive(it, now)) {
    d.calls.touchDelivered(channelId, it.env);
    it.lease = { batchId: `inbox_${randomUUID()}`, at: now };
    d.held.persist();
  }
  const text = await entryText(d, it, now);
  const pages = Math.max(1, Math.ceil(text.length / PAGE_CHARS));
  const p = Math.min(Math.max(1, Math.floor(page)), pages);
  // 翻页沿用传进来的 readId：旧格式 id 可能撞号，拿 thread_id 读的换成 message_id 会串到另一封
  const next = p < pages ? `下一页 check_inbox({ read: "${readId}", page: ${p + 1} })；` : "";
  const head = `[📬 message_id=${messageId} 第 ${p}/${pages} 页。${next}读完处理后调 check_inbox({ ack: "${it.lease!.batchId}" }) 确认。]`;
  return { result: { n: 1, text: `${head}\n\n${text.slice((p - 1) * PAGE_CHARS, p * PAGE_CHARS)}` } };
}

interface TakeOpts {
  ack?: string;
  /** 分页读某一条（message_id） */
  read?: string;
  page?: number;
}

/** bridge ws 请求 → takeInbox 选项（类型不对的字段忽略） */
export function inboxOpts(msg: { ack?: unknown; read?: unknown; page?: unknown }): TakeOpts {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return { ack: str(msg.ack), read: str(msg.read), page: typeof msg.page === "number" ? msg.page : undefined };
}

export async function takeInbox(ws: ServerWebSocket<unknown>, now = Date.now(), opts: TakeOpts = {}): Promise<Result> {
  const { ack } = opts;
  if (!deps) return { error: "bridge 还没初始化收件箱" };
  const d = deps;
  const channelId = [...d.clients.entries()].find(([, c]) => c.ws === ws)?.[0];
  if (!channelId) return { error: "认不出你是哪个 agent（频道没注册）" };
  if (!d.held.claim(channelId)) {
    return { result: { n: 0, text: "收件箱正在按普通消息投递给你（这一轮刚结束？），稍后就到，不用再查。" } };
  }
  try {
    const owned = ownedHeldItems(d.held, channelId); // 归并先于读正文/重领租约/ack；证据不足的条目保留待诊断
    if (opts.read) return await readPaged(d, channelId, opts.read, opts.page ?? 1, now, owned);
    const acked = ack ? ackBatch(d, channelId, ack, owned) : 0;
    const ackNote = ack ? (acked ? `已确认 ${ack}（${acked} 条出队）。` : `${ack} 没有待确认的条目（已确认过，或租约过期后已按普通消息送达）。`) : "";
    const q = owned.filter((i) => d.held.get(channelId)?.includes(i));
    // 没带 ack、手上还有没确认的一批（工具结果丢了 / 回合被取消 / 忘了 ack）：原样重给这批，不续租、不领新的
    const open = ack ? [] : q.filter((i) => takeable(i) && leaseActive(i, now));
    if (open.length) {
      const batchId = open[0].lease!.batchId;
      const mine = open.filter((i) => i.lease!.batchId === batchId);
      const texts = (await Promise.all(mine.map((it) => fitEntry(d, it, now)))).map((e) => e.text); // 超长的仍只给开头，不绕过预算
      return { result: { n: mine.length, text: batchText(batchId, texts, "这是你领过还没确认的一批，原样重给。", 0) } };
    }
    const free = ownerFirst(q.filter((i) => takeable(i) && !leaseActive(i, now)));
    const picked: { it: HeldItem; text: string }[] = [];
    const previews: string[] = [];
    let chars = 0;
    for (const it of free) {
      if (picked.length >= MAX_TAKE) break;
      const { text, long } = await fitEntry(d, it, now);
      if (chars + text.length > BUDGET) continue; // 这批放不下的等下一批（后面短的还能放进来）
      if (long) {
        // 太长的不进批（租约只管整条）：只给开头，计入预算、最多几条；全文分页读或回合结束时送达
        if (previews.length < MAX_PREVIEWS) {
          previews.push(text);
          chars += text.length;
        }
        continue;
      }
      picked.push({ it, text });
      chars += text.length;
    }
    if (!picked.length) return { result: { n: 0, text: [`${ackNote}收件箱里没有可领取的消息。`, ...previews].join("\n\n") } };
    const batchId = `inbox_${randomUUID()}`; // 毫秒会撞：同一毫秒两次领取会被绑成一批
    // 先 touch 再落租约（和押后投递同序）：落盘后、touch 前崩溃，重启时回程簿会带着旧钟被当成过期扫掉
    for (const { it } of picked) d.calls.touchDelivered(channelId, it.env); // 这些请求这会儿才真正到它手上
    for (const { it } of picked) {
      it.lease = { batchId, at: now };
      mirrorIn(d, channelId, it);
    }
    d.held.persist();
    const left = free.length - picked.length - previews.length;
    return { result: { n: picked.length, text: [batchText(batchId, picked.map((p) => p.text), ackNote, left), ...previews].join("\n\n") } };
  } finally {
    d.held.release(channelId);
  }
}
