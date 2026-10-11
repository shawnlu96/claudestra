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
import { markIfHeldAcrossStop, setHeldRender } from "./held-flush.js";
import { inboundEventData } from "./inbound-event.js";
import { ownedHeldItems } from "./pm-held-transfer.js";
import { heldKindOf, INBOX_LEASE_MS, inboxTakeable, leaseActive, type HeldItem, type HeldQueue } from "./held-queue.js";
import type { Envelope } from "./router.js";
import {
  INBOX_BUDGET as BUDGET, INBOX_MAX_PREVIEWS as MAX_PREVIEWS, INBOX_MAX_TAKE as MAX_TAKE, INBOX_PREVIEW_CHARS as PREVIEW_CHARS, inboxEntryHead, inboxPreviewTail,
} from "../lib/inbox-batch.js";
import { idleNoticeIdentity, isHeldAskNotice as isAskNotice, isInternalIdleNotice } from "../lib/held-idle-batch.js";
import { gatesAsHuman } from "../lib/quota-wall.js";

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
  /** 这个频道此刻在额度闸里（同 FlushDeps.walled）；不给 = 按需加载 bridge/quota-wall-wiring.ts 的闸，bridge 没起闸 = 不在 */
  walled?: (channelId: string) => Promise<boolean>;
}
let deps: InboxDeps | null = null;
export function initInbox(d: InboxDeps): void {
  deps = d;
  setHeldRender(d.render); // 押后批次投递（held-flush.ts）逐条用同一个渲染
}

/**
 * 一批的条数 / 字数上限在 lib/inbox-batch.ts（押后批次投递共用）；单条超过字数上限的不放进批里，回合结束时完整送达。
 *
 * 给 PM 的执行者提问通知（lib/order-ask.ts 经 sendLedgerNotice 投的 ledger-ask:<askId>）：PM 在长回合里时它押到回合结束才到，
 * 远端执行者干等（i28-ASK4，C6 卡了约 20 分钟）。check_inbox 也领它，排在批首；别的 bridge 通知仍不领（班子通知要走送达回调）。
 */
const takeable = (d: InboxDeps, i: HeldItem, now: number): boolean =>
  d.held.idleInboxAllowed(i, now) ?? (inboxTakeable(i) || isAskNotice(i));

/**
 * 领内部通知之前实时核一次额度闸，在闸里就照 flushHeld 把押着的非人类消息改记成额度闸（之后 idleInboxAllowed 不放行）：闸刚开时
 * 押着的还没被 flush 改记，只看条目上的历史 reason 会把它们领走、ack 出队，绕过闸。批次开关没开时内部通知本来就不领，
 * 不查也不多等一拍（旧路径的时序不变）。调用处之后到落租约之间不能再有 await
 */
async function markWallNow(d: InboxDeps, channelId: string): Promise<void> {
  const walled = d.walled ? await d.walled(channelId) : !!(await (await import("./quota-wall-wiring.js")).quotaWall()?.gates(channelId));
  if (walled) d.held.markWall(channelId, (i) => !gatesAsHuman(i.env));
}

/**
 * 最后一个 await 之后再核一次归属（同开头的 ownedHeldItems）：渲染 / 核闸期间 owner 切了 PM，角色通知就归当班 PM 了，
 * 旧 PM 领走会给它打上租约、挡住转交。调用处之后到落租约 / 返回之间不能再有 await
 */
function ownsNow(d: InboxDeps, channelId: string): (i: HeldItem) => boolean {
  const mine = new Set(ownedHeldItems(d.held, channelId));
  return (i) => mine.has(i);
}

/**
 * 同一条内部通知重复入队的几份只给一条（判据同押后批次，lib/held-idle-batch.ts idleNoticeIdentity），别的几份跟着它进同一份租约、
 * ack 时一起出队各报送达。只在批次开关开着时认；别的类别同 id 也是两封（同一条消息上的两次按钮点击）
 */
function dedupeNotices(d: InboxDeps, items: readonly HeldItem[]): { shown: HeldItem[]; twins: Map<HeldItem, HeldItem[]> } {
  const shown: HeldItem[] = [], twins = new Map<HeldItem, HeldItem[]>(), seen = new Map<string, HeldItem>();
  const on = d.held.idleMode() === "on";
  for (const it of items) {
    const key = on && isInternalIdleNotice(it) ? idleNoticeIdentity(it) : undefined, first = key === undefined ? undefined : seen.get(key);
    if (first) {
      twins.get(first)!.push(it);
      continue;
    }
    if (key !== undefined) seen.set(key, it);
    twins.set(it, []);
    shown.push(it);
  }
  return { shown, twins };
}

/** 重复的那几份跟着领走的这一条进同一份租约；网页镜像只画领走的那一条 */
function leaseTwins(d: InboxDeps, channelId: string, twins: readonly HeldItem[], batchId: string, now: number): void {
  for (const t of twins) {
    d.calls.touchDelivered(channelId, t.env);
    d.held.inboxLease(t, batchId, now);
    t.inboxMirrorBatch = batchId;
  }
}

