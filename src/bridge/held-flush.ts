/**
 * 押后队列的投递（Stop / 压缩结束 / 每分钟扫描时调）：从 bridge.ts 挪出来、依赖全注入，好让 tests/held-flush.test.ts
 * 把「投到一半目标又忙」「await 期间条目被别处摘掉」这些交错场景跑一遍（codex 2026-09-28 复核要求的集成测试）。
 * 规则：压缩中不投；目标在回合中只投人类消息（它们只因「别掐压缩」被押）；check_inbox 租约内的不投；
 * 投出去之后才出队；目标又忙就停，原条目留着、计时不变；每个频道同一时刻只有一个投递者（held.claim）。
 * owner 本人消息和卡片答复押满 OWNER_HELD_MAX_MS 的例外见 ownerLate。
 * 内部通知的批次投递（开关 CLAUDESTRA_HELD_IDLE_BATCH，缺省只观察）见 releaseIdleBatch。
 */
import { isOwnerSource } from "../lib/delegate-marker.js";
import { gatesAsHuman } from "../lib/quota-wall.js";
import { tmuxCapture } from "../lib/tmux-helper.js";
import { inputBox } from "../lib/turn-state.js";
import { heldAcrossStopNote } from "../lib/turn-cuts.js";
import { heldKindOf, isDerivedCarrier, leaseActive, notifyHeldSettled, setHeldIdleDefault, type HeldIdleControl, type HeldItem, type HeldQueue } from "./held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";
import { resolveTurnWindow } from "./turn-probe.js";
import { noteDelivered, senderTrigger, turnStartedAt } from "./stop-settle.js";
import { getAgentStatus } from "./event-bus.js";
import { readRegistryAgentsSync, type RegistryAgent } from "../lib/registry.js";
import { fitIdleBatch, HELD_IDLE_CARRIER_LABEL, heldIdleCarrierId, heldIdleMode, registryIdleScope, type HeldIdleBatch } from "../lib/held-idle-batch.js";
import {
  HELD_AGENT_BATCH_HINT, HELD_AGENT_BATCH_TITLE, heldIdleBatchText, INBOX_BUDGET, INBOX_MAX_CHARS, INBOX_MAX_PREVIEWS, INBOX_MAX_TAKE, INBOX_PREVIEW_CHARS, inboxPreviewTail,
} from "../lib/inbox-batch.js";
import { controlFor } from "../lib/runtimes/index.js";
import { agentBatchMembers, heldAgentBatchOn, isAgentBatchable } from "../lib/held-agent-batch.js";
import { adoptStrandedTransfers, currentPmTarget, expectPmTarget, handedOver, roleHandoffs, shouldRetry, type PmTarget } from "./pm-held-transfer.js";

export interface FlushDeps {
  held: HeldQueue;
  compacting: (agent: string) => boolean;
  working: (channelId: string, agent: string) => Promise<boolean>;
  isHumanRequest: (env: Envelope) => boolean;
  /** 这个频道当前的连接；不在线 = undefined */
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  /** stillWanted：投递途中最后一刻再核对这条还在队里（被 kill 清理 / 放弃摘掉的就不发、不押回） */
  deliver: (env: Envelope, to: LocalEndpoint, stillWanted?: () => boolean) => Promise<Delivery>;
  /** 这个频道在额度闸里（bridge/quota-wall.ts）：只投能穿闸的（gatesAsHuman），其余留着等出闸补投——否则每分钟扫描都投一次、再被押回来 */
  walled?: (channelId: string) => Promise<boolean>;
  /** 回程簿失效钟从真正送达起算（只动这封消息发送方那一槽） */
  touch: (channelId: string, env: Envelope) => void;
  /** owner 最近一次叫停这个频道的时刻（bridge/turn-cuts.ts stoppedAt）；押在它之前的条目投出去时加抬头 */
  stoppedAt?: (channelId: string) => number | undefined;
  /** 画面真静下来了（外人的消息投之前看）；不给 = 隔 1.5 秒抓两次屏比输入框以上（paneSettled） */
  settled?: (channelId: string) => Promise<boolean>;
  /** 这个频道当前这一轮的开启时刻（stop-settle 的 turnTrigger；Stop / 打断就没了）；不给 = turnStartedAt */
  turnAt?: (channelId: string) => number | undefined;
  /** 算 owner 答复押了多久的钟；不给 = Date.now（租约照旧按真钟） */
  now?: () => number;
  /** 批次里每条的正文渲染（和正常投递同一个）；不给 = initInbox 交来的那个，都没有就不走批次 */
  render?: (env: Envelope) => Promise<string>;
  /** agent 消息合批开没开（lib/held-agent-batch.ts）；不给 = 每次现读环境变量 */
  agentBatch?: () => boolean;
  /** 合批送达的本机 agent 消息逐条补的网页入站镜像；不给 = initInbox 交来的那个 */
  mirror?: (channelId: string, env: Envelope) => void;
}

