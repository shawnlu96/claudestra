/**
 * QLIMIT1 第 2 轮审查：
 *   - 撞限事实的有效期按那次响应的全部原始窗口算，百分比读不出来的窗口也在内（reset-erases-fact）
 *   - rollout 更新的观测没带 reached-type 不是解闸，更早的明确撞限照样留着（missing-flag-clear）
 * 远程走真实 QuotaScheduler（假时钟 / 假凭据 / 假 fetch / 内存存储）；rollout 走临时目录里的合成文件 →
 * findLatestCodexQuota → toCodexQuota → Inventory → 各道门。额度数据全部合成。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventoryQuota, type InventoryQuota } from "../src/lib/ai-quota.js";
import { findLatestCodexQuota, parseCodexRateLimits, toCodexQuota } from "../src/lib/codex-usage.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { quotaViewOf, refreshQuotaPause } from "../src/lib/lend-health.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { parseCodexUsage } from "../src/lib/quota-dto.js";
import { heldLimit, limitResetsOf } from "../src/lib/quota-limit-facts.js";
import { emptyQuotaState, memoryQuotaStore, type QuotaState } from "../src/lib/quota-state.js";
import { poolQuotaWait } from "../src/lib/scheduler-agent-pool-runtime.js";
import { codexQuotaWait } from "../src/lib/scheduler-local-runtime-quota.js";
import { codexUsageBody, jsonResponse, okRoutes } from "./quota-fixtures.js";
import { harness, type Harness } from "./quota-scheduler-harness.js";

const H = 3600_000;
const P = "p";
const sec = (ms: number) => Math.round(ms / 1000);
const SID_A = "01a0d336-6344-73d2-8b1d-a3d9399182b3";
const SID_B = "01a0ca8c-da9a-7742-a2b8-429bc956a7a0";

let dir: string, ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qlimit-rollout-synthetic-"));
  ledgerPath = join(dir, "ledger.sqlite");
  // 两条线都放到 100：下面拦住新工作的只能是撞限事实，不是百分比
  openLedger(ledgerPath).prepare("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?)")
    .run(P, JSON.stringify({ weeklyLinePct: 100, codexWeeklyLinePct: 100 }));
});
afterEach(() => {
  closeLedger(ledgerPath);
  rmSync(dir, { recursive: true, force: true });
});

/** Inventory → 出借暂停 / 本机运行时 / 池子运行时此刻的结论 */
async function gatesOf(q: InventoryQuota, now: number) {
  const view = quotaViewOf(q);
  const journal = openLendJournal(":memory:");
  try {
    return { flag: q.limitReached ?? null, full: view.full,
      paused: (await refreshQuotaPause(journal, async () => view, now, () => {})) !== null,
      runtime: (await codexQuotaWait(async () => q, now, { project: P, ledgerPath }))?.kind ?? null,
      pool: (await poolQuotaWait("codex", async () => q, now, { project: P, ledgerPath }))?.kind ?? null };
  } finally { journal.close(); }
}
const BLOCKED = { flag: true, full: true, paused: true, runtime: "wait" as const, pool: "wait" as const };
const UNKNOWN = { flag: null, full: null, paused: false, runtime: null, pool: null };

