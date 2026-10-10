/**
 * web/features/chat/quota-view.ts：GET /api/v1/quota → 卡片数据（未知字段丢掉、形状不对回 null 让面板退回旧卡）、
 * 数据层与原因码的人话、「重试」只在用户重试才解除的状态出、本机缓存标账户归属未知。
 */
import { describe, expect, test } from "bun:test";
import { codexResetAction, resetConfirmParams, resetOutcome } from "../web/features/chat/quota-reset";
import { canRetry, entryRuntime, expiryParts, fmtAt, identityNote, layerLabel, meterLabel, quotaPanelData, reasonText, type EntryView } from "../web/features/chat/quota-view";

const T = new Date(2026, 8, 28, 10, 0).getTime();
const body = {
  ok: true,
  enabled: true,
  snapshot: {
    generatedAt: T,
    providers: [
      {
        id: "claude", name: "Claude", kind: "subscription", account: { key: "k1", identity: "assumed" },
        meters: [{ id: "session", kind: "session", label: null, unit: "pct", used: 6.4, resetsAtMs: T + 3600_000, resetPassed: false, secret: "x" }],
        source: { layer: "live", observedAt: T, reason: null }, token: "SHOULD-NOT-SURVIVE",
      },
      {
        id: "codex", name: "Codex", kind: "subscription", plan: "plus", account: { key: "k2", identity: "bound" }, meters: [],
        resetCredits: { held: 2, applicableNow: 0, credits: [{ key: "h1", expiresAtMs: T + 86400_000 }], stale: false, observedAt: T },
        source: { layer: "live_stale", observedAt: T - 3600_000, reason: "keychain_timeout" },
      },
      { id: "codex.local", name: "Codex", kind: "subscription", account: { key: null, identity: "unknown" }, meters: [], source: { layer: "local_cache", observedAt: T, reason: null } },
      {
        id: "pi:acme", name: "acme", kind: "api", account: { key: null, identity: "unknown" },
        meters: [{ id: "week_usd", kind: "usage", unit: "usd", used: 1.5 }], source: { layer: "local_cache", observedAt: T, reason: null },
      },
      { id: 42, name: "bad" },
      { id: "x", name: "y", source: { layer: "weird" }, meters: [{ id: "m", unit: "bogus" }] },
    ],
  },
};

describe("quotaPanelData", () => {
  test("只留认识的字段；坏条目丢掉；未知数据层按「无」", () => {
    const d = quotaPanelData(body)!;
    expect(d.enabled).toBe(true);
    expect(d.entries.map((e) => e.id)).toEqual(["claude", "codex", "codex.local", "pi:acme", "x"]);
    expect(JSON.stringify(d)).not.toContain("SHOULD-NOT-SURVIVE");
    expect(JSON.stringify(d)).not.toContain('"secret"');
    expect(d.entries[1].resetCredits).toEqual({
      held: 2, applicableNow: 0, expiries: [{ key: null, at: T + 86400_000, left: null, requiresLimit: false }], stale: false, ineligibleReason: null, limitReached: null,
    });
    // 卡键只收 bridge 的 32 位 hex HMAC；limitReached 只收布尔
    const keyed = quotaPanelData({ snapshot: { providers: [{ id: "codex", name: "Codex", source: { layer: "live" },
      resetCredits: { held: 1, applicableNow: 1, limitReached: true, credits: [{ key: "f".repeat(32), expiresAtMs: T }, { key: "rlrc_raw", expiresAtMs: T }] } }] } })!;
    expect(keyed.entries[0].resetCredits?.expiries?.map((x) => x.key)).toEqual(["f".repeat(32), null]);
    expect(keyed.entries[0].resetCredits?.limitReached).toBe(true);
    const surface = quotaPanelData({ snapshot: { providers: [{ id: "claude", name: "Claude", source: { layer: "live" }, resetCredits: { held: 0, credits: [], ineligibleReason: "surface" } }] } })!;
    expect(surface.entries[0].resetCredits?.ineligibleReason).toBe("surface");
    expect(d.entries[4].source.layer).toBe("none");
    expect(d.entries[4].meters).toEqual([]);
  });

  test("形状不对 → null（面板退回旧卡）", () => {
    expect(quotaPanelData(null)).toBeNull();
    expect(quotaPanelData({ ok: true })).toBeNull();
    expect(quotaPanelData({ snapshot: { providers: "no" } })).toBeNull();
  });
});

