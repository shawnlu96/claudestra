/**
 * 订阅额度选层（lib/quota-layers.ts）：live / live_stale / none、本机缓存单独成条、重置已过不归零、
 * 重置次数独立展示、通用接入商条目原样拼入。纯函数，手搭远程视图。
 */

import { describe, expect, test } from "bun:test";
import type { CodexQuotaObservation } from "../src/lib/codex-usage.js";
import { parseClaudeUsage, parseCodexResetCredits, parseCodexUsage } from "../src/lib/quota-dto.js";
import { selectQuotaLayers, type LayerSource, type ProviderEntry, type QuotaMeter, type ResetCreditsView } from "../src/lib/quota-layers.js";
import type { ProviderRemote, RemoteView } from "../src/lib/quota-scheduler.js";
import type { CachedUsage } from "../src/lib/usage-cache.js";
import { GRANT_IDS, T0, cedarEmberBlock, claudeUsageBody, codexUsageBody, resetCreditsBody } from "./quota-fixtures.js";

const HOUR = 3600_000;
const claudeData = parseClaudeUsage(claudeUsageBody(), (id) => `g-${id}`)!;
const codexData = parseCodexUsage(codexUsageBody())!;
const creditsData = parseCodexResetCredits(resetCreditsBody(), (id) => `key-${id.slice(-1)}`)!;

const empty: ProviderRemote = { account: null, credFailure: null, endpoints: {} };

function remote(over: Partial<Record<"claude" | "codex", ProviderRemote>> = {}): RemoteView {
  return {
    claude: over.claude ?? {
      account: { key: "ck", identity: "assumed", uncertain: false },
      credFailure: null,
      endpoints: { claude_usage: { snapshot: { data: claudeData, observedAt: T0 - 60_000 }, lastCode: null, paused: false, stale: false } },
    },
    codex: over.codex ?? {
      account: { key: "xk", identity: "bound", uncertain: false },
      credFailure: null,
      endpoints: {
        codex_usage: { snapshot: { data: codexData, observedAt: T0 - 60_000 }, lastCode: null, paused: false, stale: false },
        codex_reset_credits: { snapshot: { data: creditsData, observedAt: T0 - HOUR }, lastCode: null, paused: false, stale: false },
      },
    },
  };
}

const cache: CachedUsage = {
  sessionPct: 6, weekPct: 73, sessionResets: "", weekResets: "",
  sessionResetsAtMs: T0 - HOUR, weekResetsAtMs: T0 + 48 * HOUR, scrapedAt: T0 - 2 * HOUR,
};
const rollout = {
  source: "codex-rollout", plan: "plus", credits: null, limitReached: null, observedAt: T0 - 3 * HOUR, sessionId: "s", cwd: null, agent: null,
  windows: [{ id: "5h", windowMinutes: 300, pct: 34, resets: "", resetsAtMs: T0 + HOUR, resetPassed: false }],
} as CodexQuotaObservation;

const byId = (ps: ProviderEntry[], id: string) => ps.find((p) => p.id === id);

