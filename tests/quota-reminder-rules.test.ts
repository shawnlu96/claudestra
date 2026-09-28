/**
 * 重置次数提醒规则（lib/quota-reminder-rules.ts）：资格、72 / 24 小时两档、首次即 24 小时只发一条、
 * 按 credit 键去重、合并、用满提醒、陈旧与账户不确定不提醒、分渠道投递状态。纯函数。
 */

import { describe, expect, test } from "bun:test";
import type { CodexUsageDto, ResetCreditDto } from "../src/lib/quota-dto.js";
import {
  emptyLedger,
  isEligibleCredit,
  pendingDeliveries,
  planExhaustedReminder,
  planExpiryReminder,
  pruneLedger,
  recordDelivery,
} from "../src/lib/quota-reminder-rules.js";
import { T0 } from "./quota-fixtures.js";

const HOUR = 3600_000;
const ctx = (now = T0, over: Partial<{ stale: boolean; uncertain: boolean }> = {}) => ({ accountKey: "acct", now, stale: false, uncertain: false, ...over });
const credit = (key: string, hoursLeft: number, over: Partial<ResetCreditDto> = {}): ResetCreditDto => ({
  key, status: "available", supportedByPlan: true, redeemStarted: false, redeemed: false, grantedAtMs: T0 - 20 * 24 * HOUR,
  expiresAtMs: T0 + hoursLeft * HOUR, ...over,
});

describe("资格", () => {
  test("可用、套餐支持、未兑换、未开始兑换、未过期：缺一不可", () => {
    expect(isEligibleCredit(credit("a", 10), T0)).toBe(true);
    expect(isEligibleCredit(credit("a", 10, { status: "redeemed" }), T0)).toBe(false);
    expect(isEligibleCredit(credit("a", 10, { status: "other" }), T0)).toBe(false);
    expect(isEligibleCredit(credit("a", 10, { supportedByPlan: false }), T0)).toBe(false);
    expect(isEligibleCredit(credit("a", 10, { redeemed: true }), T0)).toBe(false);
    expect(isEligibleCredit(credit("a", 10, { redeemStarted: true }), T0)).toBe(false);
    expect(isEligibleCredit(credit("a", -1), T0)).toBe(false);
  });
});

describe("快过期提醒", () => {
  test("72 小时一次，24 小时再一次，之后不再提醒", () => {
    let l = emptyLedger();
    const c = [credit("a", 100)];
    expect(planExpiryReminder(l, c, ctx()).notice).toBeNull();
    const r1 = planExpiryReminder(l, c, ctx(T0 + 30 * HOUR)); // 剩 70h
    expect(r1.notice?.credits).toEqual([{ key: "a", expiresAtMs: T0 + 100 * HOUR, thresholdH: 72 }]);
    l = r1.ledger;
    expect(planExpiryReminder(l, c, ctx(T0 + 40 * HOUR)).notice).toBeNull();
    const r2 = planExpiryReminder(l, c, ctx(T0 + 80 * HOUR)); // 剩 20h
    expect(r2.notice?.credits?.[0].thresholdH).toBe(24);
    expect(planExpiryReminder(r2.ledger, c, ctx(T0 + 90 * HOUR)).notice).toBeNull();
  });

  test("首次看到就已进 24 小时：只发一条（24h 档），72h 档记为已覆盖", () => {
    const r = planExpiryReminder(emptyLedger(), [credit("a", 10)], ctx());
    expect(r.notice?.credits).toEqual([{ key: "a", expiresAtMs: T0 + 10 * HOUR, thresholdH: 24 }]);
    expect(r.ledger.credits.a.coveredH).toEqual([72, 24]);
    expect(planExpiryReminder(r.ledger, [credit("a", 10)], ctx(T0 + HOUR)).notice).toBeNull();
  });

  test("同日到期的两条按 credit 键分开去重，同一次命中的合并成一条通知", () => {
    const r = planExpiryReminder(emptyLedger(), [credit("b", 50), credit("a", 50)], ctx());
    expect(r.notice?.credits?.map((c) => c.key).sort()).toEqual(["a", "b"]);
    expect(r.ledger.outbox).toHaveLength(1);
    const later = planExpiryReminder(r.ledger, [credit("a", 50), credit("b", 50), credit("c", 50)], ctx(T0 + HOUR));
    expect(later.notice?.credits?.map((c) => c.key)).toEqual(["c"]);
  });

  test("陈旧数据、账户不确定：不发确定性提醒，也不记账", () => {
    for (const over of [{ stale: true }, { uncertain: true }]) {
      const r = planExpiryReminder(emptyLedger(), [credit("a", 10)], ctx(T0, over));
      expect(r.notice).toBeNull();
      expect(r.ledger.credits).toEqual({});
    }
  });
});

