/**
 * 订阅额度测试的共用夹具：响应样例照 T2a 报告的实测形状（docs/tasks/T2a.report.md），外加故意塞进去的
 * PII / 未知字段，用来证明白名单 DTO 挡得住。凭据、账户 id、email 全是假的哨兵串，断言「任何输出里都找不到它们」。
 * 不调真实接口、不读真实 Keychain、不读真实家目录。
 */

import type { ConsumeFetch } from "../src/lib/quota-consume.js";
import type { CredDeps, KeychainOutcome } from "../src/lib/quota-credentials.js";
import type { QuotaFetch } from "../src/lib/quota-providers.js";

export const SECRET = Buffer.alloc(32, 7);
export const CLAUDE_TOKEN = "sk-ant-oat01-SENTINEL-CLAUDE-TOKEN";
export const CLAUDE_ACCOUNT = "c0ffee00-raw-claude-account-uuid";
export const CODEX_TOKEN = "eyJ-SENTINEL-CODEX-TOKEN";
export const CODEX_ACCOUNT = "raw-codex-account-id-0001";
const EMAIL = "leak@example.com";
export const CREDIT_IDS = ["rlrc_RAWCREDITID_A", "rlrc_RAWCREDITID_B"];
export const GRANT_IDS = ["grant_RAWGRANTID_A", "grant_RAWGRANTID_B"];
/** 这些串出现在任何 DTO / 状态文件 / 结果里都算泄漏 */
const SENTINELS = [CLAUDE_TOKEN, CLAUDE_ACCOUNT, CODEX_TOKEN, CODEX_ACCOUNT, EMAIL, ...CREDIT_IDS, ...GRANT_IDS, "user-RAW-0001", "UNKNOWN_FUTURE", "LABEL-SENTINEL"];

export const T0 = Date.parse("2026-09-28T09:00:00.000Z");

export function claudeUsageBody(): Record<string, unknown> {
  return {
    five_hour: { utilization: 6.0, resets_at: "2026-09-28T16:10:00Z", limit_dollars: null, locked_reason: null },
    seven_day: { utilization: 74.0, resets_at: "2026-09-30T06:00:00Z" },
    seven_day_opus: null,
    extra_usage: { is_enabled: false, monthly_limit: null },
    limits: [
      { kind: "session", group: "session", percent: 6, severity: "normal", resets_at: "2026-09-28T16:10:00Z", is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 74, severity: "normal", resets_at: "2026-09-30T06:00:00Z", is_active: false },
      {
        kind: "weekly_scoped", group: "weekly", percent: 100, severity: "critical", resets_at: "2026-09-30T06:00:00Z",
        scope: { model: { id: null, display_name: "Fable" } }, is_active: true, secret_note: "UNKNOWN_FUTURE",
      },
    ],
    spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, enabled: false },
    seven_day_breakdown: { rows: [{ key: "claude_code", percent: 100 }] },
    account_email: EMAIL,
    UNKNOWN_FUTURE: { nested: EMAIL },
  };
}

/**
 * Claude 的重置卡块（/api/oauth/usage?cedar_ember=1，形状取自 CC 2.1.283 二进制里的字段名）。grant 原始 id、label、
 * clears、next_grant_id 都是哨兵：解析结果里一个都不能有。
 */
export function cedarEmberBlock(grants: { endsAt: string; left?: number; usableNow?: boolean; requiresLimit?: boolean; paused?: boolean }[] = [
  { endsAt: "2026-10-01T09:00:00Z" },
  { endsAt: "2026-10-20T09:00:00Z", left: 2, usableNow: true, requiresLimit: false },
]): Record<string, unknown> {
  return {
    eligible: true,
    at_limit: false,
    weekly_resets_at: "2026-09-30T06:00:00Z",
    cooldown_until: null,
    next_grant_id: GRANT_IDS[1],
    grants: grants.map((g, i) => ({
      id: GRANT_IDS[i % 2] + (i > 1 ? i : ""),
      label: "LABEL-SENTINEL",
      resets_total: 3,
      resets_left: g.left ?? 1,
      starts_at: "2026-09-01T00:00:00Z",
      ends_at: g.endsAt,
      clears: ["weekly", EMAIL],
      paused: g.paused ?? false,
      usable_now: g.usableNow ?? false,
      ...(g.requiresLimit === undefined ? {} : { use_requires_limit: g.requiresLimit }),
      percent_used: 0,
      blocking: false,
    })),
    UNKNOWN_FUTURE: EMAIL,
  };
}