describe("选层", () => {
  test("两家实时成功：只有账户卡，本机缓存不出", () => {
    const s = selectQuotaLayers({ now: T0, enabled: true, remote: remote(), local: { claudeCache: cache, codexRollout: rollout } });
    expect(s.providers.map((p) => [p.id, p.source.layer])).toEqual([["claude", "live"], ["codex", "live"]]);
    const claude = byId(s.providers, "claude")!;
    const layer: LayerSource = claude.source.layer;
    expect(layer).toBe("live");
    const session: QuotaMeter = claude.meters[0];
    expect(session.periodMinutes).toBe(300);
    expect(claude.account).toEqual({ key: "ck", identity: "assumed" });
    expect(claude.meters.map((m) => [m.id, m.used, m.label])).toEqual([["5h", 6, null], ["7d", 74, null], ["7d:Fable", 100, "Fable"]]);
    const codex = byId(s.providers, "codex")!;
    expect(codex.plan).toBe("plus");
    expect(codex.balance).toEqual({ amount: "0", currency: null });
  });

  test("失败但有上次快照 → live_stale + 原因；本机缓存另出一条「账户归属未知」", () => {
    const r = remote();
    r.claude.endpoints.claude_usage = { ...r.claude.endpoints.claude_usage!, lastCode: "http_5xx", stale: true };
    const s = selectQuotaLayers({ now: T0, enabled: true, remote: r, local: { claudeCache: cache, codexRollout: null } });
    expect(byId(s.providers, "claude")?.source).toEqual({ layer: "live_stale", observedAt: T0 - 60_000, reason: "http_5xx" });
    const local = byId(s.providers, "claude.local")!;
    expect(local.account).toEqual({ key: null, identity: "unknown" });
    expect(local.source.layer).toBe("local_cache");
    expect(local.resetCredits).toBeUndefined();
  });

  test("从没成功过 → none + 原因；Keychain 被拒的原因也带出来", () => {
    const r = remote({ claude: { account: { key: "ck", identity: "assumed", uncertain: true }, credFailure: { code: "keychain_denied", needsUserRetry: true }, endpoints: {} } });
    const s = selectQuotaLayers({ now: T0, enabled: true, remote: r, local: { claudeCache: null, codexRollout: null } });
    expect(byId(s.providers, "claude")?.source).toEqual({ layer: "none", observedAt: null, reason: "keychain_denied" });
  });

  test("没配这家（缺 auth.json / Keychain 没条目）→ 不出账户卡、不报错，只看本机缓存", () => {
    const r = remote({ codex: { ...empty, credFailure: { code: "auth_missing", needsUserRetry: false } } });
    const s = selectQuotaLayers({ now: T0, enabled: true, remote: r, local: { claudeCache: null, codexRollout: rollout } });
    expect(byId(s.providers, "codex")).toBeUndefined();
    expect(byId(s.providers, "codex.local")?.plan).toBe("plus");
  });

  test("开关关：只有本机缓存", () => {
    const s = selectQuotaLayers({ now: T0, enabled: false, remote: remote(), local: { claudeCache: cache, codexRollout: rollout } });
    expect(s.providers.map((p) => p.id)).toEqual(["claude.local", "codex.local"]);
  });

  test("过了 resets_at 的窗口：resetPassed，不归零", () => {
    const s = selectQuotaLayers({ now: T0, enabled: false, remote: null, local: { claudeCache: cache, codexRollout: null } });
    const [session, week] = byId(s.providers, "claude.local")!.meters;
    expect(session).toMatchObject({ id: "5h", used: 6, resetPassed: true });
    expect(week).toMatchObject({ id: "7d", used: 73, resetPassed: false });
  });
});

describe("重置次数（独立权益）", () => {
  test("持有 / 此刻可用两个数 + 明细按到期排序", () => {
    const s = selectQuotaLayers({ now: T0, enabled: true, remote: remote(), local: { claudeCache: null, codexRollout: null } });
    expect(byId(s.providers, "codex")?.resetCredits).toEqual({
      held: 2,
      applicableNow: 0,
      credits: [
        { key: "key-A", expiresAtMs: Date.parse("2026-10-04T22:28:45Z") },
        { key: "key-B", expiresAtMs: Date.parse("2026-10-22T10:00:00Z") },
      ],
      stale: false,
      observedAt: T0 - HOUR,
    });
    expect(byId(s.providers, "claude")?.resetCredits).toBeNull();
  });

  test("明细列表与提醒同口径：已兑换 / 套餐不支持 / 兑换中的不列", () => {
    const r = remote();
    const data = structuredClone(creditsData);
    data.credits.push({ ...data.credits[0], key: "redeemed", status: "redeemed", redeemed: true });
    data.credits.push({ ...data.credits[0], key: "unsupported", supportedByPlan: false });
    data.credits.push({ ...data.credits[0], key: "pending", redeemStarted: true });
    r.codex.endpoints.codex_reset_credits = { ...r.codex.endpoints.codex_reset_credits!, snapshot: { data, observedAt: T0 } };
    const rc: ResetCreditsView | null | undefined = byId(selectQuotaLayers({ now: T0, enabled: true, remote: r, local: { claudeCache: null, codexRollout: null } }).providers, "codex")?.resetCredits;
    expect(rc?.credits?.map((c) => c.key)).toEqual(["key-A", "key-B"]);
  });

  test("明细从没拿到 → 只剩汇总，credits null 且标陈旧", () => {
    const r = remote();
    delete r.codex.endpoints.codex_reset_credits;
    const rc = byId(selectQuotaLayers({ now: T0, enabled: true, remote: r, local: { claudeCache: null, codexRollout: null } }).providers, "codex")?.resetCredits;
    expect(rc).toMatchObject({ held: 2, applicableNow: 0, credits: null, stale: true });
  });

  test("明细失败但有上次的 → 用上次的并标陈旧", () => {
    const r = remote();
    r.codex.endpoints.codex_reset_credits = { ...r.codex.endpoints.codex_reset_credits!, lastCode: "timeout", stale: true };
    const rc = byId(selectQuotaLayers({ now: T0, enabled: true, remote: r, local: { claudeCache: null, codexRollout: null } }).providers, "codex")?.resetCredits;
    expect(rc?.stale).toBe(true);
    expect(rc?.credits).toHaveLength(2);
  });
});