/** 执行者提问、owner 本人和卡片答复排在批首（提问最前），其余按到达顺序 */
const ownerFirst = (q: HeldItem[]): HeldItem[] => {
  const rank = (i: HeldItem) => isAskNotice(i) ? 0 : ["ask", "owner"].includes(heldKindOf(i.env)) ? 1 : 2;
  return [0, 1, 2].flatMap((r) => q.filter((i) => rank(i) === r));
};

type Result = { result: { n: number; text: string } } | { error: string };

/** 确认一批：这批的条目出队落盘（只认本频道、租约里记的 batchId），和押后投递一样报送达（网页「丢进工作台」据此标已送达） */
function ackBatch(d: InboxDeps, channelId: string, batchId: string, owned: HeldItem[]): number {
  const mine = owned.filter((i) => i.lease?.batchId === batchId && d.held.inboxAckable(i));
  for (const it of mine) mirrorLeased(d, channelId, it);
  for (const it of mine) {
    d.held.remove(channelId, it);
    d.held.inboxDelivered(channelId, it);
  }
  return mine.length;
}

/** Persist each successful mirror with its lease so a partial failure/restart can retry the missing suffix. */
function mirrorLeased(d: InboxDeps, channelId: string, it: HeldItem): void {
  if (!it.lease || it.inboxMirrorBatch === it.lease.batchId) return;
  mirrorIn(d, channelId, it);
  it.inboxMirrorBatch = it.lease.batchId;
  d.held.persist();
}

function ackNote(owned: HeldItem[], batchId: string | undefined, acked: number): string {
  if (!batchId) return "";
  if (acked) return `已确认 ${batchId}（${acked} 条出队）。`;
  return owned.some((i) => i.lease?.batchId === batchId)
    ? `${batchId} 权限无法核对，消息仍保留待重投。`
    : `${batchId} 没有待确认的条目（已确认过，或租约过期后已按普通消息送达）。`;
}

/** 放进工具结果的一条：放得下给全文，放不下给开头 + 分页读入口（read = message_id） */
async function fitEntry(d: InboxDeps, it: HeldItem, now: number): Promise<{ text: string; long: boolean }> {
  const text = await entryText(d, it, now);
  if (text.length <= BUDGET) return { text, long: false };
  return { text: `${text.slice(0, PREVIEW_CHARS)}${inboxPreviewTail(text.length, it.env.meta.messageId)}`, long: true };
}

