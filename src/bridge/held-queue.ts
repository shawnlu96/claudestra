/**
 * agent→agent 消息的押后队列（目标在回合中就不 ws.send，等 Stop / 压缩结束 / 每分钟扫描再投；为什么要押见 bridge.ts
 * heldLocalMsgs 的注释）。这里管三件事，别的仍在 bridge.ts：
 *   1. 落盘：~/.claude-orchestrator/held-messages.json，bridge 重启不丢（ws 不落盘，投递时按 channelId 取最新连接）
 *   2. 不按时间丢：押满 30 分钟只告诉发送方一声「还在排队」，消息留着等目标这一轮结束；押满 24 小时才放弃并通知——
 *      值守让一轮能跑一两个小时，以前 30 分钟就扔会让同事的回复全丢（2026-09-28 codex 的 10 条复核就是这么没的）
 *   3. 出队在投出之后才落盘：投递中途崩溃，重启后会再投一次（至少一次；收件方看 message_id 去重）
 */
import type { Envelope, LocalEndpoint } from "./router.js";
import { statePath } from "../lib/paths.js";
import { PersistedMap } from "./persisted-map.js";

export interface HeldItem {
  env: Envelope;
  to: LocalEndpoint;
  heldAt: number;
  /** 已经告诉过发送方「还在排队」的时刻 */
  notifiedAt?: number;
}

export const HELD_NOTIFY_MS = 30 * 60_000;
export const HELD_GIVE_UP_MS = 24 * 3_600_000;

const isQueue = (q: unknown): boolean => Array.isArray(q) && q.every((i) => i && typeof i === "object" && "env" in i && "to" in i);

/** 一个 Map（bridge.ts 原来的用法不变），set / delete 之后同步落盘；path = null 不落盘（单测） */
export class HeldQueue extends PersistedMap<HeldItem[]> {
  constructor(path: string | null = statePath("held-messages.json")) {
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

  /** 摘掉一条但先不落盘：调用方投出去之后再 persist()，投递中途崩溃时文件里还有它 */
  detach(channelId: string, item: HeldItem): void {
    const rest = (this.get(channelId) ?? []).filter((i) => i !== item);
    if (rest.length) this.setQuiet(channelId, rest);
    else this.deleteQuiet(channelId);
  }

  /** 投递失败：放回队首 */
  restore(channelId: string, item: HeldItem): void {
    this.set(channelId, [item, ...(this.get(channelId) ?? [])]);
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
