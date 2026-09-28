/**
 * Codex 重置次数的提醒规则（纯函数；设计稿 T2b §4 / §6.1）。真正的投递在 bridge/quota-reminders.ts（T2b-2）。
 *
 *   - 快过期：一条可用重置在 72 小时内过期提醒一次，24 小时内再一次；首次看到就已进 24 小时 → 只发这一条、
 *     72 小时档记为已覆盖。同一次计算里命中的多条合并成一条通知（睡眠唤醒后的积压也就合并了）。
 *   - 去重按 credit.key（HMAC(本机密钥, 账户键 + credit.id)）：两条可能同日到期，不能拿 expires_at 去重。
 *   - 用满：窗口 100% 或 limit_reached，且此刻真能兑换的次数 > 0 → 同一个窗口（id + 重置时刻）只提醒一次。
 *   - 陈旧数据、账户不确定（401 / 凭据缺一方）一律不出提醒。
 *   - 推送与 Discord 分别记投递状态：失败的渠道单独按退避重试，已成功的不重发。
 * 账本存在 quota-state.json（经 quota-scheduler 的 store），重启后去重仍有效。单测 tests/quota-reminder-rules.test.ts。
 */

import { TS_MAX_MS, type CodexUsageDto, type ResetCreditDto } from "./quota-dto.js";

export type ReminderChannel = "push" | "discord";
const REMINDER_CHANNELS: readonly ReminderChannel[] = ["push", "discord"];
/** 快过期阈值（小时），从宽到紧 */
const EXPIRY_THRESHOLDS_H = [72, 24] as const;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 失败渠道的重试退避：5 分钟起翻倍，封顶 6 小时；通知超过 3 天还没送达就放弃 */
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * HOUR;
const NOTICE_TTL_MS = 3 * DAY;

interface ChannelDelivery {
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastAt: number | null;
}

export interface ReminderNotice {
  id: string;
  kind: "expiry" | "exhausted";
  accountKey: string;
  createdAt: number;
  /** expiry：本次涉及的重置（到期时刻 + 命中的阈值小时数） */
  credits?: { key: string; expiresAtMs: number; thresholdH: number }[];
  /** exhausted：此刻可兑换次数与撞满的窗口 */
  exhausted?: { applicable: number; windowId: string; resetsAtMs: number | null };
  channels: Record<ReminderChannel, ChannelDelivery>;
}

export interface ReminderLedger {
  /** credit.key → 已覆盖的阈值（小时）与到期时刻（用于清理） */
  credits: Record<string, { expiresAtMs: number; coveredH: number[] }>;
  /** 用满提醒：窗口键 → 提醒时刻 */
  exhausted: Record<string, number>;
  outbox: ReminderNotice[];
}

export function emptyLedger(): ReminderLedger {
  return { credits: {}, exhausted: {}, outbox: [] };
}

export interface PlanContext {
  accountKey: string;
  now: number;
  /** 数据陈旧（最近一次查询失败、或太久没查） */
  stale: boolean;
  /** 账户不确定（401、凭据缺一方） */
  uncertain: boolean;
}

/** 「未用、快过期」的资格：可用、套餐支持、没兑换也没开始兑换、还没过期——缺一不可 */
export function isEligibleCredit(c: ResetCreditDto, now: number): boolean {
  const expiryOk = Number.isFinite(c.expiresAtMs) && c.expiresAtMs > now && c.expiresAtMs < TS_MAX_MS;
  return c.status === "available" && c.supportedByPlan && !c.redeemed && !c.redeemStarted && expiryOk;
}

function newNotice(kind: ReminderNotice["kind"], ctx: PlanContext, tag: string): ReminderNotice {
  const channels = Object.fromEntries(REMINDER_CHANNELS.map((c) => [c, { status: "pending", attempts: 0, lastAt: null }]));
  return {
    id: `${kind}-${ctx.now.toString(36)}-${tag.slice(0, 8)}`,
    kind,
    accountKey: ctx.accountKey,
    createdAt: ctx.now,
    channels: channels as ReminderNotice["channels"],
  };
}

