import { describe, expect, test } from "bun:test";
import { isTransientAcpFailure, isTransientError, TRANSIENT_BACKOFF_MS } from "../src/lib/transient-error.js";

// 用例原文取自真实会话：CC jsonl 的 isApiErrorMessage 条目（错误码 + 原文）、2026-10-16 断网时 Pi 的「Pi 回合失败：…」
const cc = (code: string, text: string) => `${code}\n${text}`;

describe("网络 / 服务端瞬时错误", () => {
  test.each([
    ["Pi 回合失败：Connection error."],
    ["Pi 回合失败：terminated"],
    ["Pi 回合失败：This operation was aborted"],
    [cc("server_error", "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)")],
    [cc("unknown", "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)")],
    [cc("server_error", "API Error: Connection dropped (ECONNRESET)")],
    [cc("server_error", "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)")],
    [cc("server_error", "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)")],
    [cc("server_error", "API Error: Connection lost mid-response. The response above may be incomplete.")],
    [cc("server_error", "API Error: Response stalled mid-stream. The response above may be incomplete.")],
    [cc("server_error", "API Error: Your computer went to sleep mid-response. The response above may be incomplete.")],
    [cc("server_error", "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.")],
    [cc("server_error", "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.")],
    [cc("rate_limit", "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited")],
    ["Pi 回合失败：503 Service Unavailable"],
    ["Pi 回合失败：502 Bad Gateway"],
    ["Pi 回合失败：504 Gateway Timeout"],
    ["Pi 回合失败：getaddrinfo EAI_AGAIN api.example.com"],
    ["Pi 回合失败：Client network socket disconnected before secure TLS connection was established"],
    ["Pi 回合失败：429 Too Many Requests, retry after 20s"],
    [cc("server_error", "")],
    // Codex（自研适配器 / 上游原文）与 Pi 真实出现过的断流
    ["Codex 回合失败：stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"],
    ["stream disconnected before completion: Transport error: error decoding response body"],
    ["We’re currently experiencing high demand, which may cause temporary errors."],
    ["client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known"],
    ["Codex 回合失败（connection）"],
    ["Pi 回合失败：Stream ended without finish_reason"],
    ["Pi 回合失败：UND_ERR_HEADERS_TIMEOUT"],
    ["Pi 回合失败：Premature close"],
    ["Pi 回合失败：WebSocket idle timeout after 300000ms"],
  ])("瞬时：%s", (text) => expect(isTransientError(text)).toBe(true));

  test.each([
    // 额度：走额度闸 / 额度卡
    [cc("rate_limit", "You've hit your session limit · resets 2:20am (Asia/Shanghai)")],
    [cc("rate_limit", "You've hit your weekly limit · resets Sep 14 at 10pm (Asia/Shanghai)")],
    [cc("rate_limit", "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.")],
    [cc("rate_limit", "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message")],
    ["Pi 回合失败：429 insufficient_quota: You exceeded your current quota, please check your plan and billing details."],
    // 登录失效：登录卡 / auth 规则
    [cc("authentication_failed", "Please run /login · API Error: 401 OAuth access token has expired. Re-authenticate to continue.")],
    [cc("authentication_failed", "Please run /login · API Error: 403 Request not allowed")],
    [cc("server_error", "Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · Try again")],
    // 内容策略：cyber / safeguards
    ["This content was flagged for possible cybersecurity risk (cyber_policy). Connection error."],
    [cc("invalid_request", "API Error: Opus 5's safeguards flagged this message (https://www.anthropic.com/legal/aup).")],
    // 上下文耗尽（原文里带了网络字样也不改道）
    [cc("invalid_request", "Prompt is too long · automatic compaction failed: API Error: Connection refused — a firewall or proxy may be blocking it")],
    // 其它：模型不可用 / 请求本身错
    [cc("model_not_found", "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.")],
    [cc("unknown", 'API Error: 400 {"model":"deepseek-v4.1-flash"}')],
    ["e"],
    // 带网络字样的永久错误：子串不算（not_found_error 里的 und_err、bash_timeout、参数名 timeout）
    ["Pi 回合失败：404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-3-5-sonnet-20240620\"}}"],
    [cc("invalid_request", "API Error: 400 tools.3.custom.name: String should match pattern (bash_timeout)")],
    [cc("invalid_request", 'API Error: 400 {"type":"invalid_request_error","message":"timeout: Extra inputs are not permitted"}')],
    [cc("keychain_error", "API Error: keychain timed out")],
    [cc("invalid_request", "API Error: 500 Output blocked by content filtering policy")],
    // 额度 / 套餐过期的 429（Pi 真实原文）
    ['Pi 回合失败：429: {"code":"1309","message":"Your GLM Coding Plan package has expired and is temporarily unavailable."}'],
    ['Pi 回合失败：429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 22hr 20min."}'],
    ["Pi 回合失败：Codex error: The usage limit has been reached"],
    [cc("rate_limit", "Claude AI usage limit reached|1760000000")],
  ])("不是瞬时：%s", (text) => expect(isTransientError(text)).toBe(false));
});

describe("ACP 失败帧", () => {
  const net = { kind: "error", key: "rpc:1", message: "Pi 回合失败：Connection error." } as const;
  test("网络类、适配器没说不能重试：算", () => {
    expect(isTransientAcpFailure(net)).toBe(true);
    expect(isTransientAcpFailure({ ...net, retry: true })).toBe(true);
  });
  test("不能重试 / 投递不明 / 上下文耗尽 / 额度 / 登录：不算", () => {
    expect(isTransientAcpFailure({ ...net, retry: false })).toBe(false);
    expect(isTransientAcpFailure({ ...net, deliveryUnknown: true })).toBe(false);
    expect(isTransientAcpFailure({ ...net, newSession: true })).toBe(false);
    expect(isTransientAcpFailure({ kind: "quota", key: "q", message: "Connection error." })).toBe(false);
    expect(isTransientAcpFailure({ kind: "auth", key: "a", message: "Connection error." })).toBe(false);
    expect(isTransientAcpFailure({ ...net, message: "Pi 回合失败：400 invalid request" })).toBe(false);
  });
});

test("退避表：1、2、4、8 分钟，总预算 15 分钟", () => {
  expect(TRANSIENT_BACKOFF_MS).toEqual([60_000, 120_000, 240_000, 480_000]);
});