async function entryText(d: InboxDeps, it: HeldItem, now: number): Promise<string> {
  const from = senderLabel(it.env);
  const mins = Math.max(0, Math.round((now - it.heldAt) / 60_000));
  // 和押后补投同一个叫停抬头（held-flush.ts）：停之前押下的批准，领到时也要知道先别照做
  markIfHeldAcrossStop(it, d.stoppedAt ? d.stoppedAt(it.to.channelId) : (await import("./turn-cuts.js")).turnCuts.stoppedAt(it.to.channelId));
  const back = ["local", "bridge"].includes(it.env.from.kind) ? "" : ` · 回复用 reply，chat_id=${replyBackOf(it.env)}`;
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
  if (isAskNotice({ env })) return "台账（执行者提问）";
  if (f.kind === "bridge") return `bridge:${f.label ?? "?"}`;
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
  const reader = d.clients.get(channelId)?.ws;
  if (d.held.idleMode() === "on") await markWallNow(d, channelId);
  const q = owned.filter((i) => d.held.get(channelId)?.includes(i) && takeable(d, i, now));
  // 也认 thread_id：旧版的分页读入口给的是 thread_id，agent 手里可能还拿着
  const it = q.find((i) => i.env.meta.messageId === readId) ?? q.find((i) => i.env.meta.threadId === readId);
  if (!it) return { result: { n: 0, text: `收件箱里没有 ${readId}（已确认过，或已按普通消息送达）。` } };
  const { messageId } = it.env.meta;
  const text = await entryText(d, it, now);
  if (d.held.idleMode() === "on") await markWallNow(d, channelId); // 渲染的 await 期间可能刚进闸：落租约前再核
  const owns = ownsNow(d, channelId);
  if (d.clients.get(channelId)?.ws !== reader || !owns(it) || !d.held.get(channelId)?.includes(it) || !takeable(d, it, now)) {
    return { error: "消息归属、会话或内部通知权限已改变，保留待重读。" };
  }
  if (!leaseActive(it, now)) {
    const batchId = `inbox_${randomUUID()}`;
    // 重复的几份只认和这一条同一权限分区的（同批领取的 inboxPartition），别的分区的同样通知留着各自领
    const dups = (dedupeNotices(d, d.held.inboxPartition([it, ...q.filter((i) => i !== it)], now)).twins.get(it) ?? [])
      .filter((i) => owns(i) && d.held.get(channelId)?.includes(i) && takeable(d, i, now) && !leaseActive(i, now));
    d.calls.touchDelivered(channelId, it.env);
    d.held.inboxLease(it, batchId, now);
    leaseTwins(d, channelId, dups, batchId, now);
    d.held.persist();
  }
  mirrorLeased(d, channelId, it);
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
    const note = ackNote(owned, ack, acked);
    if (d.held.idleMode() === "on") await markWallNow(d, channelId);
    const q = owned.filter((i) => d.held.get(channelId)?.includes(i));
    // 没带 ack、手上还有没确认的一批（工具结果丢了 / 回合被取消 / 忘了 ack）：原样重给这批，不续租、不领新的
    const open = ack ? [] : q.filter((i) => takeable(d, i, now) && leaseActive(i, now));
    if (open.length) {
      const batchId = open[0].lease!.batchId;
      const mine = open.filter((i) => i.lease!.batchId === batchId);
      const { shown } = dedupeNotices(d, mine); // 重复入队的几份领的时候就只给了一条
      const texts = (await Promise.all(shown.map((it) => fitEntry(d, it, now)))).map((e) => e.text); // 超长的仍只给开头，不绕过预算
      // 渲染的 await 期间可能刚进闸、PM 可能已切走：返回工具结果前和新领一样实时核闸、重核归属
      if (d.held.idleMode() === "on") await markWallNow(d, channelId);
      const owns = ownsNow(d, channelId);
      if (d.clients.get(channelId)?.ws !== ws || mine.some((i) => !owns(i) || !d.held.get(channelId)?.includes(i) || !takeable(d, i, now))) {
        return { error: "消息归属、会话或内部通知权限已改变，保留待重读。" };
      }
      for (const it of shown) mirrorLeased(d, channelId, it);
      return { result: { n: shown.length, text: batchText(batchId, texts, "这是你领过还没确认的一批，原样重给。", 0) } };
    }
    const free = ownerFirst(q.filter((i) => takeable(d, i, now) && !leaseActive(i, now)));
    let pending = free;
    const picked: { it: HeldItem; text: string }[] = [];
    const previews: { it: HeldItem; text: string }[] = [];
    const twins = new Map<HeldItem, HeldItem[]>();
    let chars = 0;
    // A preview or one broken entry must not hide a later authority partition; only one partition receives a lease.
    while (pending.length && !picked.length) {
      const partition = d.held.inboxPartition(pending, now);
      const dedup = dedupeNotices(d, partition);
      for (const [k, v] of dedup.twins) twins.set(k, v);
      for (const it of dedup.shown) {
        if (picked.length >= MAX_TAKE) break;
        let entry: Awaited<ReturnType<typeof fitEntry>>;
        try { entry = await fitEntry(d, it, now); }
        catch (e) { console.error(`⚠️ 收件箱单条渲染失败，原消息保留: ${String(e)}`); continue; }
        const { text, long } = entry;
        if (chars + text.length > BUDGET) continue; // 这批放不下的等下一批（后面短的还能放进来）
        if (long) {
          // 太长的不进批（租约只管整条）：只给开头，计入预算、最多几条；全文分页读或回合结束时送达
          if (previews.length < MAX_PREVIEWS) {
            previews.push({ it, text });
            chars += text.length;
          }
          continue;
        }
        picked.push({ it, text });
        chars += text.length;
      }
      pending = pending.filter((i) => !partition.includes(i));
    }
    // Rendering awaits can cross a human preemption, session replacement, permission change or a quota wall opening. Recheck before leasing.
    if (d.held.idleMode() === "on") await markWallNow(d, channelId);
    if (d.clients.get(channelId)?.ws !== ws) return { error: "收件箱会话连接已改变，原消息保留。" };
    const owns = ownsNow(d, channelId);
    const stillFree = (it: HeldItem) => owns(it) && !!d.held.get(channelId)?.includes(it) && takeable(d, it, now);
    const live = picked.filter(({ it }) => stillFree(it) && !leaseActive(it, now));
    const dups = live.flatMap(({ it }) => twins.get(it) ?? []).filter((it) => stillFree(it) && !leaseActive(it, now));
    const livePreviews = previews.filter(({ it }) => stillFree(it)).map((p) => p.text);
    if (!live.length) return { result: { n: 0, text: [`${note}收件箱里没有可领取的消息。`, ...livePreviews].join("\n\n") } };
    const batchId = `inbox_${randomUUID()}`; // 毫秒会撞：同一毫秒两次领取会被绑成一批
    // 先 touch 再落租约（和押后投递同序）：落盘后、touch 前崩溃，重启时回程簿会带着旧钟被当成过期扫掉
    for (const { it } of live) d.calls.touchDelivered(channelId, it.env); // 这些请求这会儿才真正到它手上
    for (const { it } of live) {
      d.held.inboxLease(it, batchId, now);
    }
    leaseTwins(d, channelId, dups, batchId, now);
    d.held.persist();
    for (const { it } of live) mirrorLeased(d, channelId, it);
    const left = free.length - live.length - dups.length - livePreviews.length;
    return { result: { n: live.length, text: [batchText(batchId, live.map((p) => p.text), note, left), ...livePreviews].join("\n\n") } };
  } catch (e) {
    console.error(`⚠️ 收件箱结果不明，保留未确认消息: ${String(e)}`);
    return { error: "收件箱读取结果不明，未确认的消息仍在队列中，请重读。" };
  } finally {
    d.held.release(channelId);
  }
}