/**
 * owner 本人消息和卡片答复押满这么久，下一次扫描直接投：不再等画面静止、不看这一轮是谁开的、排在外人前面——
 * 一直有后台任务 / Monitor 在出字的会话（PM）等不到 Stop、画面也静不下来，答复会押上几个小时。压缩中、check_inbox 租约内仍不投
 */
export const OWNER_HELD_MAX_MS = 2 * 60_000;
/**
 * 押满时限的 owner 答复。owner 带 waitForIdle 的别的消息（fleet 群发）不算：它承诺过不抢占也不插进回合，清掉标记就成了抢占的 request。
 * 卡片答复是 response，清掉 waitForIdle 也不会抢占（router.ts isHumanRequest），flushHeld 投之前清掉，否则 deliverToLocal 又把它押回来
 */
export function ownerLate(i: HeldItem, now: number): boolean {
  const k = heldKindOf(i.env);
  const owns = k === "ask" ? i.env.intent !== "request" : k === "owner" && !i.env.meta.waitForIdle;
  return owns && now - i.heldAt >= OWNER_HELD_MAX_MS;
}

const SETTLE_GAP_MS = 1_500;
/** 输入框以上的内容（正文区）；认不出输入框 = null */
function aboveBox(pane: string): string | null {
  const lines = pane.replace(/\s+$/, "").split("\n");
  const b = inputBox(lines);
  return b ? lines.slice(0, b.top).join("\n") : null;
}
/**
 * CC 流式出正文时画面上没有 spinner、事件态也还是上一轮的 done（沙箱实测：到点自己续跑的那一轮整轮都这样），判忙看不出它在跑。
 * 外人的消息投进去就混进这一轮（adv3 P2-1）：投之前隔 1.5 秒抓两次屏，正文区在变 = 还在出字，等下一次触发（Stop / 扫描）
 */
async function paneSettled(channelId: string): Promise<boolean> {
  const { win, runtime } = await resolveTurnWindow(channelId, process.env.CONTROL_CHANNEL_ID || "");
  if (!controlFor(runtime).paneHeuristics) return true; // Codex / Pi 的界面认不出输入框：按老规矩（判忙说闲就投），不然外人的永远投不出去
  if (!win) return false;
  const a = aboveBox(await tmuxCapture(win, 60));
  await Bun.sleep(SETTLE_GAP_MS);
  return a !== null && a === aboveBox(await tmuxCapture(win, 60));
}

/**
 * 押在叫停之前、叫停之后才投出去的（忙时作答的 ask 答复、agent 请求）：加一行抬头「停之前发的，先别照做，问用户还要不要」——
 * 不加的话 agent 看到的顺序是「停之后 owner 又批准了」，会照做（wf2 classify-merge-1）。bridge 自己的通知不加（收尾提醒另有作废规则）。
 * check_inbox 领取时同样要加（bridge/inbox.ts）。
 */
export function markIfHeldAcrossStop(item: HeldItem, stopAt: number | undefined): void {
  const m = item.env.meta;
  if (stopAt && item.heldAt < stopAt && item.env.from.kind !== "bridge" && !m.interruptNote) m.interruptNote = heldAcrossStopNote(item.heldAt, stopAt);
}

/** 发送人：同一个人（同一个 token / Discord 用户 / agent 频道）连着的几条可以进同一轮 */
function senderOf(env: Envelope): string {
  const f = env.from;
  return f.kind === "api" ? `api:${f.tokenId}` : f.kind === "user" ? `user:${f.userId}` : f.kind === "local" ? `local:${f.channelId}` : f.kind;
}
/**
 * 频道 → 这一轮是补投谁的消息开的，连同那一轮的开启时刻：在跑的这一轮不是他开的，他押着的就等它结束。时刻对不上当前这一轮
 * （Stop、打断之后开了别的一轮，队列空时 flush 提前返回、清不到这里）就作废（tests/held-flush.test.ts 遗留记录那条）
 */
const openedBy = new Map<string, { who: string; at: number | undefined }>();
/** 单测之间清掉（生产里目标一空闲就清） */
export const clearOpenedBy = (): void => openedBy.clear();

/** 本机 agent / bridge 以外的（人、guest、peer）：各自开一轮，不和别人混 */
const outsider = (env: Envelope): boolean => senderTrigger(env.from) !== "insider";