describe("[验收线 1] 远程：百分比读不出来的窗口也算在撞限事实的有效期里", () => {
  let h: Harness;
  let body: { flags: Record<string, unknown>; primary: unknown; secondary: unknown };
  beforeEach(() => {
    h = harness((url) => (url.endsWith("/wham/usage")
      ? jsonResponse(200, codexUsageBody({ rate_limit: { ...body.flags, primary_window: body.primary, secondary_window: body.secondary } }))
      : okRoutes(url)), memoryQuotaStore());
    body = { flags: { limit_reached: true },
      primary: { used_percent: 20, limit_window_seconds: 18000, reset_at: sec(h.now + H) },
      secondary: { used_percent: null, limit_window_seconds: 604800, reset_at: sec(h.now + 72 * H) } };
  });
  const refresh = async () => expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "fetched" });
  const gates = async () => gatesOf((await readInventoryQuota({ now: h.now, enabled: () => true, loadState: () => h.store.load(),
    claudeCache: () => null, codexRollout: async () => null })).codex, h.now);
  const stored = async () => {
    const st = await h.store.load();
    return st.accounts[st.current.codex!]!.snapshots.codex_usage!.data;
  };

  test("短窗 20% / T+1 小时、周窗 used_percent=null / T+72 小时：短窗重置后没有新响应，仍已撞限；周窗也重置完才按不知道", async () => {
    const t0 = h.now;
    await refresh();
    expect((await stored()).windows.map((w) => w.id)).toEqual(["5h"]); // 周窗没有百分比，进不了 windows
    expect((await stored()).limitResets).toEqual([t0 + H, t0 + 72 * H]);
    expect(await gates()).toEqual(BLOCKED);
    h.advance(2 * H);
    expect(await gates()).toEqual(BLOCKED);
    h.advance(71 * H);
    expect(await gates()).toEqual(UNKNOWN);
  });

  test("之后缺标志的响应带走的留存，截止同样是周窗的重置时刻", async () => {
    const t0 = h.now;
    await refresh();
    h.advance(2 * H);
    body = { ...body, flags: {}, primary: { used_percent: 3, limit_window_seconds: 18000, reset_at: sec(h.now + 5 * H) } };
    await refresh();
    expect((await stored()).limitHeld).toEqual({ at: t0, until: t0 + 72 * H });
    expect((await gates()).flag).toBe(true);
  });

  test("有窗口读不出重置时刻（坏值 / 不是对象）：覆盖不全，不编截止，一直作数到明确解闸", async () => {
    for (const secondary of [{ used_percent: null, limit_window_seconds: 604800, reset_at: "soon" }, { used_percent: null }, "weekly"]) {
      h = harness(h.route, memoryQuotaStore());
      body = { ...body, flags: { limit_reached: true }, secondary };
      await refresh();
      expect((await stored()).limitResets?.[1]).toBeNull();
      h.advance(200 * H);
      expect((await gates()).flag).toBe(true);
      body = { ...body, flags: { allowed: true, limit_reached: false } };
      await refresh();
      expect((await gates()).flag).toBe(false);
    }
  });

  test("没给的槽位（null / 缺）不算窗口；明确没撞限 / 没说的响应不带 limitResets；没存 limitResets 的旧快照没有截止", () => {
    const R1 = h.now + H;
    const rl = (flags: object, secondary?: unknown) => parseCodexUsage({ rate_limit: { ...flags,
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: sec(R1) }, ...(secondary === undefined ? {} : { secondary_window: secondary }) } })!;
    expect(rl({ limit_reached: true }).limitResets).toEqual([R1]);
    expect(rl({ limit_reached: true }, null).limitResets).toEqual([R1]);
    expect(rl({ allowed: false }, { used_percent: 5, reset_at: sec(R1 + H) }).limitResets).toEqual([R1, R1 + H]);
    expect("limitResets" in rl({ allowed: true })).toBe(false);
    expect("limitResets" in rl({})).toBe(false);
    expect(limitResetsOf([undefined, null, 7, { t: 5 }, { t: null }], (w) => w.t as number | null)).toEqual([null, 5, null]);
    expect(heldLimit(100, [150, 300])).toEqual({ at: 100, until: 300 });
    for (const resets of [undefined, null, "x", [], [150, null], [150, "300"], [50, 300]]) expect(heldLimit(100, resets)).toEqual({ at: 100, until: null });
  });
});

