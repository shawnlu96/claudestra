/**
 * 押后队列的投递（Stop / 压缩结束 / 每分钟扫描时调）：从 bridge.ts 挪出来、依赖全注入，好让 tests/held-flush.test.ts
 * 把「投到一半目标又忙」「await 期间条目被别处摘掉」这些交错场景跑一遍（codex 2026-09-28 复核要求的集成测试）。
 * 规则：压缩中不投；目标在回合中只投人类消息（它们只因「别掐压缩」被押）；check_inbox 租约内的不投；
 * 投出去之后才出队；目标又忙就停，原条目留着、计时不变；每个频道同一时刻只有一个投递者（held.claim）。
 */
import { heldAcrossStopNote } from "../lib/turn-cuts.js";
import { leaseActive, type HeldItem, type HeldQueue } from "./held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";

export interface FlushDeps {
  held: HeldQueue;
  compacting: (agent: string) => boolean;
  working: (channelId: string, agent: string) => Promise<boolean>;
  isHumanRequest: (env: Envelope) => boolean;
  /** 这个频道当前的连接；不在线 = undefined */
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  /** stillWanted：投递途中最后一刻再核对这条还在队里（被 kill 清理 / 放弃摘掉的就不发、不押回） */
  deliver: (env: Envelope, to: LocalEndpoint, stillWanted?: () => boolean) => Promise<Delivery>;
  /** 这个频道在额度闸里（bridge/quota-wall.ts）：只投人类消息，其余留着等出闸补投——否则每分钟扫描都投一次、再被押回来 */
  walled?: (channelId: string) => Promise<boolean>;
  /** 回程簿失效钟从真正送达起算（只动这封消息发送方那一槽） */
  touch: (channelId: string, env: Envelope) => void;
  /** owner 最近一次叫停这个频道的时刻（bridge/turn-cuts.ts stoppedAt）；押在它之前的条目投出去时加抬头 */
  stoppedAt?: (channelId: string) => number | undefined;
}

/**
 * 押在叫停之前、叫停之后才投出去的（忙时作答的 ask 答复、agent 请求）：加一行抬头「停之前发的，先别照做，问用户还要不要」——
 * 不加的话 agent 看到的顺序是「停之后 owner 又批准了」，会照做（wf2 classify-merge-1）。bridge 自己的通知不加（收尾提醒另有作废规则）。
 */
function markIfHeldAcrossStop(item: HeldItem, stopAt: number | undefined): void {
  const m = item.env.meta;
  if (stopAt && item.heldAt < stopAt && item.env.from.kind !== "bridge" && !m.interruptNote) m.interruptNote = heldAcrossStopNote(item.heldAt, stopAt);
}

export async function flushHeld(d: FlushDeps, channelId: string, reason: string): Promise<void> {
  const q = d.held.get(channelId);
  if (!q || q.length === 0) return;
  const evAgent = q[0].to.agentName || channelId;
  // 不管从哪条路押进来的，闸内都按额度闸算（不老化、出闸补投）；压缩中也要先改记，不然一直在压缩的目标会漏掉（T24 r2 P2-8）
  const walled = !!(await d.walled?.(channelId));
  if (walled) d.held.markWall(channelId, (i) => !d.isHumanRequest(i.env));
  if (d.compacting(evAgent)) return; // 压缩上下文中一律继续押(deliverToLocal 也会押回来,省一次往返)
  if (!d.held.claim(channelId)) return; // Stop / 压缩结束 / 扫描撞车:别人正在投这个频道
  try {
    const working = await d.working(channelId, evAgent);
    // 人类消息只因「别掐压缩」被押,压缩一结束就该到——不等回合空闲,deliverToLocal 自带抢占(C-c)语义;
    // agent→agent 仍等空闲(回合中通知有丢弃窗口)。快照:遍历中别处可能往这个频道 hold 新消息,只投这一刻到期的
    const humanOnly = working || walled;
    const due = humanOnly ? q.filter((i) => d.isHumanRequest(i.env)) : q.filter((i) => !leaseActive(i));
    for (const item of due) {
      // ws 可能已换代(channel-server 重连 / bridge 重启后从盘上恢复的没有 ws):按 channelId 取最新连接;不在线就留着
      const fresh = d.client(channelId);
      if (!fresh) break;
      // claim 只挡别的 flush / check_inbox:await 期间 ageHeld 放弃、kill 清理都可能已把它摘掉,摘掉的就别再投
      if (!d.held.get(channelId)?.includes(item)) continue;
      const to: LocalEndpoint = { ...item.to, ws: fresh.ws, cwd: fresh.cwd };
      markIfHeldAcrossStop(item, d.stoppedAt?.(channelId));
      const r = await d.deliver(item.env, to, () => !!d.held.get(channelId)?.includes(item));
      if (r.outcome.kind === "error") continue; // 留在队里(盘上一直有它),下一次触发再投
      // 目标又忙了:deliverToLocal 押回时 hold 认出原条目还在(同一封)就不另加——原条目留着,首次入队 / 已提醒时间不重置,
      // 也不会「新的已落盘、旧的还没摘」时崩溃留下两份。等下一次触发
      if (r.outcome.kind === "sent" && r.outcome.note === "queued") break;
      // 先 touch 再出队落盘:中间崩溃也只是重投一次,不会拿旧钟把回程扫掉
      if (r.outcome.kind === "sent") d.touch(channelId, item.env);
      d.held.remove(channelId, item);
      if (r.outcome.kind === "sent") console.log(`▶️ 押后消息投递(${reason}): ${item.env.from.kind === "local" ? item.env.from.agentName : "?"} → ${to.agentName || channelId}`);
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
  if (!held.delete(channelId)) return;
  console.log(`🧹 agent 已 kill,丢掉押给它的 ${dropped.length} 条消息 (channel=${channelId})`);
  for (const i of dropped) void onDropped(i.env).catch((e: Error) => console.error(`⚠️ 被丢的押后消息善后失败: ${e.message}`));
}

/** asks.ts 连着台账和 event-bus：按需加载，单测注入自己的 onDropped 就不碰它们 */
const answerDropped = (env: Envelope) => import("./asks.js").then((m) => m.answerDropped(env));