/**
 * 这一条能不能在这一趟接着投（跨 principal 串话）：外人的消息一轮只投一个发送人的，不同发送人各自开一轮、按到达顺序排——
 * 冷却期不抢占、Stop 兜底会结掉该频道所有 waiter，混投一轮 guest / 另一个 peer 就拿到答给别人的话。peer 按 principal 算外人
 * （它不算「人类消息」，但撞墙期间押得最多）。在跑的一轮不是补投开的（CC 到点自己续跑、别处送进来的）：外人的不塞进去，owner 的
 * 照常抢占。只有本机 agent / bridge 消息的一趟照旧一起投
 */
async function mayJoin(d: FlushDeps, item: HeldItem, channelId: string, working: boolean, first: HeldItem | undefined, late: boolean): Promise<boolean> {
  const who = senderOf(item.env);
  if (first && (outsider(item.env) || outsider(first.env)) && senderOf(first.env) !== who) return false;
  if (!outsider(item.env) || late) return true;
  const rec = openedBy.get(channelId);
  const opener = rec && rec.at === (d.turnAt ?? turnStartedAt)(channelId) ? rec.who : undefined;
  if (working) return opener ? opener === who : isOwnerSource(item.env.from);
  // 判成空闲、这一趟还没投过：外人的再确认画面静下来了（流式出字时判不出忙）；同一个人紧跟着的几条不用再看
  if (isOwnerSource(item.env.from) || first) return true;
  if (await (d.settled ?? paneSettled)(channelId).catch(() => false)) return true; // 抓屏出错按没静下来：留在队里等 Stop / 下一次扫描
  console.log(`⏸ 押着的外人消息先不投：${item.to.agentName || channelId} 画面还在变（多半在出字），等 Stop / 下一次扫描`);
  return false;
}

/** 押后日志里的来源：agent 名、bridge:<label>（班子通知是 bridge:ledger），其余照 kind */
const fromLabel = (env: Envelope): string => (env.from.kind === "local" ? (env.from.agentName ?? "?") : env.from.kind === "bridge" ? `bridge:${env.from.label ?? "?"}` : env.from.kind);

type DeliveredHook = (channelId: string, env: Envelope) => void;
const deliveredHooks: DeliveredHook[] = [];

/** 押后消息真正送达（sent 且不是又押回）之后的回调：班子通知这时才标消息来源（bridge/team-router.ts） */
export function onHeldDelivered(fn: DeliveredHook): void {
  deliveredHooks.push(fn);
}

/** 同一段同步代码里注册表只读一次（一趟要判很多条）；过了 await 就重读，不拿旧会话放行 */
let rowsMemo: RegistryAgent[] | undefined;
function registryRows(): RegistryAgent[] {
  if (rowsMemo) return rowsMemo;
  queueMicrotask(() => { rowsMemo = undefined; });
  return (rowsMemo = readRegistryAgentsSync());
}
/** 内部通知都出自本机这一位 owner 的 bridge / agent（人、peer、guest 不属于这一类），owner 一栏是常量 */
const LOCAL_OWNER = "local-owner";

/**
 * 没有显式配置的押后队列（生产的 heldLocalMsgs）用它：开关读环境变量（每次现读），会话 / 项目证明读注册表，压缩中不领不投，
 * 送达回调就是 onHeldDelivered 登记的那些（班子通知标消息来源）。额度闸、叫停、会话更换在投递层逐次再核，这里不重复；
 * check_inbox 不过投递层，额度闸由它自己在领取处实时核（bridge/inbox.ts markWallNow）
 */
export function productionIdleControl(env: Record<string, string | undefined> = process.env, rows: () => RegistryAgent[] = registryRows): HeldIdleControl {
  return {
    get mode() { return heldIdleMode(env); },
    scope: (item) => registryIdleScope(item, rows(), LOCAL_OWNER),
    canTake: (item) => getAgentStatus(item.to.agentName || item.to.channelId) !== "compacting",
    delivered: (channelId, e) => { for (const fn of deliveredHooks) fn(channelId, e); },
  };
}
setHeldIdleDefault(() => productionIdleControl());

let heldRender: FlushDeps["render"];
let heldMirror: FlushDeps["mirror"];
/** initInbox 交来的渲染（bridge.ts 的 renderContentForLocal）和本机 agent 消息的网页入站镜像 */
export function setHeldRender(render: FlushDeps["render"], mirror?: FlushDeps["mirror"]): void {
  heldRender = render;
  heldMirror = mirror;
}

/**
 * 一封载体带走的一组：内部通知批次（权限分组，开关 CLAUDESTRA_HELD_IDLE_BATCH）或押后 agent 消息合批（HMB-1，
 * 开关 CLAUDESTRA_HELD_AGENT_BATCH）。两者只在最后一查、送达回调、批首文字、网页镜像上不同，载体本身同一套
 */
