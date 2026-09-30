/**
 * lib/ai-quota.ts：只读落盘快照的额度段。验收线 P1：取不到的额度不能填成数字。
 * 另钉住 remoteViewOf 抽出来之后调度器 view() 的口径（开关关着不给账户数据）。
 */
import { describe, expect, test } from "bun:test";
import { quotaFor, readInventoryQuota, type QuotaReadDeps } from "../src/lib/ai-quota.js";
import type { QuotaSnapshot } from "../src/lib/quota-layers.js";
import { remoteViewOf } from "../src/lib/quota-scheduler.js";
import { emptyQuotaState, type QuotaState } from "../src/lib/quota-state.js";

const NOW = Date.UTC(2026, 8, 30, 12, 0);
const H = 3600_000;

function stateWithClaude(observedAt: number, windows: { id: string; usedPct: number; resetsAtMs: number }[]): QuotaState {
  const st = emptyQuotaState();
  st.current.claude = "acct1";
  st.accounts.acct1 = {
    provider: "claude", identity: "assumed", uncertain: false, rateLimitedUntil: null, lastSeenAt: observedAt, health: {},
    snapshots: {
      claude_usage: {
        observedAt,
        data: { resets: null, windows: windows.map((w) => ({ ...w, kind: w.id === "5h" ? "session" : "weekly", windowMinutes: w.id === "5h" ? 300 : 10080, severity: null, scopeModel: null })) },
      },
    },
  };
  return st;
}

const deps = (over: Partial<QuotaReadDeps>): QuotaReadDeps => ({
  now: NOW, enabled: () => true, loadState: async () => emptyQuotaState(), claudeCache: () => null, codexRollout: async () => null, ...over,
});

describe("readInventoryQuota", () => {
  test("什么都没有：两家都是 unknown，没有任何数字", async () => {
    const q = await readInventoryQuota(deps({}));
    for (const p of [q.claude, q.codex]) {
      expect(p.status).toBe("unknown");
      expect(p.windows).toEqual([]);
      expect(p.reason).toBeTruthy();
    }
  });

  test("实时快照：照报百分比与来源", async () => {
    const q = await readInventoryQuota(deps({ loadState: async () => stateWithClaude(NOW - 60_000, [{ id: "5h", usedPct: 40, resetsAtMs: NOW + H }]) }));
    expect(q.claude).toMatchObject({ status: "known", source: "live", observedAt: NOW - 60_000 });
    expect(q.claude.windows).toEqual([{ id: "5h", kind: "session", usedPct: 40, resetsAtMs: NOW + H, resetPassed: false }]);
  });

  test("已过重置时刻的旧百分比置 null，全部过期 = unknown", async () => {
    const q = await readInventoryQuota(deps({ loadState: async () => stateWithClaude(NOW - 8 * H, [{ id: "5h", usedPct: 90, resetsAtMs: NOW - H }]) }));
    expect(q.claude.status).toBe("unknown");
    expect(q.claude.windows).toEqual([{ id: "5h", kind: "session", usedPct: null, resetsAtMs: NOW - H, resetPassed: true }]);
  });

  test("旧快照与本机缓存取观测更新的那份", async () => {
    const q = await readInventoryQuota(deps({
      loadState: async () => stateWithClaude(NOW - 5 * H, [{ id: "7d", usedPct: 10, resetsAtMs: NOW + 48 * H }]),
      claudeCache: () => ({ sessionPct: 12, weekPct: 22, sessionResets: "", weekResets: "", sessionResetsAtMs: NOW + H, weekResetsAtMs: NOW + 48 * H, scrapedAt: NOW - 30_000 }),
    }));
    expect(q.claude.source).toBe("local_cache");
    expect(q.claude.windows.map((w) => w.usedPct)).toEqual([12, 22]);
  });

  test("statusline 缓存某个窗口没数：那一格 null，不补 0", async () => {
    const q = await readInventoryQuota(deps({
      claudeCache: () => ({ sessionPct: null, weekPct: 30, sessionResets: "", weekResets: "", sessionResetsAtMs: null, weekResetsAtMs: NOW + H, scrapedAt: NOW }),
    }));
    expect(q.claude.windows.map((w) => w.usedPct)).toEqual([null, 30]);
  });

  test("看板开关关着：不用账户快照（与看板同口径），只剩本机缓存", async () => {
    const q = await readInventoryQuota(deps({ enabled: () => false, loadState: async () => stateWithClaude(NOW, [{ id: "5h", usedPct: 40, resetsAtMs: NOW + H }]) }));
    expect(q.claude.status).toBe("unknown");
  });

  test("Codex rollout 观测：带套餐名", async () => {
    const q = await readInventoryQuota(deps({
      codexRollout: async () => ({
        source: "codex-rollout", plan: "prolite", credits: null, limitReached: null, observedAt: NOW - 1000, sessionId: "s", cwd: null, agent: null,
        windows: [{ id: "7d", windowMinutes: 10080, pct: 11, resets: "", resetsAtMs: NOW + 24 * H, resetPassed: false }],
      }),
    }));
    expect(q.codex).toMatchObject({ status: "known", source: "local_cache", plan: "prolite" });
    expect(q.codex.windows[0]!.usedPct).toBe(11);
  });

  test("某个来源抛错只少那一块", async () => {
    const q = await readInventoryQuota(deps({ loadState: async () => { throw new Error("boom"); }, claudeCache: () => { throw new Error("boom"); } }));
    expect(q.claude.status).toBe("unknown");
  });
});

test("quotaFor：账户卡在但没有窗口 → unknown 且带原因", () => {
  const snap: QuotaSnapshot = { generatedAt: NOW, providers: [{
    id: "claude", name: "Claude", kind: "subscription", account: { key: "k", identity: "assumed" }, meters: [], source: { layer: "none", observedAt: null, reason: "network" },
  }] };
  expect(quotaFor(snap, "claude")).toMatchObject({ status: "unknown", reason: "network", windows: [] });
});

test("remoteViewOf：开关关着不给账户数据", () => {
  const st = stateWithClaude(NOW, [{ id: "5h", usedPct: 1, resetsAtMs: NOW + H }]);
  expect(remoteViewOf(st, NOW, false).claude.account).toBeNull();
  expect(remoteViewOf(st, NOW, true).claude.endpoints.claude_usage?.stale).toBe(false);
});
