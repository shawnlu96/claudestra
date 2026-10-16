/**
 * QFA-1 端到端：Claude 免费重置后，闲置会话状态栏（没有 five_hour）还报重置前的 97%。
 * 真跑 usage-cache-write.sh → readUsageCacheStale → readInventoryQuota → 额度线事实 → GET /lend/quota-lines，
 * Claude 本周不能是 97、提醒线不能亮。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventoryQuota } from "../src/lib/ai-quota.js";
import { mergeReport } from "../src/lib/lend-quota-line-facts.js";
import { readUsageCacheStale } from "../src/lib/usage-cache.js";
import { QUOTA_TIMING } from "../src/lib/quota-policy.js";
import { emptyQuotaState } from "../src/lib/quota-state.js";
import { makeLendQuotaLinesApi } from "../src/bridge/local-api/lend-quota-lines.js";
import type { Principal } from "../src/lib/principals.js";

const SCRIPT = join(import.meta.dir, "..", "scripts", "usage-cache-write.sh");
const dir = mkdtempSync(join(tmpdir(), "qfa1-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function statusline(rateLimits: unknown): Promise<void> {
  const p = Bun.spawn(["bash", SCRIPT], {
    stdin: new TextEncoder().encode(JSON.stringify({ rate_limits: rateLimits })),
    env: { ...process.env, CLAUDESTRA_STATE_DIR: dir }, stdout: "ignore", stderr: "ignore",
  });
  await p.exited;
}

test("账号接口 19 + 活跃会话 18 + 闲置会话 97 → Claude 本周不是 97，quota-lines 不提醒", async () => {
  const now = Date.now();
  const weekReset = Math.floor(now / 1000) + 3 * 86_400;
  // 账号接口读数较早（已过 usageStaleMs = live_stale），本机缓存才会参与取最新——生产里就是这条路
  const acctAt = now - QUOTA_TIMING.usageStaleMs - 60_000;
  const st = emptyQuotaState();
  st.current.claude = "acct1";
  st.accounts.acct1 = {
    provider: "claude", identity: "assumed", uncertain: false, rateLimitedUntil: null, lastSeenAt: acctAt, health: {},
    snapshots: { claude_usage: { observedAt: acctAt, data: { resets: null, windows: [
      { id: "7d", kind: "weekly", windowMinutes: 10080, usedPct: 19, resetsAtMs: weekReset * 1000, severity: null, scopeModel: null },
    ] } } },
  };
  await statusline({ five_hour: { used_percentage: 30, resets_at: Math.floor(now / 1000) + 3600 }, seven_day: { used_percentage: 18, resets_at: weekReset } });
  await statusline({ seven_day: { used_percentage: 97, resets_at: weekReset } });

  const t = Date.now();
  const inv = await readInventoryQuota({
    now: t, enabled: () => true, loadState: async () => st, codexRollout: async () => null,
    claudeCache: (n) => readUsageCacheStale(n, join(dir, "usage-cache.json"), null),
  });
  const week = inv.claude.windows.find((w) => w.kind === "weekly");
  expect(week?.usedPct).not.toBe(97);
  expect([18, 19]).toContain(week?.usedPct ?? -1);

  const facts = mergeReport({}, { claude: inv.claude }, t);
  expect(facts.claude?.weekUsedPct).not.toBe(97);
  const owner: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-10-01T00:00:00Z", terminal: true };
  const api = makeLendQuotaLinesApi({
    linesPath: join(dir, "lines.json"), lendPath: join(dir, "lend.json"), now: () => t, facts: async () => facts,
    context: async () => ({ contacts: [], projects: [] }), actual: () => [], log: () => {},
  });
  const r = await api(new Request("http://x/api/v1/lend/quota-lines"), "/lend/quota-lines", owner);
  const body = (await r!.json()) as { families: { family: string; weekUsedPct: number | null; state: string }[] };
  const claude = body.families.find((f) => f.family === "claude")!;
  expect(claude.weekUsedPct).not.toBe(97);
  expect(claude.state).toBe("below");
});