interface CarrierBatch {
  items: HeldItem[];
  expectSession?: string;
  /** 投递层所有 await 之后的最后一查：shown 每条仍该由这封载体带走 */
  wanted: (shown: readonly HeldItem[]) => () => boolean;
  /** 真送达后逐条的送达回调 */
  delivered: (channelId: string, env: Envelope) => void;
  title?: string;
  hint?: string;
  /** 逐条补网页入站镜像（agent 消息逐条投递时 deliverToLocal 画，载体代它们画） */
  mirror?: boolean;
}

const idleCarrier = (d: FlushDeps, channelId: string, b: HeldIdleBatch<HeldItem>): CarrierBatch => ({
  items: b.items, expectSession: b.scope.sessionId, wanted: (shown) => d.held.idleBatchWanted(channelId, b, shown),
  delivered: (c, e) => d.held.idleDelivered(c, e),
});

/**
 * 这个边界要合批送出的 agent 消息（目标空闲才调）：到期、不是交给当班 PM 的、没进内部通知批次的本机 agent 消息。
 * 最后一查只看开关、还在队里、没被 check_inbox 领走——会话 / 额度闸 / 撤下守卫在投递层对载体再核一遍（同内部通知批次）
 */
function agentCarrier(d: FlushDeps, channelId: string, due: readonly HeldItem[], taken: ReadonlySet<HeldItem>): CarrierBatch | undefined {
  const on = d.agentBatch ?? (() => heldAgentBatchOn());
  if (!on()) return undefined;
  const m = agentBatchMembers(due.filter((i) => !taken.has(i) && heldKindOf(i.env) === "agent" && isAgentBatchable(i)));
  if (!m.items.length) return undefined;
  return {
    items: m.items, expectSession: m.expectSession, title: HELD_AGENT_BATCH_TITLE, hint: HELD_AGENT_BATCH_HINT, mirror: true,
    wanted: (shown) => () => on() && shown.every((i) => !!d.held.get(channelId)?.includes(i) && !leaseActive(i)),
    delivered: (c, e) => { for (const fn of deliveredHooks) fn(c, e); },
  };
}

/**
 * 队里残留的派生载体（崩溃前没摘的、别处押进来的）：摘掉并报作罢（PM 摘要随它带着的条目回队），原条目原样留着。
 * 这一趟自己放进去的那封由 releaseIdleBatch 投完当场摘。真送出去之后被退回的不在此列（held-queue.ts holdFirst：复原成原条目，复原不了的标 returned 留着）
 */
function dropCarriers(held: HeldQueue, channelId: string): void {
  const q = held.get(channelId) ?? [], strays = q.filter(isDerivedCarrier);
  if (!strays.length) return;
  held.set(channelId, q.filter((i) => !isDerivedCarrier(i)));
  for (const s of strays) notifyHeldSettled(s.env, "discarded");
}

/**
 * 同一目标会话 / 项目 / 权限来源的内部通知（bridge 通知、本机 agent 的 waitForIdle 通知）一次送出：逐条投的话第一条就开了新回合，
 * 后面的又被投递层押回，一直忙的 PM 每个回合边界只收到一条，巡检排不到头。做法是拼一封载体信封走原来的 deliver（额度闸、压缩、
 * 会话更换、PM 转交核验、撤下守卫都照旧过一遍），正文里逐条带原 message_id / from / intent / thread / ts；真送达才把原条目逐条
 * touch、报送达、出队。条数上限同 check_inbox，字数按最终载体全文核：放不下的留到下一个回合边界（最早的排最前），超长的原位只给开头加分页读入口；
 * 最早一条自己就超长时不走批次，由原路径整条送。
 * 载体在投递期间排在队首（held-queue.ts idleCarrierHold）：Codex 菜单关了之后投递层只放行「押着的那几条」，载体代表的正是它们。
 * 返回 single = 这一组这一趟不走批次（渲染不了、只有一条、载体没送出去），调用方逐条走原路径。
 */