export function codexUsageBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: "user-RAW-0001",
    account_id: CODEX_ACCOUNT,
    email: EMAIL,
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 36, limit_window_seconds: 18000, reset_after_seconds: 16683, reset_at: 1790592554 },
      secondary_window: { used_percent: 6, limit_window_seconds: 604800, reset_after_seconds: 603483, reset_at: 1791179354 },
    },
    additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { primary_window: { used_percent: 0 } } }],
    credits: { has_credits: false, unlimited: false, balance: "0", approx_local_messages: [0, 0] },
    spend_control: { reached: false, individual_limit: null },
    rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
    UNKNOWN_FUTURE: EMAIL,
    ...over,
  };
}

export function resetCreditsBody(): Record<string, unknown> {
  const credit = (id: string, granted: string, expires: string) => ({
    id,
    reset_type: "codex_rate_limits",
    is_supported_by_plan: true,
    status: "available",
    granted_at: granted,
    expires_at: expires,
    redeem_started_at: null,
    redeemed_at: null,
    title: "Full reset (Weekly + 5 hr)",
    description: `granted to ${EMAIL}`,
    UNKNOWN_FUTURE: 1,
  });
  return {
    credits: [
      credit(CREDIT_IDS[0], "2026-09-04T22:28:45Z", "2026-10-04T22:28:45Z"),
      credit(CREDIT_IDS[1], "2026-09-22T10:00:00Z", "2026-10-22T10:00:00Z"),
    ],
    available_count: 2,
    total_earned_count: 0,
    immediate_reset_purchase_eligible: false,
    history_enabled: true,
  };
}

export const keychainBlob = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_TOKEN, refreshToken: "rt-SENTINEL", expiresAt: T0 + 3600_000, ...over } });
export const claudeJson = (account = CLAUDE_ACCOUNT) => JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: EMAIL } });
export const codexAuth = (token = CODEX_TOKEN, account = CODEX_ACCOUNT) =>
  JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "id-SENTINEL", access_token: token, refresh_token: "rt", account_id: account } });

export interface FakeCredDeps extends CredDeps {
  files: Map<string, string>;
  reads: string[];
  keychainCalls: string[];
  keychain: KeychainOutcome | (() => KeychainOutcome);
}

/** 假家目录 /home/u：文件表 + 可替换的 Keychain 结果 */
export function fakeCredDeps(opts: { env?: Record<string, string>; keychain?: KeychainOutcome; files?: Record<string, string> } = {}): FakeCredDeps {
  const files = new Map(Object.entries(opts.files ?? { "/home/u/.claude.json": claudeJson(), "/home/u/.codex/auth.json": codexAuth() }));
  const deps: FakeCredDeps = {
    files,
    reads: [],
    keychainCalls: [],
    keychain: opts.keychain ?? { status: "ok", stdout: keychainBlob() + "\n" },
    async readKeychain(service) {
      deps.keychainCalls.push(service);
      return typeof deps.keychain === "function" ? deps.keychain() : deps.keychain;
    },
    async readText(path) {
      deps.reads.push(path);
      return files.get(path) ?? null;
    },
    env: opts.env ?? {},
    home: "/home/u",
    secret: () => SECRET,
    now: () => T0,
  };
  return deps;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: string;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** 记录每次调用的假 fetch；handler 按 URL 返回响应 */
export function fakeFetch(handler: (url: string, signal: AbortSignal) => Response | Promise<Response>): QuotaFetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const f = (async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect });
    return handler(url, init.signal);
  }) as QuotaFetch & { calls: FetchCall[] };
  f.calls = calls;
  return f;
}

/** 默认的「一切正常」路由 */
export function okRoutes(url: string): Response {
  if (url.includes("/api/oauth/usage")) return jsonResponse(200, claudeUsageBody());
  if (url.endsWith("/wham/usage")) return jsonResponse(200, codexUsageBody());
  if (url.endsWith("/wham/rate-limit-reset-credits")) return jsonResponse(200, resetCreditsBody());
  return jsonResponse(404, {});
}

export interface PostCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: string;
}

/** 使用重置卡的假 POST（真实接口一次都不调）：记下每次调用，handler 决定上游怎么答 */
export function fakePost(handler: (call: PostCall) => Response | Promise<Response>): ConsumeFetch & { calls: PostCall[] } {
  const calls: PostCall[] = [];
  const f = (async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown>, redirect: init.redirect };
    calls.push(call);
    return handler(call);
  }) as ConsumeFetch & { calls: PostCall[] };
  f.calls = calls;
  return f;
}

/** 「此刻可用」= usable 的 GET 路由：使用重置卡要先过这一关（缺省的 okRoutes 照 T2a 样例是 0） */
export function usableRoutes(usable: () => number): (url: string) => Response {
  return (url) =>
    url.endsWith("/wham/usage")
      ? jsonResponse(200, codexUsageBody({ rate_limit_reset_credits: { available_count: 2, applicable_available_count: usable() } }))
      : okRoutes(url);
}

export function expectNoSentinel(text: string): void {
  for (const s of SENTINELS) if (text.includes(s)) throw new Error(`泄漏了哨兵串: ${s}`);
}
