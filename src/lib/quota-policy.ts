/**
 * 订阅额度调度的纯策略（从 quota-scheduler.ts 原样搬出，免得调度器超 400 行）：节奏常量、失败分类与冷却、
 * 发请求前的闸门判定。调度器重新导出其中的公共名字，调用方照旧从 quota-scheduler.js 引。单测 tests/quota-scheduler.test.ts。
 */

import type { CredErrorCode } from "./quota-credentials.js";
import type { FetchErrorCode, QuotaEndpoint } from "./quota-providers.js";
import type { AccountState, CredHealth, EndpointHealth } from "./quota-state.js";

export const MIN = 60_000;
const HOUR = 60 * MIN;
export const QUOTA_TIMING = {
  minIntervalMs: MIN,
  /** 看板有人看：每家额度 5 分钟一次；重置明细 30 分钟一次（汇总数已随额度一起来） */
  viewIntervalMs: 5 * MIN,
  detailViewIntervalMs: 30 * MIN,
  /** 没人看：只为快过期提醒查 Codex 重置明细 */
  detailBackgroundIntervalMs: 6 * HOUR,
  /** 两次 tick 间隔超过它 = 睡眠唤醒，立刻重查 */
  wakeGapMs: 15 * MIN,
  authCooldownMs: 30 * MIN,
  rateLimitDefaultMs: 15 * MIN,
  pauseMs: 24 * HOUR,
  /** 额度快照超过这个年龄算陈旧；重置明细按后台节奏放宽 */
  usageStaleMs: 10 * MIN,
  detailStaleMs: 7 * HOUR,
} as const;

export type RefreshReason = "view" | "manual" | "background" | "wake" | "user_retry";
type QuotaErrorCode = FetchErrorCode | CredErrorCode | "internal";
export type RefreshResult =
  | { status: "fetched" | "skipped_interval" | "skipped_paused" | "skipped_policy" | "disabled" | "discarded" }
  | { status: "skipped_cooldown"; code: QuotaErrorCode }
  | { status: "failed"; code: QuotaErrorCode };


const PAUSE_CODES = new Set<FetchErrorCode>(["http_404", "bad_shape", "bad_json", "redirect", "too_large", "http_4xx"]);
// 403 也走退避：它会偶发，按长冷却处理会让额度卡挂着几小时前的旧数；真被拒也只是封顶每小时试一次
const BACKOFF_CODES = new Set<FetchErrorCode>(["timeout", "network", "http_5xx", "http_403"]);

/** 网络 / 超时 / 5xx 的退避：60s 起翻倍、封顶 1 小时，±20% 抖动 */
export function backoffMs(failures: number, random: number): number {
  const base = Math.min(HOUR, MIN * 2 ** Math.max(0, failures - 1));
  return Math.round(base * (0.8 + 0.4 * random));
}

export function freshHealth(): EndpointHealth {
  return { lastCode: null, lastAttemptAt: null, failures: 0, cooldownUntil: null, authFingerprint: null, paused: false };
}

/** 一次失败 → 端点健康（与账户级 429 冷却）怎么变 */
export function applyFailure(
  acct: AccountState,
  h: EndpointHealth,
  out: { code: FetchErrorCode; retryAfterMs?: number },
  ctx: { now: number; fingerprint: string; random: number },
): void {
  h.lastCode = out.code;
  h.failures += 1;
  h.authFingerprint = null;
  h.paused = false;
  if (out.code === "http_401") {
    h.cooldownUntil = ctx.now + QUOTA_TIMING.authCooldownMs;
    h.authFingerprint = ctx.fingerprint;
    acct.uncertain = true;
  } else if (out.code === "http_429") {
    h.cooldownUntil = null;
    acct.rateLimitedUntil = ctx.now + (out.retryAfterMs ?? QUOTA_TIMING.rateLimitDefaultMs);
  } else if (BACKOFF_CODES.has(out.code)) h.cooldownUntil = ctx.now + backoffMs(h.failures, ctx.random);
  else if (PAUSE_CODES.has(out.code)) {
    h.paused = true;
    h.cooldownUntil = ctx.now + QUOTA_TIMING.pauseMs;
  }
}