describe("[验收线 1] rollout：更新的观测没带 reached-type 不清掉更早的明确撞限", () => {
  const NOW = Date.parse("2026-10-11T06:00:00Z");
  let root: string;
  beforeEach(() => { root = join(dir, "sessions"); });

  type Limits = { reached?: unknown; short?: unknown; week?: unknown; shortReset?: number | null; weekReset?: number | null };
  const tokenCount = (at: number, l: Limits = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: "event_msg",
    payload: { type: "token_count", info: null, rate_limits: {
      primary: { used_percent: "short" in l ? l.short : 20, window_minutes: 300, resets_at: l.shortReset === null ? null : sec(l.shortReset ?? NOW + 2 * H) },
      secondary: { used_percent: "week" in l ? l.week : 40, window_minutes: 10080, resets_at: l.weekReset === null ? null : sec(l.weekReset ?? NOW + 72 * H) },
      plan_type: "plus", ...("reached" in l ? { rate_limit_reached_type: l.reached } : {}) } } }) + "\n";
  const fileOf = (sid: string) => {
    const d = join(root, "2026", "10", "11");
    mkdirSync(d, { recursive: true });
    return join(d, `rollout-2026-10-11T01-00-00-${sid}.jsonl`);
  };
  const start = (sid: string, ...lines: string[]) => {
    writeFileSync(fileOf(sid), JSON.stringify({ timestamp: new Date(NOW - 5 * H).toISOString(), type: "session_meta", payload: { id: sid, cwd: "/work/synthetic" } }) + "\n" + lines.join(""));
  };
  const inventory = async (now = NOW, state: QuotaState = emptyQuotaState()) => (await readInventoryQuota({ now, enabled: () => true,
    loadState: async () => state, claudeCache: () => null,
    codexRollout: async (t) => {
      const raw = await findLatestCodexQuota(root, { now: t, diagnostic: () => {} });
      return raw ? toCodexQuota(raw, [], t) : null;
    } })).codex;
  const gates = async (now = NOW) => gatesOf(await inventory(now), now);
  const pct = (q: InventoryQuota, id: string) => q.windows.find((w) => w.id === id)?.usedPct;

  test("同一个 rollout 文件：带 reached-type 的 token_count 之后追加更新 1 秒、缺该字段的一条 → 各门仍拦，百分比用最新的", async () => {
    start(SID_A, tokenCount(NOW - 10_000, { reached: "rate_limit_reached" }));
    expect(await gates()).toEqual(BLOCKED);
    appendFileSync(fileOf(SID_A), tokenCount(NOW - 9000, { week: 41 }));
    expect(await gates()).toEqual(BLOCKED);
    const q = await inventory();
    expect([q.observedAt, pct(q, "7d"), pct(q, "5h")]).toEqual([NOW - 9000, 41, 20]);
    // 接着再来几条没带的（含显式 null）：照样留着，时刻还是原来那次
    appendFileSync(fileOf(SID_A), tokenCount(NOW - 8000, { reached: null }) + tokenCount(NOW - 7000));
    expect(await gates()).toEqual(BLOCKED);
    const raw = (await findLatestCodexQuota(root, { now: NOW }))!;
    expect(toCodexQuota(raw, [], NOW)!.limitHeld).toEqual({ at: NOW - 10_000, until: NOW + 72 * H });
  });

  test("更新的观测在另一个会话文件里也一样；再次明确撞限时按新那次的时刻算", async () => {
    start(SID_A, tokenCount(NOW - 10_000, { reached: "rate_limit_reached" }));
    start(SID_B, tokenCount(NOW - 5000));
    expect(await gates()).toEqual(BLOCKED);
    appendFileSync(fileOf(SID_B), tokenCount(NOW - 1000, { reached: "workspace_member_usage_limit_reached", weekReset: NOW + 90 * H }));
    const latest = toCodexQuota((await findLatestCodexQuota(root, { now: NOW }))!, [], NOW)!;
    expect([latest.limitReached, latest.limitHeld, latest.limitResets]).toEqual(["workspace_member_usage_limit_reached", undefined, [NOW + 2 * H, NOW + 90 * H]]);
    expect(await gates(NOW + 80 * H)).toMatchObject({ flag: true, runtime: "wait", pool: "wait" });
  });

  test("有效期：撞限那次观测的窗口全部重置完，留存不再作数；有窗口读不出重置时刻就没有截止", async () => {
    start(SID_A, tokenCount(NOW - 10_000, { reached: "rate_limit_reached" }));
    const later = NOW + 73 * H;
    appendFileSync(fileOf(SID_A), tokenCount(later - 1000, { shortReset: later + 2 * H, weekReset: later + 100 * H }));
    expect((await gates(NOW + 71 * H)).flag).toBe(true); // 周窗还没重置（那时更晚的一条还在未来，不算观测）
    expect(await gates(later)).toEqual({ flag: null, full: false, paused: false, runtime: null, pool: null });

    rmSync(root, { recursive: true });
    start(SID_B, tokenCount(NOW - 10_000, { reached: "rate_limit_reached", week: null, weekReset: null }));
    appendFileSync(fileOf(SID_B), tokenCount(later - 1000, { shortReset: later + 2 * H, weekReset: later + 100 * H }));
    expect(await gates(later)).toEqual(BLOCKED);
  });

  test("最新一条自己带 reached-type、周窗没有百分比也没有重置时刻（进不了 windows）：短窗重置后仍已撞限", async () => {
    const o = parseCodexRateLimits({ rate_limit_reached_type: "rate_limit_reached",
      primary: { used_percent: 20, window_minutes: 300, resets_at: sec(NOW + H) }, secondary: { used_percent: null, window_minutes: 10080 } }, NOW)!;
    expect([o.windows.length, o.limitResets]).toEqual([1, [NOW + H, null]]);
    start(SID_A, tokenCount(NOW - 10_000, { reached: "rate_limit_reached", shortReset: NOW + H, week: null, weekReset: null }));
    expect((await gates(NOW + 2 * H)).flag).toBe(true);
    // 周窗有重置时刻、只是没有百分比：短窗重置后仍拦，周窗也重置完才按不知道
    rmSync(root, { recursive: true });
    start(SID_B, tokenCount(NOW - 10_000, { reached: "rate_limit_reached", shortReset: NOW + H, week: null }));
    expect(await gates(NOW + 2 * H)).toMatchObject({ flag: true, runtime: "wait", pool: "wait" });
    expect((await gates(NOW + 73 * H)).flag).toBeNull();
  });

  test("不凭空造：从没明确撞限过 → 不知道；撞限那条的时刻在未来 / 不合法 → 不留存", async () => {
    start(SID_A, tokenCount(NOW - 10_000) + tokenCount(NOW - 9000, { reached: null }) + tokenCount(NOW - 8000, { reached: "" }));
    expect(await gates()).toEqual({ flag: null, full: false, paused: false, runtime: null, pool: null });
    start(SID_B, tokenCount(NOW + H, { reached: "rate_limit_reached" }) +
      tokenCount(NOW - 20_000, { reached: "rate_limit_reached" }).replace(/"timestamp":"[^"]*"/, '"timestamp":"bad"'));
    expect((await gates()).flag).toBeNull();
  });
});
