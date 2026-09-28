/**
 * agent→agent 消息的押后队列（目标在回合中就不 ws.send，等 Stop / 压缩结束 / 每分钟扫描再投；为什么要押见 bridge.ts
 * heldLocalMsgs 的注释）。这里管三件事，别的仍在 bridge.ts：
 *   1. 落盘：~/.claude-orchestrator/held-messages.json，bridge 重启不丢（ws 不落盘，投递时按 channelId 取最新连接）
 *   2. 不按时间丢：押满 30 分钟只告诉发送方一声「还在排队」，消息留着等目标这一轮结束；押满 24 小时才放弃并通知——
 *      值守让一轮能跑一两个小时，以前 30 分钟就扔会让同事的回复全丢（2026-09-28 codex 的 10 条复核就是这么没的）
 *   3. 投出之后才出队：投递中途崩溃，重启后会再投一次（至少一次；收件方看 message_id 去重）；每个频道只有一个投递者
 */
import type { Envelope, LocalEndpoint } from "./router.js";
import { statePath } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";
import { readJsonStateSync } from "../lib/state-file.js";

export interface HeldItem {
  env: Envelope;
  to: LocalEndpoint;
  heldAt: number;
  /** 已经告诉过发送方「还在排队」的时刻 */
  notifiedAt?: number;
  /** 被 check_inbox 领走、还没确认（bridge/inbox.ts）：租约内 Stop 不再投，过期后照常投 */
  lease?: { batchId: string; at: number };
}

/** check_inbox 领走后多久没确认就重新投递（按普通消息在回合结束时送达，message_id 不变） */
export const INBOX_LEASE_MS = 15 * 60_000;
export const leaseActive = (i: HeldItem, now = Date.now()): boolean => !!i.lease && now - i.lease.at < INBOX_LEASE_MS;

/**
 * 押在 target 队里、它还没看到的消息各是谁发的（回程簿判「请求送到它手上没有」用，lib/held-pac.ts）。
 * check_inbox 领走的算看到了，哪怕还没 ack——否则 agent 读完就答，答复会被当成「请求还押着」而不算数（codex 2026-09-28 复核）。
 */
export function unseenFrom(q: HeldQueue, target: string): { fromKind: string; fromChannelId?: string; messageId?: string }[] | undefined {
  return q.get(target)?.filter((i) => !i.lease).map((i) => ({
    fromKind: i.env.from.kind, fromChannelId: i.env.from.kind === "local" ? i.env.from.channelId : undefined, messageId: i.env.meta.messageId,
  }));
}

export const HELD_NOTIFY_MS = 30 * 60_000;
export const HELD_GIVE_UP_MS = 24 * 3_600_000;

const HELD_PATH = statePath("held-messages.json");
const isQueue = (q: unknown): boolean => Array.isArray(q) && q.every((i) => i && typeof i === "object" && "env" in i && "to" in i);

/** 一个 Map（bridge.ts 原来的用法不变），set / delete 之后同步落盘；path = null 不落盘（单测） */
export class HeldQueue extends PersistedMap<HeldItem[]> {
  constructor(path: string | null = HELD_PATH) {
    super(path, "押后消息", isQueue);
    for (const [ch, items] of [...this.entries()]) if (!items.length) this.deleteQuiet(ch);
    const n = [...this.values()].reduce((s, q) => s + q.length, 0);
    if (n) console.log(`♻️ 恢复押后消息 ${n} 条（bridge 重启前没投出去的）`);
  }

  override set(channelId: string, items: HeldItem[]): this {
    if (items.length) return super.set(channelId, items);
    this.delete(channelId);
    return this;
  }