describe("用满提醒", () => {
  const usage = (over: Partial<CodexUsageDto> = {}, applicable = 1): CodexUsageDto => ({
    plan: "plus",
    limitReached: false,
    balance: null,
    windows: [
      { id: "5h", kind: "session", usedPct: 100, resetsAtMs: T0 + HOUR, windowMinutes: 300, severity: null, scopeModel: null },
      { id: "7d", kind: "weekly", usedPct: 40, resetsAtMs: T0 + 90 * HOUR, windowMinutes: 10080, severity: null, scopeModel: null },
    ],
    resetCredits: { availableCount: 2, applicableAvailableCount: applicable },
    ...over,
  });

  test("窗口 100% 且此刻可兑换 > 0 → 提醒；同一窗口只一次；下一个窗口再一次", () => {
    const r = planExhaustedReminder(emptyLedger(), usage(), ctx());
    expect(r.notice?.exhausted).toEqual({ applicable: 1, windowId: "5h", resetsAtMs: T0 + HOUR });
    expect(planExhaustedReminder(r.ledger, usage(), ctx(T0 + 10 * 60_000)).notice).toBeNull();
    const next = usage();
    next.windows[0] = { ...next.windows[0], resetsAtMs: T0 + 6 * HOUR };
    expect(planExhaustedReminder(r.ledger, next, ctx(T0 + 2 * HOUR)).notice).not.toBeNull();
  });

  test("持有但此刻不可兑换（T2a 样例 2 / 0）→ 不提醒；陈旧 / 不确定 → 不提醒", () => {
    expect(planExhaustedReminder(emptyLedger(), usage({}, 0), ctx()).notice).toBeNull();
    expect(planExhaustedReminder(emptyLedger(), usage(), ctx(T0, { stale: true })).notice).toBeNull();
    expect(planExhaustedReminder(emptyLedger(), usage(), ctx(T0, { uncertain: true })).notice).toBeNull();
  });

  test("limit_reached 但没有窗口到 100%：按用得最多的窗口认", () => {
    const u = usage({ limitReached: true });
    u.windows[0] = { ...u.windows[0], usedPct: 90 };
    expect(planExhaustedReminder(emptyLedger(), u, ctx()).notice?.exhausted?.windowId).toBe("5h");
    u.limitReached = false;
    expect(planExhaustedReminder(emptyLedger(), u, ctx()).notice).toBeNull();
  });
});

describe("分渠道投递", () => {
  test("一个渠道失败只重试它（按退避），已成功的不重发", () => {
    const { ledger, notice } = planExpiryReminder(emptyLedger(), [credit("a", 10)], ctx());
    expect(pendingDeliveries(ledger, T0).map((d) => d.channel)).toEqual(["push", "discord"]);
    let l = recordDelivery(ledger, notice!.id, "push", true, T0);
    l = recordDelivery(l, notice!.id, "discord", false, T0);
    expect(pendingDeliveries(l, T0 + 60_000)).toEqual([]);
    const due = pendingDeliveries(l, T0 + 5 * 60_000);
    expect(due.map((d) => d.channel)).toEqual(["discord"]);
    l = recordDelivery(l, notice!.id, "discord", false, T0 + 5 * 60_000);
    expect(pendingDeliveries(l, T0 + 9 * 60_000)).toEqual([]); // 第二次失败退避 10 分钟
    expect(pendingDeliveries(l, T0 + 15 * 60_000)).toHaveLength(1);
  });

  test("清理：全渠道送达的通知、过期一天以上的 credit、8 天前的用满记录", () => {
    const { ledger, notice } = planExpiryReminder(emptyLedger(), [credit("a", 10)], ctx());
    let l = recordDelivery(recordDelivery(ledger, notice!.id, "push", true, T0), notice!.id, "discord", true, T0);
    l = { ...l, exhausted: { old: T0 - 9 * 24 * HOUR, fresh: T0 } };
    const p = pruneLedger(l, T0 + HOUR);
    expect(p.outbox).toEqual([]);
    expect(Object.keys(p.credits)).toEqual(["a"]);
    expect(Object.keys(p.exhausted)).toEqual(["fresh"]);
    expect(pruneLedger(l, T0 + 36 * HOUR).credits).toEqual({});
  });

  test("送不出去的通知 3 天后放弃", () => {
    const { ledger } = planExpiryReminder(emptyLedger(), [credit("a", 10)], ctx());
    expect(pruneLedger(ledger, T0 + 2 * 24 * HOUR).outbox).toHaveLength(1);
    expect(pruneLedger(ledger, T0 + 3 * 24 * HOUR).outbox).toHaveLength(0);
  });
});
