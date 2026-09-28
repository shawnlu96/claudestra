/**
 * 押后队列的投递（Stop / 压缩结束 / 每分钟扫描时调）：从 bridge.ts 挪出来、依赖全注入，好让 tests/held-flush.test.ts
 * 把「投到一半目标又忙」「await 期间条目被别处摘掉」这些交错场景跑一遍（codex 2026-09-28 复核要求的集成测试）。
 * 规则：压缩中不投；目标在回合中只投人类消息（它们只因「别掐压缩」被押）；check_inbox 租约内的不投；
 * 投出去之后才出队；目标又忙就停，原条目留着、计时不变；每个频道同一时刻只有一个投递者（held.claim）。
 */
import { leaseActive, type HeldQueue } from "./held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";

export interface FlushDeps {
  held: HeldQueue;
  compacting: (agent: string) => boolean;
  working: (channelId: string, agent: string) => Promise<boolean>;
  isHumanRequest: (env: Envelope) => boolean;
  /** 这个频道当前的连接；不在线 = undefined */
  client: (channelId: string) => { ws: LocalEndpoint["ws"]; cwd?: string } | undefined;
  deliver: (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;
  /** 回程簿失效钟从真正送达起算（只动这封消息发送方那一槽） */
  touch: (channelId: string, env: Envelope) => void;
}

export async function flushHeld(d: FlushDeps, channelId: string, reason: string): Promise<void> {
  const q = d.held.get(channelId);
  if (!q || q.length === 0) return;
  const evAgent = q[0].to.agentName || channelId;
  if (d.compacting(evAgent)) return; // 压缩上下文中一律继续押(deliverToLocal 也会押回来,省一次往返)
  if (!d.held.claim(channelId)) return; // Stop / 压缩结束 / 扫描撞车:别人正在投这个频道
  try {
    const working = await d.working(channelId, evAgent);
    // 人类消息只因「别掐压缩」被押,压缩一结束就该到——不等回合空闲,deliverToLocal 自带抢占(C-c)语义;
    // agent→agent 仍等空闲(回合中通知有丢弃窗口)。快照:遍历中别处可能往这个频道 hold 新消息,只投这一刻到期的
    const due = working ? q.filter((i) => d.isHumanRequest(i.env)) : q.filter((i) => !leaseActive(i));
    for (const item of due) {
      // ws 可能已换代(channel-server 重连 / bridge 重启后从盘上恢复的没有 ws):按 channelId 取最新连接;不在线就留着
      const fresh = d.client(channelId);
      if (!fresh) break;
      // claim 只挡别的 flush / check_inbox:await 期间 ageHeld 放弃、kill 清理都可能已把它摘掉,摘掉的就别再投
      if (!d.held.get(channelId)?.includes(item)) continue;
      const to: LocalEndpoint = { ...item.to, ws: fresh.ws, cwd: fresh.cwd };
      const r = await d.deliver(item.env, to);
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