  /**
   * 追加一条并落盘，返回这个频道排队的条数。同一封（messageId 相同，router.ts newMessageId 保证唯一）已在队里就不再加：
   * flush 投到一半目标又忙，deliverToLocal 会把正在投的那条再 hold 一次——原条目留着，首次入队 / 提醒时间不被刷新。
   * 换新数组不原地 push：flush 遍历的快照不受影响。
   */
  hold(channelId: string, item: HeldItem): number {
    const cur = this.get(channelId) ?? [];
    if (cur.some((i) => i.env.meta.messageId === item.env.meta.messageId)) return cur.length;
    const q = [...cur, item];
    this.set(channelId, q);
    return q.length;
  }

  /** 按信封的收件方押后，入队时间取现在 */
  holdEnv(env: Envelope): number {
    const to = env.to as LocalEndpoint;
    return this.hold(to.channelId, { env, to, heldAt: Date.now() });
  }

  /** 投出去之后才摘掉并落盘：投递中途崩溃 / 别处 set 触发整表落盘时，盘上都还有它（至少投一次，收件方看 message_id 去重） */
  remove(channelId: string, item: HeldItem): void {
    this.set(channelId, (this.get(channelId) ?? []).filter((i) => i !== item));
  }

  /** 每个频道同一时刻只允许一个投递者（Stop / 压缩结束 / 每分钟扫描可能撞在一起，否则同一条会投两次）。进程内状态，不落盘 */
  private readonly flushing = new Set<string>();
  claim(channelId: string): boolean {
    if (this.flushing.has(channelId)) return false;
    this.flushing.add(channelId);
    return true;
  }
  release(channelId: string): void {
    this.flushing.delete(channelId);
  }
}

export type HeldNotice = { kind: "still-queued" | "gave-up"; item: HeldItem; channelId: string };

/**
 * 每分钟扫描时调：押满 30 分钟、还没通知过的 → still-queued（只发一次）；押满 24 小时 → 出队并 gave-up。
 * 返回要发给发送方的通知，发不发、怎么发由 bridge 决定（它手里有 clients）。
 */
export function ageHeld(q: HeldQueue, now: number): HeldNotice[] {
  const out: HeldNotice[] = [];
  for (const [channelId, items] of [...q.entries()]) {
    const keep: HeldItem[] = [];
    let changed = false;
    for (const item of items) {
      if (now - item.heldAt > HELD_GIVE_UP_MS) {
        out.push({ kind: "gave-up", item, channelId });
        changed = true;
        continue;
      }
      if (now - item.heldAt > HELD_NOTIFY_MS && !item.notifiedAt) {
        item.notifiedAt = now;
        out.push({ kind: "still-queued", item, channelId });
        changed = true;
      }
      keep.push(item);
    }
    if (changed) q.set(channelId, keep);
  }
  return out;
}

/** 通知发送方的话（bridge.ts 包成 system notification 发到发送方的 ws） */
export function heldNoticeText(n: HeldNotice): string {
  const who = n.item.to.agentName || n.channelId;
  const head = String(n.item.env.content).slice(0, 150);
  return n.kind === "still-queued"
    ? `[⏳ bridge] 你发给 ${who} 的消息已排队 30 分钟：对方一直在一个长回合里，这一轮结束就会送到，不用重发。原文开头: ${head}`
    : `[⚠️ bridge] 你发给 ${who} 的消息排了 24 小时仍没送到（对方一直不空闲或不在线），已放弃。如仍需要，请重发。原文开头: ${head}`;
}

/** 各频道排队中的 agent 消息数（网页侧栏「排队 N 条」）：直接读落盘文件——队列每次变动都同步落盘，不用碰 bridge 的内存 */
export function heldAgentCounts(path: string = HELD_PATH): Record<string, number> {
  const r = readJsonStateSync(path);
  if (r.status !== "ok" || !r.data || typeof r.data !== "object") return {};
  const out: Record<string, number> = {};
  for (const [ch, q] of Object.entries(r.data as Record<string, unknown>)) {
    const n = isQueue(q) ? (q as HeldItem[]).filter((i) => i.env?.from?.kind === "local").length : 0;
    if (n) out[ch] = n;
  }
  return out;
}
