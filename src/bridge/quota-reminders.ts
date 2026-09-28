/**
 * Codex 重置次数的提醒投递（设计稿 T2b §4 / §6.1；规则与账本在 lib/quota-reminder-rules.ts）。
 *
 *   - 每个额度 tick 之后跑一次：按当前视图规划「快过期」（72 / 24 小时）与「用满了还有可用重置」，再投递账本里没送到的。
 *   - 两个渠道各记各的：推送（owner 的所有设备）、Discord #control。失败的渠道按规则退避重试，已成功的不重发。
 *     推送一台设备也没登记 = 算送到（没有可重试的对象）；推送子系统没起来 / 全部设备失败 = 失败。
 *   - 夜间 23:00–08:00（本机时区）不打扰：暂存，08:00 后同一渠道的积压合并成一条发。例外：有 credit 在 08:00 前就过期，
 *     等下去就是不可逆的损失，立即发。
 *   - 文案只有到期时刻、次数、窗口名：credit 的内部键、账户键都不进消息。
 * 单测 tests/quota-reminders.test.ts。
 */

import { t } from "../lib/i18n.js";
import {
  pendingDeliveries, planExhaustedReminder, planExpiryReminder, recordDelivery,
  type ReminderChannel, type ReminderLedger, type ReminderNotice,
} from "../lib/quota-reminder-rules.js";
import type { RemoteView } from "../lib/quota-scheduler.js";

const QUIET_START_H = 23;
const QUIET_END_H = 8;

/** 本机时区的夜间（23:00–08:00） */
export function inQuietHours(now: number): boolean {
  const h = new Date(now).getHours();
  return h >= QUIET_START_H || h < QUIET_END_H;
}

/** 这段夜间结束的时刻（本机时区的下一个 08:00）；不在夜间 = now */
export function quietEndsAt(now: number): number {
  if (!inQuietHours(now)) return now;
  const d = new Date(now);
  if (d.getHours() >= QUIET_START_H) d.setDate(d.getDate() + 1);
  d.setHours(QUIET_END_H, 0, 0, 0);
  return d.getTime();
}

/** 夜间也要立刻发：有 credit 等不到天亮就过期 */
export function urgentAtNight(n: ReminderNotice, now: number): boolean {
  const end = quietEndsAt(now);
  return n.kind === "expiry" && (n.credits ?? []).some((c) => c.expiresAtMs <= end);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** MM-DD HH:mm（本机时区） */
export function fmtLocal(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const REDEEM_HINT = () => t("需要时在 codex 里 /status → Redeem usage limit reset。", "When needed: /status in codex → Redeem usage limit reset.");

function windowName(id: string): string {
  if (id === "5h") return t("5 小时窗口", "5-hour window");
  if (id === "7d") return t("本周窗口", "weekly window");
  return t(`${id} 窗口`, `${id} window`);
}

/** 一条通知的正文（不含标题） */
export function noticeBody(n: ReminderNotice): string {
  if (n.kind === "expiry") {
    const cs = n.credits ?? [];
    const when = cs.map((c) => fmtLocal(c.expiresAtMs)).join(t("、", ", "));
    return t(
      `Codex 有 ${cs.length} 次免费额度重置 ${when} 到期，还没用。${REDEEM_HINT()}`,
      `Codex has ${cs.length} unused free usage reset${cs.length > 1 ? "s" : ""} expiring ${when}. ${REDEEM_HINT()}`,
    );
  }
  const e = n.exhausted;
  const k = e?.applicable ?? 0;
  const win = e ? windowName(e.windowId) : "";
  return t(`Codex 额度用满了（${win}），你有 ${k} 次重置此刻可用。${REDEEM_HINT()}`, `Codex usage is maxed out (${win}); ${k} reset${k > 1 ? "s" : ""} can be redeemed now. ${REDEEM_HINT()}`);
}

const noticeTitle = () => t("Codex 额度重置", "Codex usage resets");

/** 规划：只看 Codex 当前账户；陈旧 / 账户不确定由规则自己拒 */
function planReminders(ledger: ReminderLedger, view: RemoteView, now: number): ReminderLedger {
  const c = view.codex;
  if (!c.account) return ledger;
  const base = { accountKey: c.account.key, now, uncertain: c.account.uncertain };
  let next = ledger;
  const detail = c.endpoints.codex_reset_credits;
  if (detail?.snapshot) next = planExpiryReminder(next, detail.snapshot.data.credits, { ...base, stale: detail.stale }).ledger;
  const usage = c.endpoints.codex_usage;
  if (usage?.snapshot) next = planExhaustedReminder(next, usage.snapshot.data, { ...base, stale: usage.stale }).ledger;
  return next;
}

export interface ReminderSenders {
  /** 推送子系统没起来 = null */
  push(title: string, body: string): Promise<{ sent: number; failed: number } | null>;
  discord(text: string): Promise<boolean>;
}

export interface ReminderLedgerApi {
  withReminders(fn: (ledger: ReminderLedger, view: RemoteView) => ReminderLedger): Promise<ReminderLedger>;
}

async function send(channel: ReminderChannel, notices: ReminderNotice[], s: ReminderSenders): Promise<boolean> {
  const body = notices.map(noticeBody).join("\n");
  try {
    if (channel === "discord") return await s.discord(`**${noticeTitle()}**\n${body}`);
    const r = await s.push(noticeTitle(), body);
    return r !== null && (r.sent > 0 || r.failed === 0);
  } catch (e) {
    console.error(`[quota] 提醒投递失败（${channel}）：${(e as Error)?.name ?? "unknown"}`);
    return false;
  }
}

/** 一轮：规划 → 按渠道把到期该投的合并成一条发出 → 逐条记投递结果（账本落盘，重启后去重仍在） */
export async function runReminders(api: ReminderLedgerApi, senders: ReminderSenders, now: number): Promise<void> {
  const ledger = await api.withReminders((l, view) => planReminders(l, view, now));
  const quiet = inQuietHours(now);
  const byChannel = new Map<ReminderChannel, ReminderNotice[]>();
  for (const { notice, channel } of pendingDeliveries(ledger, now)) {
    if (quiet && !urgentAtNight(notice, now)) continue;
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), notice]);
  }
  for (const [channel, notices] of byChannel) {
    const ok = await send(channel, notices, senders);
    await api.withReminders((l) => notices.reduce((acc, n) => recordDelivery(acc, n.id, channel, ok, now), l));
  }
}
