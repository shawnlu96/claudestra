/**
 * 订阅额度的三个只读请求（设计稿 T2b §2 / §5）：
 *   Claude  GET https://api.anthropic.com/api/oauth/usage
 *   Codex   GET https://chatgpt.com/backend-api/wham/usage
 *   Codex   GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
 *
 * 唯一入口 getQuota 没有 method 参数、地址只能从固定表里选：兑换 / 购买类接口（真实消费、不可逆）
 * 在这里根本拼不出来。拒绝重定向（manual + 3xx 即失败）、超时 5 秒、响应体流式读且上限 256 KiB。
 * 失败只给固定错误码，不带响应体、不带异常原文（响应里有 email 等 PII）。
 * 单测 tests/quota-providers.test.ts（全部假 fetch）。
 */

import type { QuotaCredential, QuotaProvider } from "./quota-credentials.js";
import {
  parseClaudeUsage,
  parseCodexResetCredits,
  parseCodexUsage,
  type ClaudeUsageDto,
  type CodexResetCreditsDto,
  type CodexUsageDto,
} from "./quota-dto.js";
import { readStreamCapped } from "./quota-keychain.js";

export type QuotaEndpoint = "claude_usage" | "codex_usage" | "codex_reset_credits";

const endpoint = (provider: QuotaProvider, url: string) => Object.freeze({ provider, url });

/** 逐条冻结：表本身和每一项都改不了（运行时有人改地址会直接抛 TypeError） */
export const QUOTA_ENDPOINTS: Readonly<Record<QuotaEndpoint, Readonly<{ provider: QuotaProvider; url: string }>>> = Object.freeze({
  claude_usage: endpoint("claude", "https://api.anthropic.com/api/oauth/usage"),
  codex_usage: endpoint("codex", "https://chatgpt.com/backend-api/wham/usage"),
  codex_reset_credits: endpoint("codex", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"),
});

/** 第二道闸：就算表被绕过，也只往这两个 HTTPS origin 发 */
const ALLOWED_ORIGINS = new Set(["https://api.anthropic.com", "https://chatgpt.com"]);

function assertAllowedUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_ORIGINS.has(u.origin)) throw new Error("quota endpoint 不在白名单 origin 内");
}

export interface DtoMap {
  claude_usage: ClaudeUsageDto;
  codex_usage: CodexUsageDto;
  codex_reset_credits: CodexResetCreditsDto;
}

export type FetchErrorCode =
  | "timeout"
  | "network"
  | "redirect"
  | "too_large"
  | "http_401"
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_4xx"
  | "http_5xx"
  | "bad_json"
  | "bad_shape";

export type FetchOutcome<T> = { ok: true; data: T } | { ok: false; code: FetchErrorCode; retryAfterMs?: number };

export type QuotaFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

const QUOTA_TIMEOUT_MS = 5000;
export const QUOTA_BODY_CAP = 256 * 1024;

/** 流式读正文，超过上限立刻 cancel（不把一个异常大的响应整个读进内存） */
export async function readCappedBody(res: Response, capBytes = QUOTA_BODY_CAP): Promise<{ ok: true; text: string } | { ok: false }> {
  const text = await readStreamCapped(res.body, capBytes);
  return text === null ? { ok: false } : { ok: true, text };
}

const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 6 * 3600_000;

/** Retry-After：秒数或 HTTP-date；钳在 [60s, 6h]，认不出返回 null（调用方用默认冷却） */
export function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  const t = v.trim();
  let ms: number | null = null;
  if (/^\d{1,9}$/.test(t)) ms = Number(t) * 1000;
  else {
    const at = Date.parse(t);
    if (Number.isFinite(at)) ms = at - nowMs;
  }
  return ms === null ? null : Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, ms));
}

function statusCode(status: number): FetchErrorCode {
  if (status === 401) return "http_401";
  if (status === 403) return "http_403";
  if (status === 404) return "http_404";
  if (status === 429) return "http_429";
  return status >= 500 ? "http_5xx" : "http_4xx";
}

function parseFor<E extends QuotaEndpoint>(endpoint: E, json: unknown, hashCreditId: (rawId: string) => string): DtoMap[E] | null {
  if (endpoint === "claude_usage") return parseClaudeUsage(json) as DtoMap[E] | null;
  if (endpoint === "codex_usage") return parseCodexUsage(json) as DtoMap[E] | null;
  return parseCodexResetCredits(json, hashCreditId) as DtoMap[E] | null;
}

/** 把非 2xx 的正文丢掉：不读、不记，只释放连接 */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => {}); // 只是释放连接，失败不影响已经定下的错误码
}

export async function getQuota<E extends QuotaEndpoint>(
  endpoint: E,
  cred: QuotaCredential,
  deps: { fetch: QuotaFetch; now: () => number; timeoutMs?: number; hashCreditId: (rawId: string) => string },
): Promise<FetchOutcome<DtoMap[E]>> {
  const target = QUOTA_ENDPOINTS[endpoint];
  if (!target || target.provider !== cred.provider) throw new Error(`quota endpoint ${endpoint} 与凭据 ${cred.provider} 不匹配`);
  assertAllowedUrl(target.url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? QUOTA_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await deps.fetch(target.url, {
        method: "GET",
        headers: { Accept: "application/json", ...cred.authHeaders() },
        redirect: "manual",
        signal: ctrl.signal,
      });
    } catch {
      return { ok: false, code: ctrl.signal.aborted ? "timeout" : "network" }; // 异常原文可能带请求细节，只留错误码
    }
    if (res.type === "opaqueredirect" || res.redirected || (res.status >= 300 && res.status < 400)) {
      discardBody(res);
      return { ok: false, code: "redirect" };
    }
    if (res.status < 200 || res.status >= 300) {
      discardBody(res);
      const code = statusCode(res.status);
      const retryAfterMs = code === "http_429" ? parseRetryAfter(res.headers.get("retry-after"), deps.now()) : null;
      return retryAfterMs === null ? { ok: false, code } : { ok: false, code, retryAfterMs };
    }
    let body: Awaited<ReturnType<typeof readCappedBody>>;
    try {
      body = await readCappedBody(res);
    } catch {
      return { ok: false, code: ctrl.signal.aborted ? "timeout" : "network" }; // 读正文中途断开 / 超时，原文不外传
    }
    if (!body.ok) return { ok: false, code: "too_large" };
    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      return { ok: false, code: "bad_json" }; // 不是 JSON（常见是登录页 / 风控页），正文不记
    }
    const data = parseFor(endpoint, json, deps.hashCreditId);
    return data ? { ok: true, data } : { ok: false, code: "bad_shape" };
  } finally {
    clearTimeout(timer);
  }
}