/** 凭据读取失败的冷却：Keychain 被拒 / 超时 / 异常只认用户重试；读不到条目 30 分钟；其它（读文件，便宜）1 分钟 */
export function credCooldown(code: CredErrorCode, now: number): number | null {
  if (code === "keychain_denied" || code === "keychain_timeout" || code === "keychain_error") return null;
  if (code === "keychain_missing") return now + QUOTA_TIMING.authCooldownMs;
  // 读完 Keychain 才发现的错（token 过期、条目内容认不出、读取期间换号）：至少 5 分钟，不然看板开着每分钟读一次
  if (code === "token_expired" || code === "auth_bad_shape" || code === "identity_changed") return now + 5 * MIN;
  return now + MIN;
}

/**
 * 凭据失败后的闸（在读任何凭据之前判）：
 *  - 用户主动重试也守 60 秒最小间隔；
 *  - 失败时刻在「现在」之后 = 时钟被拨回过：不按它挡；
 *  - until = null（Keychain 被拒 / 超时 / 出错）：看板不自己重读，后台按自己的 6 小时节奏照试（每次试都算进 bgAttemptAt），
 *    只有 Keychain 连续被拒 2 次才连后台也停，等用户重试。
 */
export function credBlocked(ch: CredHealth | undefined, reason: RefreshReason, now: number): RefreshResult | null {
  if (!ch || ch.at > now) return null;
  if (reason === "user_retry") return now - ch.at < QUOTA_TIMING.minIntervalMs ? { status: "skipped_interval" } : null;
  if (ch.until !== null) return ch.until > now ? { status: "skipped_cooldown", code: ch.code } : null;
  if (reason === "background" && !(ch.code === "keychain_denied" && (ch.count ?? 1) >= 2)) return null;
  return { status: "skipped_cooldown", code: ch.code };
}
/** 这些失败说明「现在不知道是哪个账户」：当前账户清空，不再把旧账户的卡片当成它 */
export const ACCOUNT_UNKNOWN = new Set<CredErrorCode>(["no_secret", "auth_missing", "auth_bad_shape", "account_missing", "keychain_missing"]);

export type Gate = Exclude<RefreshResult, { status: "fetched" | "failed" | "disabled" | "discarded" }> | null;

/**
 * 端点当前能不能发。fingerprint = null（还没读凭据）时：401 冷却中、距上次核对指纹不到看板节奏 → 不读 Keychain 直接挡；
 * 过了节奏（或用户主动重试）才放行去读凭据，读完再按指纹判。
 */
export function gate(acct: AccountState, endpoint: QuotaEndpoint, now: number, reason: RefreshReason, fingerprint: string | null): Gate {
  if (acct.rateLimitedUntil !== null && acct.rateLimitedUntil > now) return { status: "skipped_cooldown", code: "http_429" };
  const h = acct.health[endpoint];
  if (h?.paused && reason !== "user_retry" && (h.cooldownUntil ?? Infinity) > now) return { status: "skipped_paused" };
  const lastAny = Math.max(-Infinity, ...Object.values(acct.health).map((x) => x?.lastAttemptAt ?? -Infinity));
  // 上次尝试在「现在」之后 = 时钟被拨回过：间隔与冷却都是按错的时钟算的，不按它们挡（否则要停到时钟追上）
  if (lastAny > now) return null;
  if (now - lastAny < QUOTA_TIMING.minIntervalMs) return { status: "skipped_interval" };
  if (!h || h.paused || h.cooldownUntil === null || h.cooldownUntil <= now || !h.lastCode) return null;
  const cooling = { status: "skipped_cooldown", code: h.lastCode } as const;
  if (reason === "user_retry" && h.lastCode === "http_403") return null; // 界面给 403 留了「重试」：用户点了就不等退避
  if (h.lastCode !== "http_401") return cooling;
  if (fingerprint !== null) return fingerprint === h.authFingerprint ? cooling : null;
  const checked = h.credCheckedAt ?? h.lastAttemptAt;
  return reason !== "user_retry" && checked !== null && now - checked < QUOTA_TIMING.viewIntervalMs ? cooling : null;
}