async function releaseIdleBatch(
  d: FlushDeps, channelId: string, batch: CarrierBatch, fresh: { ws: LocalEndpoint["ws"]; cwd?: string }, reason: string,
): Promise<"sent" | "busy" | "single"> {
  const render = d.render ?? heldRender;
  if (!render) return "single";
  const stopAt = d.stoppedAt?.(channelId), parts: { item: HeldItem; text: string }[] = [];
  for (const item of batch.items) {
    try {
      markIfHeldAcrossStop(item, stopAt);
      parts.push({ item, text: await render(item.env) });
    } catch (e) {
      console.error(`⚠️ 押后批次单条渲染失败，这条留在原路径（${item.env.meta.messageId}）: ${String(e)}`);
    }
  }
  if (parts[0]?.item !== batch.items[0]) return "single";
  const note = (previews: number, left: number) => `${previews ? `，其中 ${previews} 条超长只给开头` : ""}${left ? `，另有 ${left} 条下一个回合边界送达` : ""}`;
  // 预算按最终载体全文算（逐条原信息抬头、分隔、批首都在内），批首的说明按最长的情形留位
  const fit = fitIdleBatch(parts, { maxItems: INBOX_MAX_TAKE, maxChars: INBOX_MAX_CHARS, maxEntryChars: INBOX_BUDGET, maxPreviews: INBOX_MAX_PREVIEWS },
    (text, item) => `${text.slice(0, INBOX_PREVIEW_CHARS)}${inboxPreviewTail(text.length, item.env.meta.messageId)}`,
    (entries) => heldIdleBatchText(entries, note(INBOX_MAX_PREVIEWS, parts.length), batch.title, batch.hint).length);
  const full = fit.entries.filter((e) => !e.preview), previews = fit.entries.length - full.length;
  if (!full.length || fit.entries.length < 2) return "single";
  // all = 这一批真带走（送达后出队）的；shown 另含只给开头的：它们的正文也在载体里，撤下 / 权限变了同样不能发
  const all = full.flatMap(({ item }) => [item, ...(fit.twins.get(item) ?? [])]);
  const shown = [...all, ...fit.entries.filter((e) => e.preview).map((e) => e.item)];
  const to: LocalEndpoint = { ...batch.items[0].to, ws: fresh.ws, cwd: fresh.cwd };
  const id = heldIdleCarrierId(shown);
  const carrier: Envelope = {
    from: { kind: "bridge", label: HELD_IDLE_CARRIER_LABEL }, to, intent: "notification",
    content: heldIdleBatchText(fit.entries, note(previews, fit.left), batch.title, batch.hint),
    meta: { messageId: id, threadId: id, ts: new Date().toISOString(), triggerKind: "bridge_synth", waitForIdle: true, expectSession: batch.expectSession },
  };
  const turn = d.turnAt ?? turnStartedAt, at = turn(channelId);
  const wanted = batch.wanted(shown);
  expectPmTarget(carrier, channelId);
  const flight = d.held.idleCarrierHold(channelId, carrier, to);
  let r: Delivery;
  try {
    // 核完到发送之间别处开了新回合（人类消息抢占等）就不发也不押回，原条目留着走原路径
    r = await d.deliver(carrier, to, () => wanted() && turn(channelId) === at);
  } catch (e) {
    r = { envelope: carrier, outcome: { kind: "error", error: e as Error } };
  } finally {
    expectPmTarget(carrier, undefined);
    d.held.remove(channelId, flight); // 目标转忙 / 菜单还开着被投递层押回的也是它（同一封不另加）
    dropCarriers(d.held, channelId);
  }
  if (r.outcome.kind === "sent" && r.outcome.note === "queued") return "busy";
  if (r.outcome.kind !== "sent" || r.outcome.note || shouldRetry(r)) {
    console.log(`⏸ 押后批次没送出（${r.outcome.kind === "dropped" ? r.outcome.reason : r.outcome.kind}），${all.length} 条原样留着、逐条走原路径`);
    return "single";
  }
  const gone = all.filter((i) => d.held.get(channelId)?.includes(i));
  d.held.idleCarrierSent(carrier, gone); // Codex 打字投递被第二道闸退回时按它复原（held-queue.ts holdFirst）
  for (const item of gone) {
    // 先 touch 再出队落盘（同逐条投递）；本机 agent 的并进这一轮的 callers，发的是请求的也记进 askers（回合失败要告诉它）
    d.touch(channelId, item.env);
    const { from, intent, meta } = item.env;
    if (from.kind === "local") noteDelivered(channelId, from, Date.now(), false, intent === "request" && !meta.skipInterAgentWatchdog);
    if (batch.mirror) (d.mirror ?? heldMirror)?.(channelId, item.env);
    notifyHeldSettled(item.env, "delivered");
    batch.delivered(channelId, item.env);
    d.held.remove(channelId, item);
  }
  console.log(`▶️ 押后消息批次投递(${reason}): ${all.length} 条 → ${to.agentName || channelId}（${id}：${all.map((i) => `${fromLabel(i.env)} ${i.env.meta.messageId}`).join("、")}）`);
  return "sent";
}

/** 逐条送出的这一条在队里还有重复的几份（held-queue.ts idleTwins）：跟着它报送达、出队，不再各投一次各开一轮 */
function settleIdleTwins(d: FlushDeps, channelId: string, item: HeldItem): void {
  for (const twin of d.held.idleTwins(channelId, item)) {
    d.touch(channelId, twin.env);
    if (twin.env.from.kind === "local") noteDelivered(channelId, twin.env.from);
    notifyHeldSettled(twin.env, "delivered");
    d.held.idleDelivered(channelId, twin.env);
    d.held.remove(channelId, twin);
  }
}