describe("文案与按钮", () => {
  const d = quotaPanelData(body)!;
  test("重试只给 Keychain 被拒 / 超时、端点暂停；按量接入商和本机缓存永远没有", () => {
    expect(canRetry(d.entries[1])).toBe("codex");
    expect(canRetry(d.entries[0])).toBeNull();
    expect(canRetry({ ...d.entries[0], source: { layer: "none", observedAt: null, reason: "http_5xx", needsUserRetry: false } })).toBeNull();
    expect(canRetry({ ...d.entries[0], source: { layer: "none", observedAt: null, reason: "bad_shape", needsUserRetry: false } })).toBe("claude");
    expect(canRetry({ ...d.entries[0], source: { layer: "live_stale", observedAt: null, reason: "http_403", needsUserRetry: false } })).toBe("claude");
    // bridge 标了需要用户重试就给按钮，不管原因码是什么（先 5xx 再 Keychain 出错之类）；keychain_error 兜底名单也认
    expect(canRetry({ ...d.entries[0], source: { layer: "live_stale", observedAt: null, reason: "http_5xx", needsUserRetry: true } })).toBe("claude");
    expect(canRetry({ ...d.entries[0], source: { layer: "none", observedAt: null, reason: "keychain_error", needsUserRetry: false } })).toBe("claude");
    expect(canRetry(d.entries[2])).toBeNull();
  });

  test("原因码有人话；认不出的原样；没有就 null", () => {
    expect(reasonText("keychain_timeout")).toContain("钥匙串");
    expect(reasonText("http_401")).toContain("续期");
    expect(reasonText("brand_new_code")).toBe("brand_new_code");
    expect(reasonText(null)).toBeNull();
  });

  test("账户说明、徽章、量条标签、时刻", () => {
    expect(identityNote(d.entries[2])).toBe("账户归属未知");
    expect(identityNote(d.entries[0])).toBe("账户按本机登录推定");
    expect(identityNote(d.entries[1])).toBeNull();
    expect(identityNote(d.entries[3])).toBeNull();
    expect(d.entries.slice(0, 4).map(entryRuntime)).toEqual(["claude-code", "codex", "codex", "pi"]);
    expect(meterLabel(d.entries[0].meters[0])).toBe("5 小时");
    expect(meterLabel({ id: "7d", kind: "weekly_scoped", label: "Fable", unit: "pct", used: 1, resetsAtMs: null, resetPassed: false })).toBe("本周 · Fable");
    expect(fmtAt(T + 3600_000, T)).toBe("11:00");
    expect(fmtAt(new Date(2026, 9, 4, 22, 28).getTime(), T)).toBe("10-04 22:28");
  });
});

describe("重置卡截止说明", () => {
  // expiryParts 走 fmtAt 的默认 now=Date.now()：钉在 T，不随跑测那天变；finally 无论断言成败都还原
  const withNow = (now: number, fn: () => void) => {
    const real = Date.now;
    Date.now = () => now;
    try {
      fn();
    } finally {
      Date.now = real;
    }
  };

  test("Claude 的卡：剩几次（>1 才写）、到限额才能用；Codex 的 credit 只有到期", () => {
    const at = new Date(2026, 9, 4, 22, 28).getTime();
    const keys = (x: Parameters<typeof expiryParts>[0]) => expiryParts(x).map((p) => p.key);
    withNow(T, () => {
      expect(keys({ key: null, at, left: 2, requiresLimit: true })).toEqual(["{at} 到期", "剩 {n} 次", "到限额才能用"]);
      expect(keys({ key: null, at, left: 1, requiresLimit: false })).toEqual(["{at} 到期"]);
      expect(expiryParts({ key: null, at, left: null, requiresLimit: false })[0].params.at).toBe("10-04 22:28");
      expect(keys({ key: null, at: null, left: 1, requiresLimit: true })).toEqual(["无截止日", "到限额才能用"]);
    });
  });

  test("截止时刻和现在同一天只写时分，跨日带月-日", () => {
    const at = new Date(2026, 9, 4, 22, 28).getTime();
    withNow(new Date(2026, 9, 4, 9, 0).getTime(), () => {
      expect(expiryParts({ key: null, at, left: null, requiresLimit: false })[0].params.at).toBe("22:28");
    });
    withNow(T, () => {
      expect(expiryParts({ key: null, at, left: null, requiresLimit: false })[0].params.at).toBe("10-04 22:28");
    });
  });
});

