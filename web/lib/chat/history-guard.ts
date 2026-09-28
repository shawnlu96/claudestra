import type { ChatMessage } from "@/features/chat/type";
import type { GuardItem } from "@/lib/api/guard";

/**
 * 把守门记录合进历史视图（owner 2026-09-28「被丢弃的信息刷新就没了，能否保存；放行的也加个记录」）。纯函数，tests/web-history-guard.test.ts。
 * - dropped：从未进过 agent 会话，所以历史里没有——按原时间合成一条用户气泡（guard="dropped"），插到时间顺序的位置；
 * - released：放行后照常进了历史——按「同一发送方 + 原文逐字相同 + 时间在放行前后 10 分钟内」找到那条，打 guard="released"；
 * - pending 不管（待放行卡在输入框上方）。只合并落在本页时间范围内的记录（newest 页范围上不封顶）。
 */
const RELEASE_WINDOW_MS = 10 * 60_000;

export function mergeGuardRecords(messages: ChatMessage[], records: GuardItem[], selfIds: ReadonlySet<string>, opts: { newest?: boolean } = {}): ChatMessage[] {
  // 空页没有时间锚点：差量 / 翻页拿到 0 条时什么都不合（曾把全部 dropped 记录塞进空的差量页，再被追加到列表末尾）
  if (!records.length || !messages.length) return messages;
  const times = messages.map((m) => Date.parse(m.ts ?? "")).filter((n) => Number.isFinite(n));
  const lo = times.length ? Math.min(...times) : 0;
  const hi = opts.newest || !times.length ? Infinity : Math.max(...times);
  const out = messages.slice();
  const taken = new Set<string>();
  for (const r of records) {
    const t = Date.parse(r.ts ?? r.at);
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    const isSelf = !!r.fromId && selfIds.has(r.fromId);
    if (r.status === "dropped") {
      const msg: ChatMessage = {
        id: `g:${r.id}`, role: "user", content: r.text, ts: new Date(t).toISOString(), guard: "dropped",
        ...(r.actedBy ? { guardBy: r.actedBy } : {}), ...(isSelf ? {} : { from: r.from }),
      };
      // 插到第一条时间晚于它的消息前面（历史按时间序）
      const at = out.findIndex((m) => Date.parse(m.ts ?? "") > t);
      if (at < 0) out.push(msg);
      else out.splice(at, 0, msg);
    } else if (r.status === "released") {
      const acted = Date.parse(r.actedAt ?? "") || t;
      const idx = out.findIndex(
        (m) => m.role === "user" && !taken.has(m.id) && m.content === r.text && Math.abs(Date.parse(m.ts ?? "") - acted) <= RELEASE_WINDOW_MS && (isSelf ? !m.from : true),
      );
      if (idx >= 0) {
        taken.add(out[idx].id);
        out[idx] = { ...out[idx], guard: "released", ...(r.actedBy ? { guardBy: r.actedBy } : {}) };
      }
    }
  }
  return out;
}