export async function flushHeld(d: FlushDeps, channelId: string, reason: string): Promise<void> {
  const q0 = d.held.get(channelId);
  if (!q0 || q0.length === 0) return;
  const evAgent = q0[0].to.agentName || channelId;
  // 不管从哪条路押进来的，闸内都按额度闸算（不老化、出闸补投）；压缩中也要先改记，不然一直在压缩的目标会漏掉（T24 r2 P2-8）
  const walled = !!(await d.walled?.(channelId));
  if (walled) d.held.markWall(channelId, (i) => !gatesAsHuman(i.env));
  if (d.compacting(evAgent)) return; // 压缩上下文中一律继续押(deliverToLocal 也会押回来,省一次往返)
  if (!d.held.claim(channelId)) return; // Stop / 压缩结束 / 扫描撞车:别人正在投这个频道
  try {
    dropCarriers(d.held, channelId);
    const unresolved = adoptStrandedTransfers(d.held); // 全队归并：角色通知留新 PM，直聊留原目标；原目标不明的保留待诊断
    // 归当班 PM 的角色消息（旧 PM 队里的）：不看旧 PM 在不在线、忙不忙、闸没闸，按当班 PM 的分轮规则交出去（handOver）
    const away = roleHandoffs(d.held, channelId, unresolved);
    const handed = new Map<string, HeldItem>(); // 当班 PM 频道 → 这一趟转给它、已开轮的第一封
    const working = await d.working(channelId, evAgent);
    if (!working) openedBy.delete(channelId);
    let first: HeldItem | undefined;
    // 人类消息只因「别掐压缩」被押,压缩一结束就该到——不等回合空闲,deliverToLocal 自带抢占(C-c)语义;
    // agent→agent 仍等空闲(回合中通知有丢弃窗口)。快照:遍历中别处可能往这个频道 hold 新消息,只投这一刻到期的。
    // 闸内另看能不能穿闸(gatesAsHuman),和忙时能不能投(isHumanRequest)是两回事:ask 答复带 waitForIdle,闸内目标空闲照投、忙时照旧等,
    // 拿 isHumanRequest 判闸的话它会被改记成额度闸、等到出闸(tests/held-flush.test.ts T64)
    // check_inbox 现在也领人类消息：租约内的一律不投（忙时也一样）。押满时限的 owner 答复忙时也投、排最前，不被前面等画面静止的外人挡住
    const now = (d.now ?? Date.now)();
    const q = d.held.get(channelId) ?? [];
    const late = new Set(q.filter((i) => ownerLate(i, now)));
    const due = q.filter((i) => !leaseActive(i) && (away.has(i)
      || ((!walled || gatesAsHuman(i.env)) && (!working || d.isHumanRequest(i.env) || late.has(i)))));
    const mine = due.filter((i) => !away.has(i));
    // 内部通知的批次：目标空闲才组（忙时它们本来就不投）；observe 只记「本来会一次送出」，照旧逐条
    const mode = working ? "off" : d.held.idleMode();
    const groups = mode === "off" ? [] : d.held.idleBatches(channelId)
      .map((b) => ({ ...b, items: b.items.filter((i) => mine.includes(i) && !unresolved.has(i)) })).filter((b) => b.items.length > 1);
    if (mode === "observe") for (const g of groups) console.log(`👀 押后批次（只观察，${reason}）: ${evAgent} 有 ${g.items.length} 条内部通知本可一次送出（${g.items.map((i) => i.env.meta.messageId).join("、")}）`);
    const carriers = mode === "on" ? groups.map((g) => idleCarrier(d, channelId, g)) : [];
    const agents = working ? undefined : agentCarrier(d, channelId, mine.filter((i) => !unresolved.has(i)), new Set(carriers.flatMap((c) => c.items)));
    const batchOf = new Map([...carriers, ...(agents ? [agents] : [])].flatMap((c) => c.items.map((i) => [i, c] as const)));
    const batched = new Set<HeldItem>();
    for (const item of [...due.filter((i) => away.has(i)), ...mine.filter((i) => late.has(i)), ...mine.filter((i) => !late.has(i))]) {
      if (unresolved.has(item)) continue;
      // claim 只挡别的 flush / check_inbox:await 期间 ageHeld 放弃、kill 清理都可能已把它摘掉,摘掉的就别再投
      if (!d.held.get(channelId)?.includes(item) || batched.has(item)) continue;
      const pm = away.get(item);
      if (pm) {
        if ((await handOver(d, channelId, item, pm, late.has(item), handed, reason)) !== "home") continue;
        // 交接途中 PM 切回了这个频道：这封又归它自己，按它的规则走（闸 / 忙时只投人类消息 / 分轮），不按缓存的当班 PM 投
        if (!d.held.get(channelId)?.includes(item) || !((!walled || gatesAsHuman(item.env)) && (!working || d.isHumanRequest(item.env) || late.has(item)))) continue;
      }
      // ws 可能已换代(channel-server 重连 / bridge 重启后从盘上恢复的没有 ws):按 channelId 取最新连接;不在线就留着
      const fresh = d.client(channelId);
      if (!fresh) break;
      if (!(await mayJoin(d, item, channelId, working, first, late.has(item)))) break;
      const group = pm ? undefined : batchOf.get(item);
      if (group) {
        const res = await releaseIdleBatch(d, channelId, group, fresh, reason);
        if (res === "busy") break;
        for (const i of group.items) batchOf.delete(i);
        if (res === "sent") {
          for (const i of group.items) batched.add(i); // 没放进这一批的（超限 / 超长）等下一个回合边界，这一趟不再逐条试
          first ??= item;
          openedBy.set(channelId, { who: HELD_IDLE_CARRIER_LABEL, at: (d.turnAt ?? turnStartedAt)(channelId) });
          continue;
        }
        if (!d.held.get(channelId)?.includes(item)) continue;
      }
      if (late.has(item) && item.env.meta.waitForIdle) delete item.env.meta.waitForIdle; // 只有卡片答复走到这里（见 ownerLate）
      const to: LocalEndpoint = { ...item.to, ws: fresh.ws, cwd: fresh.cwd };
      markIfHeldAcrossStop(item, d.stoppedAt?.(channelId));
      if (pm) expectPmTarget(item.env, channelId); // 核的是本频道的分轮：投递时又被转给别的 PM 就留队（deliverPmLocal pmTargetDrift）
      const r = await d.deliver(item.env, to, () => !!d.held.get(channelId)?.includes(item)).finally(() => expectPmTarget(item.env, undefined));
      if (r.outcome.kind === "error" || shouldRetry(r)) continue; // 留在队里(盘上一直有它),下一次触发再投;转给离线的当班 PM 同样留着
      // 转给忙着的当班 PM、已押进它的队:归属交给那边(它空闲时投一次),这边摘掉,否则每次扫描都再转一遍
      if (handedOver(d.held, channelId, item, r)) {
        d.held.remove(channelId, item);
        console.log(`↪️ 押后消息转交(${reason}): ${fromLabel(item.env)} → ${(r.envelope.to as LocalEndpoint).agentName}（${item.env.meta.messageId}），排进对方队列`);
        continue;
      }
      // 目标又忙了:deliverToLocal 押回时 hold 认出原条目还在(同一封)就不另加——原条目留着,首次入队 / 已提醒时间不重置,
      // 也不会「新的已落盘、旧的还没摘」时崩溃留下两份。等下一次触发
      if (r.outcome.kind === "sent" && r.outcome.note === "queued") break;
      // 先 touch 再出队落盘:中间崩溃也只是重投一次,不会拿旧钟把回程扫掉
      if (r.outcome.kind === "sent") {
        d.touch(channelId, item.env);
        first ??= item;
        openedBy.set(channelId, { who: senderOf(item.env), at: (d.turnAt ?? turnStartedAt)(channelId) });
        notifyHeldSettled(item.env, "delivered");
        for (const fn of deliveredHooks) fn(channelId, item.env);
        if (mode === "on") settleIdleTwins(d, channelId, item);
      }
      d.held.remove(channelId, item);
      if (r.outcome.kind === "sent") console.log(`▶️ 押后消息投递(${reason}): ${fromLabel(item.env)} → ${to.agentName || channelId}（${item.env.meta.messageId}）`);
    }
  } finally {
    d.held.release(channelId);
  }
}