export function planExpiryReminder(
  ledger: ReminderLedger,
  credits: ResetCreditDto[],
  ctx: PlanContext,
): { ledger: ReminderLedger; notice: ReminderNotice | null } {
  if (ctx.stale || ctx.uncertain) return { ledger, notice: null };
  const next: ReminderLedger = { ...ledger, credits: { ...ledger.credits } };
  const hits: NonNullable<ReminderNotice["credits"]> = [];
  for (const c of credits) {
    if (!isEligibleCredit(c, ctx.now)) continue;
    const left = c.expiresAtMs - ctx.now;
    const covered = next.credits[c.key]?.coveredH ?? [];
    const due = EXPIRY_THRESHOLDS_H.filter((h) => left <= h * HOUR);
    const fresh = due.filter((h) => !covered.includes(h));
    if (!fresh.length) continue;
    // 首次就已进 24 小时：只发最紧的一档，更宽的档一并记为已覆盖
    hits.push({ key: c.key, expiresAtMs: c.expiresAtMs, thresholdH: Math.min(...fresh) });
    next.credits[c.key] = { expiresAtMs: c.expiresAtMs, coveredH: [...new Set([...covered, ...due])].sort((a, b) => b - a) };
  }
  if (!hits.length) return { ledger, notice: null };
  const notice = { ...newNotice("expiry", ctx, hits[0].key), credits: hits.sort((a, b) => a.expiresAtMs - b.expiresAtMs) };
  next.outbox = [...ledger.outbox, notice];
  return { ledger: next, notice };
}

export function planExhaustedReminder(
  ledger: ReminderLedger,
  usage: CodexUsageDto,
  ctx: PlanContext,
): { ledger: ReminderLedger; notice: ReminderNotice | null } {
  const applicable = usage.resetCredits?.applicableAvailableCount ?? 0;
  if (ctx.stale || ctx.uncertain || applicable <= 0) return { ledger, notice: null };
  const full = usage.windows.filter((w) => w.usedPct >= 100);
  if (!full.length && !usage.limitReached) return { ledger, notice: null };
  // limit_reached 但没有哪个窗口到 100%：取用得最多的那个窗口当「这一轮」的标识
  const w = full[0] ?? [...usage.windows].sort((a, b) => b.usedPct - a.usedPct)[0];
  if (!w) return { ledger, notice: null };
  const windowKey = `${ctx.accountKey}|${w.id}|${w.resetsAtMs ?? "?"}`;
  if (ledger.exhausted[windowKey] !== undefined) return { ledger, notice: null };
  const notice = { ...newNotice("exhausted", ctx, windowKey), exhausted: { applicable, windowId: w.id, resetsAtMs: w.resetsAtMs } };
  return { ledger: { ...ledger, exhausted: { ...ledger.exhausted, [windowKey]: ctx.now }, outbox: [...ledger.outbox, notice] }, notice };
}

function retryDue(d: ChannelDelivery, now: number): boolean {
  if (d.status === "pending") return true;
  if (d.status !== "failed" || d.lastAt === null) return false;
  return now - d.lastAt >= Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, d.attempts - 1));
}

/** 现在该投哪些（通知, 渠道）：没投过的、失败且退避已到的；已成功的渠道永不重发 */
export function pendingDeliveries(ledger: ReminderLedger, now: number): { notice: ReminderNotice; channel: ReminderChannel }[] {
  const out: { notice: ReminderNotice; channel: ReminderChannel }[] = [];
  for (const notice of ledger.outbox) {
    for (const channel of REMINDER_CHANNELS) if (retryDue(notice.channels[channel], now)) out.push({ notice, channel });
  }
  return out;
}

export function recordDelivery(ledger: ReminderLedger, noticeId: string, channel: ReminderChannel, ok: boolean, now: number): ReminderLedger {
  return {
    ...ledger,
    outbox: ledger.outbox.map((n) => {
      if (n.id !== noticeId) return n;
      const prev = n.channels[channel];
      const d: ChannelDelivery = { status: ok ? "sent" : "failed", attempts: prev.attempts + 1, lastAt: now };
      return { ...n, channels: { ...n.channels, [channel]: d } };
    }),
  };
}

/** 清理：全渠道已送达或超过 3 天的通知、过期一天以上的 credit 记录、8 天前的用满记录 */
export function pruneLedger(ledger: ReminderLedger, now: number): ReminderLedger {
  const outbox = ledger.outbox.filter(
    (n) => now - n.createdAt < NOTICE_TTL_MS && REMINDER_CHANNELS.some((c) => n.channels[c].status !== "sent"),
  );
  const credits = Object.fromEntries(Object.entries(ledger.credits).filter(([, v]) => v.expiresAtMs > now - DAY));
  const exhausted = Object.fromEntries(Object.entries(ledger.exhausted).filter(([, at]) => now - at < 8 * DAY));
  return { credits, exhausted, outbox };
}
