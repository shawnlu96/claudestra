/**
 * 使用一张 Codex 重置卡——真实消费、不可逆，只在 owner 网页上二次确认后由 bridge/local-api/quota.ts 触发。
 *
 *   POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume
 *   body { redeem_request_id: <每次尝试一个新 UUID>, credit_id: <原始 credit id> }
 *   → { code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed", windows_reset }
 * 形状照官方 codex CLI（openai/codex codex-rs/backend-client/src/client/rate_limit_resets.rs；本机 codex 0.159.3 二进制里
 * 同一路径与字段名），请求头与只读 GET 同一份（cred.authHeaders()）。
 *
 * POST 之前现拉两份只读数据核对：额度里「此刻可用」≥ 1、明细里这张卡（HMAC 键对得上）仍可用，任何一步不过就不发；
 * 发之前最后再由调用方复验一次开关 / 代际 / 当前凭据（beforePost）。
 * 发出去之后不管成败都再拉一次两份数据交给调用方入库。POST 从不自动重发：换个请求号重发就是再扣一张。
 * 单测 tests/quota-consume.test.ts（全部假 fetch）。
 */

import { randomUUID } from "node:crypto";
import type { CredErrorCode, QuotaCredential } from "./quota-credentials.js";
import { parseCodexResetCredits, type CodexResetCreditsDto, type CodexUsageDto } from "./quota-dto.js";
import { fetchJsonCapped, getQuota, QUOTA_ENDPOINTS, requestJsonCapped, type FetchErrorCode, type QuotaFetch } from "./quota-providers.js";
import { isEligibleCredit } from "./quota-reminder-rules.js";

export const CODEX_CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
/** 官方客户端同值；比只读 GET 的 5 秒宽：超时只能报「扣没扣不知道」，宁可多等一会儿拿到确切答复 */
const CONSUME_TIMEOUT_MS = 10_000;

export type ConsumeFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

const UPSTREAM_CODES = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"] as const;

export type ConsumeResult =
  /** 上游答复了。reset / already_redeemed（同一个请求号已兑过）= 用掉了；nothing_to_reset / no_credit = 上游拒了，没扣 */
  | { status: "done"; code: (typeof UPSTREAM_CODES)[number]; windowsReset: number }
  /** 核对没过（或开关关着、凭据读不到），POST 没发：一定没扣 */
  | { status: "refused"; code: "not_applicable" | "credit_unavailable" | "disabled" | "internal" | CredErrorCode | FetchErrorCode }
  /** POST 发了但没拿到可认的答复：扣没扣不知道，以刷新后的数字为准 */
  | { status: "failed"; code: FetchErrorCode };

export interface ConsumeDeps {
  fetch: QuotaFetch;
  post: ConsumeFetch;
  now(): number;
  /** HMAC(本机密钥, 账户键 + credit.id)，与看板里的 key 同一口径 */
  hashCreditId(rawId: string): string;
  /**
   * 不可逆的 POST 紧前复验（开关、代际、当前凭据）：核对那两次 GET 期间开关可能被关、账户可能被换。
   * 返回拒绝码就不发；它返回之后到 POST 发出之间没有别的 await。
   */
  beforePost(): Promise<"disabled" | "identity_changed" | null>;
}

export interface ConsumeRun {
  result: ConsumeResult;
  /** 现拉到的最新数据（POST 之后那次）；拉不到 null，调用方保留旧快照 */
  usage: CodexUsageDto | null;
  credits: CodexResetCreditsDto | null;
}

/** 默认最早到期的那张可用卡；指定了键就只认那张（也得仍可用）。返回原始 id——它只出现在这里和 POST 体里 */
function pickRawId(json: unknown, credits: CodexResetCreditsDto, key: string | null, deps: ConsumeDeps): string | null {
  const now = deps.now();
  const usable = credits.credits.filter((c) => isEligibleCredit(c, now)).sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  const want = key === null ? usable[0] : usable.find((c) => c.key === key);
  if (!want) return null;
  const list = (json as { credits?: unknown[] }).credits ?? [];
  for (const c of list) {
    const id = (c as { id?: unknown } | null)?.id;
    if (typeof id === "string" && deps.hashCreditId(id) === want.key) return id;
  }
  return null;
}

async function postConsume(cred: QuotaCredential, rawId: string, deps: ConsumeDeps): Promise<ConsumeResult> {
  const body = JSON.stringify({ redeem_request_id: randomUUID(), credit_id: rawId });
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...cred.authHeaders() };
  const r = await requestJsonCapped(
    (signal) => deps.post(CODEX_CONSUME_URL, { method: "POST", headers, body, redirect: "manual", signal }),
    { now: deps.now, timeoutMs: CONSUME_TIMEOUT_MS },
  );
  if (!r.ok) return { status: "failed", code: r.code };
  const j = r.data as { code?: unknown; windows_reset?: unknown } | null;
  const code = UPSTREAM_CODES.find((c) => c === j?.code);
  if (!code) return { status: "failed", code: "bad_shape" }; // 2xx 却认不出：可能已经扣了，按「不知道」报
  const w = j?.windows_reset;
  return { status: "done", code, windowsReset: typeof w === "number" && Number.isInteger(w) && w >= 0 && w < 100 ? w : 0 };
}

/** POST 之后的刷新：只读、失败只是看板晚一点更新，不能盖掉已经拿到的消费结果 */
async function refreshAfter(cred: QuotaCredential, deps: ConsumeDeps): Promise<Pick<ConsumeRun, "usage" | "credits">> {
  try {
    const [u, c] = await Promise.all([getQuota("codex_usage", cred, deps), getQuota("codex_reset_credits", cred, deps)]);
    return { usage: u.ok ? u.data : null, credits: c.ok ? c.data : null };
  } catch {
    return { usage: null, credits: null }; // hashCreditId 抛（密钥没了）：消费结果照旧返回，看板等下一次查询
  }
}

export async function consumeCodexResetCredit(cred: QuotaCredential, creditKey: string | null, deps: ConsumeDeps): Promise<ConsumeRun> {
  const usage = await getQuota("codex_usage", cred, deps);
  if (!usage.ok) return { result: { status: "refused", code: usage.code }, usage: null, credits: null };
  if ((usage.data.resetCredits?.applicableAvailableCount ?? 0) < 1) return { result: { status: "refused", code: "not_applicable" }, usage: usage.data, credits: null };
  const raw = await fetchJsonCapped(QUOTA_ENDPOINTS.codex_reset_credits.url, cred.authHeaders(), deps);
  const credits = raw.ok ? parseCodexResetCredits(raw.data, deps.hashCreditId) : null;
  if (!raw.ok) return { result: { status: "refused", code: raw.code }, usage: usage.data, credits: null };
  if (!credits) return { result: { status: "refused", code: "bad_shape" }, usage: usage.data, credits: null };
  const rawId = pickRawId(raw.data, credits, creditKey, deps);
  if (!rawId) return { result: { status: "refused", code: "credit_unavailable" }, usage: usage.data, credits };
  const stop = await deps.beforePost();
  if (stop) return { result: { status: "refused", code: stop }, usage: null, credits: null }; // 开关已关 / 换了号：这份数据也不该入库
  const result = await postConsume(cred, rawId, deps);
  return { result, ...(await refreshAfter(cred, deps)) };
}