/**
 * 旧 PM 队里归当班 PM 的一封：deliverPmLocal 按角色转交（抬头、回程槽、API 回执、最终收件人凭据范围都在那边每次重核）。
 * 不占旧 PM 这一轮（不记旧 PM 的 openedBy、不加旧 PM 的叫停抬头），但按当班 PM 的分轮规则投——外人的一轮只投一个发送人、
 * 它在跑别人开的一轮就不塞外人的（mayJoin），否则两个 peer 的请求同轮进 B、Stop 兜底把答给一个的话结给两个（handoff-mixed-turn）。
 * 当班 PM 自己的 flush / check_inbox 在投时不抢（claim 它的频道），下次再试。
 * 送达 / 押进对方队才出队，没送到（对方离线、轮不到）留着下次再试
 */
async function handOver(d: FlushDeps, channelId: string, item: HeldItem, pm: PmTarget, late: boolean, handed: Map<string, HeldItem>, reason: string): Promise<"home" | void> {
  // 核分轮的 await 期间 owner 可能切了 PM：换了人就按新的当班 PM 从头再核，切回本频道就交还给本频道（"home"）；切个不停的下次再试
  for (let tries = 0; tries < 3; tries++) {
    const r = await handOverTo(d, channelId, item, pm, late, handed, reason);
    if (r === "home" || !r) return r;
    pm = r;
  }
}