describe("通用接入商条目", () => {
  test("extra 里的按量接入商（Pi 自定义 provider）原样出现在末尾", () => {
    const pi: ProviderEntry = {
      id: "pi:openrouter",
      name: "OpenRouter",
      kind: "api",
      account: { key: null, identity: "unknown" },
      meters: [
        { id: "today", kind: "usage", label: "deepseek-v4", unit: "tokens", used: 120_000, periodMinutes: 1440 },
        { id: "month", kind: "usage", label: null, unit: "usd", used: 3.2, limit: 20, resetsAtMs: T0 + 72 * HOUR },
      ],
      balance: { amount: "16.80", currency: "USD" },
      source: { layer: "local_cache", observedAt: T0, reason: null },
    };
    const s = selectQuotaLayers({ now: T0, enabled: true, remote: remote(), local: { claudeCache: null, codexRollout: null }, extra: [pi] });
    expect(s.providers.at(-1)).toEqual(pi);
    expect(s.generatedAt).toBe(T0);
  });
});

describe("Claude 重置卡（cedar_ember）", () => {
  const withBlock = (block: Record<string, unknown> | null, stale = false): RemoteView => {
    const data = parseClaudeUsage({ ...claudeUsageBody(), ...(block ? { cedar_ember: block } : {}) }, (id) => `g-${id}`)!;
    return remote({ claude: {
      account: { key: "ck", identity: "assumed", uncertain: false }, credFailure: null,
      endpoints: { claude_usage: { snapshot: { data, observedAt: T0 - 60_000 }, lastCode: null, paused: false, stale } },
    } });
  };
  const claudeCard = (v: RemoteView) => selectQuotaLayers({ now: T0, enabled: true, remote: v, local: { claudeCache: null, codexRollout: null } }).providers.find((p) => p.id === "claude")!;

  test("剩余次数按卡加总、按截止排序、带「到限额才能用」；此刻可用只算 usable_now 的卡", () => {
    const rc = claudeCard(withBlock(cedarEmberBlock([
      { endsAt: "2026-10-20T09:00:00Z", left: 2, usableNow: true, requiresLimit: false },
      { endsAt: "2026-10-01T09:00:00Z" },
    ]))).resetCredits!;
    expect(rc.held).toBe(3);
    expect(rc.applicableNow).toBe(2);
    expect(rc.credits).toEqual([
      { key: `g-${GRANT_IDS[1]}`, expiresAtMs: Date.parse("2026-10-01T09:00:00Z"), left: 1, requiresLimit: true },
      { key: `g-${GRANT_IDS[0]}`, expiresAtMs: Date.parse("2026-10-20T09:00:00Z"), left: 2, requiresLimit: false },
    ]);
    expect(rc.stale).toBe(false);
  });

  test("暂停的、次数用完的、已过期的不算；没资格（eligible=false）全不算", () => {
    const block = cedarEmberBlock([
      { endsAt: "2026-10-01T09:00:00Z", paused: true },
      { endsAt: "2026-10-02T09:00:00Z", left: 0 },
      { endsAt: "2026-09-01T09:00:00Z" },
      { endsAt: "2026-10-03T09:00:00Z" },
    ]);
    expect(claudeCard(withBlock(block)).resetCredits!.held).toBe(1);
    expect(claudeCard(withBlock({ ...block, eligible: false })).resetCredits!.held).toBe(0);
  });

  test("接口没给这个块（旧账号）→ 卡上没有重置这一行，卡本身照常是 live", () => {
    const card = claudeCard(withBlock(null));
    expect(card.resetCredits).toBeNull();
    expect(card.source.layer).toBe("live");
  });
});
