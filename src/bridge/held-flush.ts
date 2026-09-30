/**
 * 押后队列的投递（Stop / 压缩结束 / 每分钟扫描时调）：从 bridge.ts 挪出来、依赖全注入，好让 tests/held-flush.test.ts
 * 把「投到一半目标又忙」「await 期间条目被别处摘掉」这些交错场景跑一遍（codex 2026-09-28 复核要求的集成测试）。
 * 规则：压缩中不投；目标在回合中只投人类消息（它们只因「别掐压缩」被押）；check_inbox 租约内的不投；
 * 投出去之后才出队；目标又忙就停，原条目留着、计时不变；每个频道同一时刻只有一个投递者（held.claim）。
 */
import { isOwnerSource } from "../lib/delegate-marker.js";
import { gatesAsHuman } from "../lib/quota-wall.js";
import { tmuxCapture } from "../lib/tmux-helper.js";
import { inputBox } from "../lib/turn-state.js";
import { heldAcrossStopNote } from "../lib/turn-cuts.js";
import { leaseActive, notifyHeldSettled, type HeldItem, type HeldQueue, type WallReason } from "./held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";
import { resolveTurnWindow } from "./turn-probe.js";
import { senderTrigger, turnStartedAt } from "./stop-settle.js";
import { controlFor } from "../lib/runtimes/index.js";

export interface FlushDeps {
  held: HeldQueue;
  compacting: (agent: string) => boolean;
  working: (channelId: string, agent: string) => Promise<boolean>;
  isHumanRequest: (env: Envelope) => boolean;
  /** 这个频道当前的连接；不在线 = undefined */
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  /** stillWanted：投递途中最后一刻再核对这条还在队里（被 kill 清理 / 放弃摘掉的就不发、不押回） */
  deliver: (env: Envelope, to: LocalEndpoint, stillWanted?: () => boolean) => Promise<Delivery>;
  /** 这个频道在额度闸里（bridge/quota-wall.ts；Codex 额度墙返回它的押后原因）：只投能穿闸的（gatesAsHuman），其余留着等出闸补投——否则每分钟扫描都投一次、再被押回来 */
  walled?: (channelId: string) => Promise<boolean | WallReason>;
  /** 回程簿失效钟从真正送达起算（只动这封消息发送方那一槽） */
  touch: (channelId: string, env: Envelope) => void;
  /** owner 最近一次叫停这个频道的时刻（bridge/turn-cuts.ts stoppedAt）；押在它之前的条目投出去时加抬头 */
  stoppedAt?: (channelId: string) => number | undefined;
  /** 画面真静下来了（外人的消息投之前看）；不给 = 隔 1.5 秒抓两次屏比输入框以上（paneSettled） */
  settled?: (channelId: string) => Promise<boolean>;
  /** 这个频道当前这一轮的开启时刻（stop-settle 的 turnTrigger；Stop / 打断就没了）；不给 = turnStartedAt */
  turnAt?: (channelId: string) => number | undefined;
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
 */
function markIfHeldAcrossStop(item: HeldItem, stopAt: number | undefined): void {
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
async function mayJoin(d: FlushDeps, item: HeldItem, channelId: string, working: boolean, first: HeldItem | undefined): Promise<boolean> {
  const who = senderOf(item.env);
  if (first && (outsider(item.env) || outsider(first.env)) && senderOf(first.env) !== who) return false;
  if (!outsider(item.env)) return true;
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

export async function flushHeld(d: FlushDeps, channelId: string, reason: string): Promise<void> {
  const q = d.held.get(channelId);
  if (!q || q.length === 0) return;
  const evAgent = q[0].to.agentName || channelId;
  // 不管从哪条路押进来的，闸内都按额度闸算（不老化、出闸补投）；压缩中也要先改记，不然一直在压缩的目标会漏掉（T24 r2 P2-8）
  const wall = await d.walled?.(channelId);
  const walled = !!wall;
  if (walled) d.held.markWall(channelId, (i) => !gatesAsHuman(i.env), wall === true ? "quota_wall" : wall);
  if (d.compacting(evAgent)) return; // 压缩上下文中一律继续押(deliverToLocal 也会押回来,省一次往返)
  if (!d.held.claim(channelId)) return; // Stop / 压缩结束 / 扫描撞车:别人正在投这个频道
  try {
    const working = await d.working(channelId, evAgent);
    if (!working) openedBy.delete(channelId);
    let first: HeldItem | undefined;
    // 人类消息只因「别掐压缩」被押,压缩一结束就该到——不等回合空闲,deliverToLocal 自带抢占(C-c)语义;
    // agent→agent 仍等空闲(回合中通知有丢弃窗口)。快照:遍历中别处可能往这个频道 hold 新消息,只投这一刻到期的。
    // 闸内另看能不能穿闸(gatesAsHuman),和忙时能不能投(isHumanRequest)是两回事:ask 答复带 waitForIdle,闸内目标空闲照投、忙时照旧等,
    // 拿 isHumanRequest 判闸的话它会被改记成额度闸、等到出闸(tests/held-flush.test.ts T64)
    const due = q.filter((i) => (!walled || gatesAsHuman(i.env)) && (working ? d.isHumanRequest(i.env) : !leaseActive(i)));
    for (const item of due) {
      // ws 可能已换代(channel-server 重连 / bridge 重启后从盘上恢复的没有 ws):按 channelId 取最新连接;不在线就留着
      const fresh = d.client(channelId);
      if (!fresh) break;
      // claim 只挡别的 flush / check_inbox:await 期间 ageHeld 放弃、kill 清理都可能已把它摘掉,摘掉的就别再投
      if (!d.held.get(channelId)?.includes(item)) continue;
      if (!(await mayJoin(d, item, channelId, working, first))) break;
      const to: LocalEndpoint = { ...item.to, ws: fresh.ws, cwd: fresh.cwd };
      markIfHeldAcrossStop(item, d.stoppedAt?.(channelId));
      const r = await d.deliver(item.env, to, () => !!d.held.get(channelId)?.includes(item));
      if (r.outcome.kind === "error") continue; // 留在队里(盘上一直有它),下一次触发再投
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
      }
      d.held.remove(channelId, item);
      if (r.outcome.kind === "sent") console.log(`▶️ 押后消息投递(${reason}): ${fromLabel(item.env)} → ${to.agentName || channelId}（${item.env.meta.messageId}）`);
    }
  } finally {
    d.held.release(channelId);
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