/** 投给 pm 一次；所有 await 之后再判一次当班 PM，和核过的不一样就不发、返回新目标（null 路由 = "home"） */
async function handOverTo(d: FlushDeps, channelId: string, item: HeldItem, pm: PmTarget, late: boolean, handed: Map<string, HeldItem>, reason: string): Promise<PmTarget | "home" | void> {
  const b = pm.channelId && pm.channelId !== channelId ? pm.channelId : undefined;
  if (b && !d.held.claim(b)) return;
  try {
    if (b && d.client(b)) {
      // 这一趟已转给它一位外人的：别的发送人等它这一轮结束（B 刚被投、判忙可能还没跟上，不能靠下面押队）
      const first = handed.get(b);
      if (first && (outsider(item.env) || outsider(first.env)) && senderOf(first.env) !== senderOf(item.env)) return;
      const working = await d.working(b, pm.agentName);
      if (!working) openedBy.delete(b);
      // 它在跑：它自己的 flush 这时也不投的（非人类请求、没押满时限），押进它的队、等它 Stop 按它的规则投。
      // 打 waitForIdle（本来就不抢占的才打）让 deliverToLocal 押而不是插进这一轮——API / peer 请求不带它时忙也照发（holdsUntilIdle）
      if (working && !d.isHumanRequest(item.env) && !late) item.env.meta.waitForIdle = true;
      else if (!(await mayJoin(d, item, b, working, first, late))) return;
    }
    if (!d.held.get(channelId)?.includes(item)) return;
    // 上面核的是 b：之后到发送之间没有 await，这里再判一次当班 PM；变了就不拿 b 的结论投（handoff-mixed-turn）
    const now = currentPmTarget(channelId, item.env);
    if (!now) return "home";
    if (now.channelId !== pm.channelId) return now;
    // 旧 PM 离线时没有它的连接：deliverPmLocal 转交时换成当班 PM 的；判定不转的按离线留着（不会拿空连接发）
    const ws = (d.client(channelId)?.ws ?? item.to.ws) as LocalEndpoint["ws"];
    // deliverPmLocal 最终解析出的收件频道不是 b（这之后仍可能切换）就留队重试，锁、分轮、发送始终是同一个目标
    expectPmTarget(item.env, b);
    const r = await d.deliver(item.env, { ...item.to, ws }, () => !!d.held.get(channelId)?.includes(item)).finally(() => expectPmTarget(item.env, undefined));
    const to = r.envelope.to;
    if (r.outcome.kind === "error" || shouldRetry(r)) return;
    if (r.outcome.kind === "sent" && !handedOver(d.held, channelId, item, r) && r.outcome.note === "queued") return;
    if (r.outcome.kind === "sent" && r.outcome.note !== "queued" && to.kind === "local") {
      d.touch(to.channelId, item.env);
      if (!handed.has(to.channelId)) handed.set(to.channelId, item);
      openedBy.set(to.channelId, { who: senderOf(item.env), at: (d.turnAt ?? turnStartedAt)(to.channelId) });
      notifyHeldSettled(item.env, "delivered");
      for (const fn of deliveredHooks) fn(to.channelId, item.env);
    }
    d.held.remove(channelId, item);
    if (r.outcome.kind === "sent") console.log(`↪️ 押后消息转交(${reason}): ${fromLabel(item.env)} → ${to.kind === "local" ? to.agentName : to.kind}（${item.env.meta.messageId}）`);
  } finally {
    if (b) d.held.release(b);
  }
}

/**
 * agent 被 kill（/agent/cleanup）：押给它的消息不再有人收——丢掉并留日志，别等 24 小时，也别投给日后复用这个频道的新 agent。
 * 其中 owner 的 ask 答复不能悄悄丢：ask 放回「待你处理」并告诉 owner（bridge/asks.ts answerDropped）。
 */
export function dropHeldOnKill(held: HeldQueue, channelId: string, onDropped: (env: Envelope) => Promise<void> = answerDropped): void {
  const dropped = held.get(channelId) ?? [];
  if (!held.discard(channelId)) return;
  console.log(`🧹 agent 已 kill,丢掉押给它的 ${dropped.length} 条消息 (channel=${channelId})`);
  for (const i of dropped) void onDropped(i.env).catch((e: Error) => console.error(`⚠️ 被丢的押后消息善后失败: ${e.message}`));
}

/** asks.ts 连着台账和 event-bus：按需加载，单测注入自己的 onDropped 就不碰它们 */
const answerDropped = (env: Envelope) => import("./asks.js").then((m) => m.answerDropped(env));