describe("数据层标签", () => {
  test("Pi（按量接入商）的本机数据叫「本机记录」；订阅的本机兜底仍叫「本机缓存」", () => {
    const d = quotaPanelData(body)!;
    expect(d.entries.map(layerLabel).slice(0, 4)).toEqual(["实时", "实时过期", "本机缓存", "本机记录"]);
  });
});

describe("Codex「使用一次重置」（quota-reset.ts）", () => {
  const K = "c".repeat(32);
  const codex = (rc: Partial<NonNullable<EntryView["resetCredits"]>>, id = "codex"): EntryView => ({
    id, name: "Codex", kind: "subscription", plan: null, identity: "bound", meters: [], balance: null,
    resetCredits: { held: 2, applicableNow: 1, expiries: [{ key: K, at: T, left: null, requiresLimit: false }], stale: false, ineligibleReason: null, limitReached: false, ...rc },
    source: { layer: "live", observedAt: T, reason: null, needsUserRetry: false },
  });

  test("只有 Codex 账户卡、持有 ≥ 1 才出按钮；此刻可用为 0 置灰并按 limitReached 写原因；明细没到也不让点", () => {
    expect(codexResetAction(codex({}))).toEqual({ enabled: true, key: K, at: T });
    expect(codexResetAction(codex({}, "claude"))).toBeNull();
    expect(codexResetAction(codex({}, "codex.local"))).toBeNull();
    expect(codexResetAction(codex({ held: 0 }))).toBeNull();
    expect(codexResetAction(codex({ applicableNow: 0 }))).toEqual({ enabled: false, why: "额度还没到上限，现在不需要重置" });
    expect(codexResetAction(codex({ applicableNow: 0, limitReached: true }))).toEqual({ enabled: false, why: "接口说此刻没有能用的卡" });
    expect(codexResetAction(codex({ applicableNow: 0, limitReached: null }))).toEqual({ enabled: false, why: "接口说此刻没有能用的卡" });
    expect(codexResetAction(codex({ expiries: null }))).toEqual({ enabled: false, why: "重置卡明细还没拿到，稍后再试" });
  });

  test("二次确认写明到期时间（本机时区）；没有截止日照写", () => {
    expect(resetConfirmParams({ enabled: true, key: K, at: T })).toEqual({ key: "会消耗 1 次重置卡（{at} 到期），不可撤销。确定使用？", params: { at: fmtAt(T) } });
    expect(resetConfirmParams({ enabled: true, key: K, at: null }).key).toBe("会消耗 1 次重置卡（无截止日），不可撤销。确定使用？");
  });

  test("结果的人话：用掉 / 上游拒了没扣 / 核对没过没发 / 没确切答复按刷新为准 / 409 / 403 / 断网", () => {
    const ok = (result: unknown) => resetOutcome(200, { ok: true, result });
    expect(ok({ status: "done", code: "reset" })).toEqual({ tone: "success", key: "已使用 1 次重置，额度已补满", params: {} });
    expect(ok({ status: "done", code: "already_redeemed" }).tone).toBe("success");
    expect(ok({ status: "done", code: "no_credit" })).toMatchObject({ tone: "info", key: "这张卡已经不能用了，没有扣卡" });
    expect(ok({ status: "refused", code: "not_applicable" })).toMatchObject({ tone: "info", key: "此刻没有可用的卡，没有发出使用请求" });
    expect(ok({ status: "refused", code: "identity_changed" })).toMatchObject({ tone: "info", key: "账号或登录凭据刚变过，没有发出使用请求；刷新后重新确认" });
    expect(ok({ status: "refused", code: "disabled" }).key).toBe("实时读取已关闭（或刚被关过），没有发出使用请求");
    expect(ok({ status: "refused", code: "http_429" })).toEqual({ tone: "error", key: "核对数据失败（{why}），没有发出使用请求", params: { why: reasonText("http_429")! } });
    expect(ok({ status: "failed", code: "network" })).toMatchObject({ tone: "error", params: { why: "网络不通" } });
    expect(ok({ status: "done", code: "brand_new" }).key).toBe("请求没完成，扣没扣以刷新后的数字为准");
    expect(resetOutcome(409, { ok: false })).toMatchObject({ tone: "info", key: "已有一个使用请求在进行中" });
    expect(resetOutcome(403, { ok: false }).key).toBe("需要 owner 本人的设备才能使用重置卡");
    expect(resetOutcome(0, null).key).toBe("请求没完成，扣没扣以刷新后的数字为准");
    expect(resetOutcome(500, { ok: false, error: "x" }).key).toBe("请求没完成，扣没扣以刷新后的数字为准");
  });
});
