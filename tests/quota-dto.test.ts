/**
 * 白名单 DTO（lib/quota-dto.ts）：只放行认识的字段；PII、未知字段、credit 原始 id 一个都不能出现在结果里。
 */

import { describe, expect, test } from "bun:test";
import { parseClaudeUsage, parseCodexResetCredits, parseCodexUsage } from "../src/lib/quota-dto.js";
import { CREDIT_IDS, claudeUsageBody, codexUsageBody, expectNoSentinel, resetCreditsBody } from "./quota-fixtures.js";

const hash = (id: string) => `h(${id.length})`;

describe("Claude /api/oauth/usage", () => {
  test("limits[]：session / weekly_all / weekly_scoped（带模型名）", () => {
    const d = parseClaudeUsage(claudeUsageBody());
    expect(d?.windows).toEqual([
      { id: "5h", kind: "session", usedPct: 6, resetsAtMs: Date.parse("2026-09-28T16:10:00Z"), windowMinutes: 300, severity: "normal", scopeModel: null },
      { id: "7d", kind: "weekly", usedPct: 74, resetsAtMs: Date.parse("2026-09-30T06:00:00Z"), windowMinutes: 10080, severity: "normal", scopeModel: null },
      {
        id: "7d:Fable", kind: "weekly_scoped", usedPct: 100, resetsAtMs: Date.parse("2026-09-30T06:00:00Z"),
        windowMinutes: 10080, severity: "critical", scopeModel: "Fable",
      },
    ]);
    expectNoSentinel(JSON.stringify(d));
  });

  test("没有 limits[] 时退回 five_hour / seven_day", () => {
    const body = claudeUsageBody();
    delete body.limits;
    expect(parseClaudeUsage(body)?.windows.map((w) => [w.id, w.usedPct])).toEqual([["5h", 6], ["7d", 74]]);
  });

  test("可疑字符串被拒：模型名不合规则 → null，未知 kind 名不合规则 → 丢掉整条", () => {
    const body = { limits: [
      { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "<script>alert(1)</script>" } } },
      { kind: "Bad Kind!", percent: 5 },
      { kind: "session", percent: -1 },
    ] };
    const d = parseClaudeUsage(body);
    expect(d?.windows).toHaveLength(1);
    expect(d?.windows[0]).toMatchObject({ id: "7d:scoped", scopeModel: null });
  });

  test("形状不对 → null", () => {
    expect(parseClaudeUsage(null)).toBeNull();
    expect(parseClaudeUsage([])).toBeNull();
    expect(parseClaudeUsage({ limits: "x" })).toBeNull();
  });
});

describe("Codex wham/usage", () => {
  test("窗口、套餐、用满、余额、重置汇总（持有 / 此刻可用两个数）", () => {
    const d = parseCodexUsage(codexUsageBody());
    expect(d).toEqual({
      plan: "plus",
      limitReached: false,
      windows: [
        { id: "5h", kind: "session", usedPct: 36, resetsAtMs: 1790592554000, windowMinutes: 300, severity: null, scopeModel: null },
        { id: "7d", kind: "weekly", usedPct: 6, resetsAtMs: 1791179354000, windowMinutes: 10080, severity: null, scopeModel: null },
      ],
      balance: "0",
      resetCredits: { availableCount: 2, applicableAvailableCount: 0 },
    });
  });

  test("email / user_id / account_id / 未知字段都不在结果里", () => {
    expectNoSentinel(JSON.stringify(parseCodexUsage(codexUsageBody())));
  });

  test("缺 rate_limit 或一个窗口都没有 → null；缺重置汇总 → resetCredits null", () => {
    expect(parseCodexUsage({ plan_type: "plus" })).toBeNull();
    expect(parseCodexUsage(codexUsageBody({ rate_limit: { primary_window: null } }))).toBeNull();
    expect(parseCodexUsage(codexUsageBody({ rate_limit_reset_credits: undefined }))?.resetCredits).toBeNull();
  });
});

describe("Codex 重置明细", () => {
  test("每条：HMAC 键、状态、套餐支持、兑换标记、到期时刻", () => {
    const d = parseCodexResetCredits(resetCreditsBody(), hash);
    expect(d?.availableCount).toBe(2);
    expect(d?.credits[0]).toEqual({
      key: `h(${CREDIT_IDS[0].length})`,
      status: "available",
      supportedByPlan: true,
      redeemStarted: false,
      redeemed: false,
      grantedAtMs: Date.parse("2026-09-04T22:28:45Z"),
      expiresAtMs: Date.parse("2026-10-04T22:28:45Z"),
    });
    expectNoSentinel(JSON.stringify(d));
  });

  test("原始 id 只交给 hash 函数，不出现在结果里；缺 expires_at 的条目丢掉", () => {
    const seen: string[] = [];
    const body = resetCreditsBody();
    (body.credits as Record<string, unknown>[])[1].expires_at = null;
    const d = parseCodexResetCredits(body, (id) => (seen.push(id), "k"));
    expect(seen).toEqual([CREDIT_IDS[0]]);
    expect(d?.credits).toHaveLength(1);
  });

  test("已兑换 / 兑换中 / 未知状态", () => {
    const body = resetCreditsBody();
    const [a, b] = body.credits as Record<string, unknown>[];
    a.redeemed_at = "2026-09-10T00:00:00Z";
    a.status = "redeemed";
    b.redeem_started_at = "2026-09-10T00:00:00Z";
    b.status = "pending_something";
    const d = parseCodexResetCredits(body, hash);
    expect(d?.credits.map((c) => [c.status, c.redeemed, c.redeemStarted])).toEqual([["redeemed", true, false], ["other", false, true]]);
  });

  test("形状不对 → null", () => {
    expect(parseCodexResetCredits({ credits: [] }, hash)).toBeNull();
    expect(parseCodexResetCredits({ available_count: 1 }, hash)).toBeNull();
  });
});
