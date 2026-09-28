/**
 * web/features/chat/quota-view.ts：GET /api/v1/quota → 卡片数据（未知字段丢掉、形状不对回 null 让面板退回旧卡）、
 * 数据层与原因码的人话、「重试」只在用户重试才解除的状态出、本机缓存标账户归属未知。
 */
import { describe, expect, test } from "bun:test";
import { canRetry, entryRuntime, fmtAt, identityNote, meterLabel, quotaPanelData, reasonText } from "../web/features/chat/quota-view";

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
    expect(d.entries[1].resetCredits).toEqual({ held: 2, applicableNow: 0, expiries: [T + 86400_000], stale: false });
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
    expect(canRetry({ ...d.entries[0], source: { layer: "none", observedAt: null, reason: "http_5xx" } })).toBeNull();
    expect(canRetry({ ...d.entries[0], source: { layer: "none", observedAt: null, reason: "bad_shape" } })).toBe("claude");
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
