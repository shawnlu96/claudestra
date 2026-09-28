/**
 * 白名单 DTO（lib/quota-dto.ts）：只放行认识的字段；PII、未知字段、credit 原始 id 一个都不能出现在结果里。
 */

import { describe, expect, test } from "bun:test";
import { parseClaudeUsage, parseCodexResetCredits, parseCodexUsage } from "../src/lib/quota-dto.js";
import { CREDIT_IDS, cedarEmberBlock, claudeUsageBody, codexUsageBody, expectNoSentinel, GRANT_IDS, resetCreditsBody } from "./quota-fixtures.js";

const hash = (id: string) => `h(${id.length})`;

describe("Claude /api/oauth/usage", () => {
  test("limits[]：session / weekly_all / weekly_scoped（带模型名）", () => {
    const d = parseClaudeUsage(claudeUsageBody(), hash);
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
    expect(parseClaudeUsage(body, hash)?.windows.map((w) => [w.id, w.usedPct])).toEqual([["5h", 6], ["7d", 74]]);
  });

  test("可疑字符串被拒：模型名不合规则 → null，未知 kind 名不合规则 → 丢掉整条", () => {
    const body = { limits: [
      { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: "<script>alert(1)</script>" } } },
      { kind: "Bad Kind!", percent: 5 },
      { kind: "session", percent: -1 },
    ] };
    const d = parseClaudeUsage(body, hash);
    expect(d?.windows).toHaveLength(1);
    expect(d?.windows[0]).toMatchObject({ id: "7d:scoped", scopeModel: null });
  });

  test("原型链上的 kind 名一律不认", () => {
    const d = parseClaudeUsage({ limits: ["__proto__", "constructor", "prototype", "session"].map((kind) => ({ kind, percent: 1 })) }, hash);
    expect(d?.windows.map((w) => w.id)).toEqual(["5h"]);
  });

  test("时间戳限制在 2020–2100：负数、毫秒当秒、离谱的未来都不认", () => {
    const at = (v: unknown) => parseClaudeUsage({ limits: [{ kind: "session", percent: 1, resets_at: v }] }, hash)?.windows[0].resetsAtMs;
    expect(at("2026-09-28T16:10:00Z")).toBe(Date.parse("2026-09-28T16:10:00Z"));
    expect(at("1999-01-01T00:00:00Z")).toBeNull();
    expect(at("2200-01-01T00:00:00Z")).toBeNull();
    const c = resetCreditsBody();
    (c.credits as Record<string, unknown>[])[0].expires_at = "9999-12-31T00:00:00Z";
    expect(parseCodexResetCredits(c, hash)?.credits).toHaveLength(1);
    expect(parseCodexUsage(codexUsageBody({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 1790592554000 } } }))?.windows[0].resetsAtMs).toBeNull();
  });

  test("形状不对 → null", () => {
    expect(parseClaudeUsage(null, hash)).toBeNull();
    expect(parseClaudeUsage([], hash)).toBeNull();
    expect(parseClaudeUsage({ limits: "x" }, hash)).toBeNull();
  });
});

describe("Claude 重置卡（cedar_ember）", () => {
  test("只留资格、撞限、每张卡的剩余次数 / 截止 / 能否现在用 / 是否要到限额；id 只交给 hash，label / clears / next_grant_id 不收", () => {
    const seen: string[] = [];
    const d = parseClaudeUsage({ ...claudeUsageBody(), cedar_ember: cedarEmberBlock() }, (id) => (seen.push(id), `h${seen.length}`));
    expect(d?.resets).toEqual({
      eligible: true,
      ineligibleReason: null,
      atLimit: false,
      grants: [
        { key: "h1", resetsLeft: 1, resetsTotal: 3, endsAtMs: Date.parse("2026-10-01T09:00:00Z"), paused: false, usableNow: false, requiresLimit: true },
        { key: "h2", resetsLeft: 2, resetsTotal: 3, endsAtMs: Date.parse("2026-10-20T09:00:00Z"), paused: false, usableNow: true, requiresLimit: false },
      ],
    });
    expect(seen).toEqual(GRANT_IDS);
    expectNoSentinel(JSON.stringify(d));
  });

  test("入口不合格（没带 Claude Code 身份头 → surface）：eligible false + 原因，grants 空；原因过正则", () => {
    const block = { eligible: false, ineligible_reason: "surface", at_limit: false, grants: [] };
    expect(parseClaudeUsage({ ...claudeUsageBody(), cedar_ember: block }, hash)?.resets).toEqual({ eligible: false, ineligibleReason: "surface", atLimit: false, grants: [] });
    const weird = parseClaudeUsage({ ...claudeUsageBody(), cedar_ember: { ...block, ineligible_reason: "<b>x</b>" } }, hash);
    expect(weird?.resets?.ineligibleReason).toBeNull();
  });

  test("ends_at 为空或缺席 = 无截止日，卡照样保留；给了却认不出才丢", () => {
    const block = cedarEmberBlock([{ endsAt: "2026-10-01T09:00:00Z" }]);
    const g = block.grants as Record<string, unknown>[];
    g.push({ ...g[0], id: "grant_NULL", ends_at: null }, { ...g[0], id: "grant_ABSENT", ends_at: undefined }, { ...g[0], id: "grant_BAD", ends_at: "someday" });
    const d = parseClaudeUsage({ ...claudeUsageBody(), cedar_ember: block }, (id) => id.replace("grant_", "k-"));
    expect(d?.resets?.grants.map((x) => [x.key.slice(0, 8), x.endsAtMs])).toEqual([
      ["k-RAWGRA", Date.parse("2026-10-01T09:00:00Z")], ["k-NULL", null], ["k-ABSENT", null],
    ]);
  });

  test("旧账号 / 接口没给这个块 → resets null，额度照常；坏的 grant 丢掉", () => {
    expect(parseClaudeUsage(claudeUsageBody(), hash)?.resets).toBeNull();
    const block = cedarEmberBlock();
    (block.grants as Record<string, unknown>[]).push(
      { id: "", ends_at: "2026-10-01T00:00:00Z", resets_left: 1 },
      { id: "x", ends_at: "nope", resets_left: 1 },
      { id: "y", ends_at: "2026-10-01T00:00:00Z" },
    );
    const d = parseClaudeUsage({ ...claudeUsageBody(), cedar_ember: block }, hash);
    expect(d?.windows).toHaveLength(3);
    expect(d?.resets?.grants).toHaveLength(2);
    expect(parseClaudeUsage({ ...claudeUsageBody(), cedar_ember: "weird" }, hash)?.resets).toBeNull();
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
