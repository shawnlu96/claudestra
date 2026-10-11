/**
 * QLIMIT1 第 1 轮审查：明确已撞限的事实跨快照替换留存、不被无关的重置抹掉、不依赖百分比。
 * 走真实 QuotaScheduler（假时钟 / 假凭据 / 假 fetch / 内存存储）→ DTO → 落盘状态 → Inventory → 各道门；额度数据全部合成。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventoryQuota, type InventoryQuota, type QuotaReadDeps } from "../src/lib/ai-quota.js";
import { parseCodexRateLimits } from "../src/lib/codex-usage.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { PAUSE_FALLBACK_MS, quotaViewOf, refreshQuotaPause } from "../src/lib/lend-health.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { STATE_DIR, statePath } from "../src/lib/paths.js";
import { limitHorizon, retainLimitFact } from "../src/lib/quota-limit-facts.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import { quotaPoolTotals } from "../src/lib/scheduler-agent-pool-quota.js";
import { poolQuotaWait } from "../src/lib/scheduler-agent-pool-runtime.js";
import { codexQuotaWait } from "../src/lib/scheduler-local-runtime-quota.js";
import { CREDIT_IDS, codexAuth, codexUsageBody, fakePost, jsonResponse, okRoutes } from "./quota-fixtures.js";
import { harness, type Harness } from "./quota-scheduler-harness.js";

const H = 3600_000;
const P = "p";
const sec = (ms: number) => Math.round(ms / 1000);
type Flags = { allowed?: unknown; limit_reached?: unknown };
interface Wham { flags: Flags; shortResetAt: number; weekResetAt: number; usable?: number }

/** 合成的 wham/usage：周 99%、短窗 20%；标志与两个重置时刻由用例给 */
const whamRoute = (cur: () => Wham) => (url: string): Response => {
  if (!url.endsWith("/wham/usage")) return okRoutes(url);
  const w = cur();
  return jsonResponse(200, codexUsageBody({
    rate_limit: { ...w.flags,
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: sec(w.shortResetAt) },
      secondary_window: { used_percent: 99, limit_window_seconds: 604800, reset_at: sec(w.weekResetAt) } },
    rate_limit_reset_credits: { available_count: 2, applicable_available_count: w.usable ?? 0 },
  }));
};

let dir: string, ledgerPath: string, db: Database, journal: Database;
let h: Harness, wham: Wham;
const say = () => {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qlimit-retain-synthetic-"));
  ledgerPath = join(dir, "ledger.sqlite");
  db = openLedger(ledgerPath);
  // 两条线都放到 100：下面拦住新工作的只能是撞限事实，不是百分比
  db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?)").run(P, JSON.stringify({ weeklyLinePct: 100, codexWeeklyLinePct: 100 }));
  journal = openLendJournal(":memory:");
  h = harness(whamRoute(() => wham), memoryQuotaStore(), fakePost(() => jsonResponse(200, { code: "reset", credit: { id: CREDIT_IDS[0] }, windows_reset: 2 })));
  wham = { flags: { limit_reached: true }, shortResetAt: h.now + 2 * H, weekResetAt: h.now + 72 * H };
});
afterEach(() => {
  journal.close();
  closeLedger(ledgerPath);
  rmSync(dir, { recursive: true, force: true });
});

const refresh = async (flags: Flags) => {
  wham = { ...wham, flags };
  expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "fetched" });
};
const heldInStore = async () => {
  const st = await h.store.load();
  return st.accounts[st.current.codex!]!.snapshots.codex_usage!.data.limitHeld ?? null;
};

/** 落盘状态 → Inventory → 各道门此刻的结论 */
async function gates(rollout: QuotaReadDeps["codexRollout"] = async () => null) {
  const now = h.now;
  const q: InventoryQuota = (await readInventoryQuota({ now, enabled: () => true, loadState: () => h.store.load(), claudeCache: () => null, codexRollout: rollout })).codex;
  const view = quotaViewOf(q);
  mkdirSync(STATE_DIR, { recursive: true });
  const path = statePath("quota-state.json");
  writeFileSync(path, JSON.stringify(await h.store.load()));
  let poolTotal: number;
  try { poolTotal = quotaPoolTotals(db, P, { claude: 4, codex: 4 }, now).codex; } finally { rmSync(path, { force: true }); }
  return { flag: q.limitReached ?? null, full: view.full, resetsAt: view.resetsAt,
    paused: (await refreshQuotaPause(journal, async () => view, now, say)) !== null,
    runtime: (await codexQuotaWait(async () => q, now, { project: P, ledgerPath }))?.kind ?? null,
    pool: (await poolQuotaWait("codex", async () => q, now, { project: P, ledgerPath }))?.kind ?? null, poolTotal };
}
const BLOCKED = { flag: true, full: true, resetsAt: null, paused: true, runtime: "wait", pool: "wait", poolTotal: 0 };
const OPEN = { flag: false, full: false, resetsAt: null, paused: false, runtime: null, pool: null, poolTotal: 4 };

describe("[验收线 1] 同账户缺标志的新响应不清掉旧的明确撞限（刷新入库）", () => {
  for (const clear of [{ allowed: true }, { limit_reached: false }] as Flags[]) {
    test(`已撞限 → 缺标志仍拦 → ${JSON.stringify(clear)} 才放行`, async () => {
      const t0 = h.now;
      await refresh({ limit_reached: true });
      expect(await gates()).toEqual(BLOCKED);
      h.advance(61_000);
      await refresh({});
      expect(await heldInStore()).toEqual({ at: t0, until: t0 + 72 * H });
      expect(await gates()).toEqual(BLOCKED);
      h.advance(61_000);
      await refresh(clear);
      expect(await heldInStore()).toBeNull();
      expect(await gates()).toEqual(OPEN);
    });
  }

  test("两次刷新之间没人读、连着几次都缺标志：事实与它原来的观测时刻一直留着；allowed=false 起头同样", async () => {
    const t0 = h.now;
    await refresh({ allowed: false });
    for (let i = 0; i < 3; i++) {
      h.advance(61_000);
      await refresh(i === 1 ? { allowed: "yes", limit_reached: null } : {});
    }
    expect(await heldInStore()).toEqual({ at: t0, until: t0 + 72 * H });
    expect(await gates()).toEqual(BLOCKED);
    // 重启后从存储读回，留存的事实还在
    h.fresh();
    h.advance(61_000);
    await refresh({});
    expect(await gates()).toEqual(BLOCKED);
  });

  test("没有旧事实、或旧事实是明确没撞限：缺标志照旧是不知道，门按百分比", async () => {
    await refresh({});
    expect(await gates()).toEqual({ ...OPEN, flag: null });
    h.advance(61_000);
    await refresh({ allowed: true, limit_reached: false });
    h.advance(61_000);
    await refresh({});
    expect(await heldInStore()).toBeNull();
    expect(await gates()).toEqual({ ...OPEN, flag: null });
  });

  test("只在同账户内留存：换了号，缺标志的响应不继承上一个号的撞限", async () => {
    await refresh({ limit_reached: true });
    h.cd.files.set("/home/u/.codex/auth.json", codexAuth("tok-synthetic-b", "synthetic-account-b"));
    h.advance(61_000);
    await refresh({});
    expect(await heldInStore()).toBeNull();
    expect(await gates()).toEqual({ ...OPEN, flag: null });
  });

  test("有效期：那次观测的窗口全部重置完之后，缺标志的响应不再带着旧事实", async () => {
    await refresh({ limit_reached: true });
    h.advance(73 * H);
    wham = { ...wham, shortResetAt: h.now + 2 * H, weekResetAt: h.now + 100 * H };
    await refresh({});
    expect(await heldInStore()).toBeNull();
    expect((await gates()).flag).toBeNull();
  });
});

describe("[验收线 1] 用重置卡后的入库同样留存 / 纠正", () => {
  const consume = async (after: Flags) => {
    wham = { ...wham, usable: 1 };
    await refresh({ limit_reached: true });
    wham = { ...wham, flags: after };
    expect((await h.scheduler.consumeCodexReset(null)).status).toBe("done");
  };

  test("入库的新响应缺标志：旧的明确撞限留着，各门仍拦", async () => {
    const t0 = h.now;
    await consume({});
    expect(await heldInStore()).toEqual({ at: t0, until: t0 + 72 * H });
    expect(await gates()).toEqual(BLOCKED);
  });

  test("入库的新响应明确 allowed=true / limit_reached=false：照常纠正", async () => {
    await consume({ allowed: true, limit_reached: false });
    expect(await heldInStore()).toBeNull();
    expect(await gates()).toEqual(OPEN);
  });
});

describe("[验收线 1] 早于观测的重置不抹掉新撞限事实", () => {
  test("短窗 reset_at 比这次观测早 1 小时：仍已撞限，不编重置截止（暂停按兜底时长）", async () => {
    wham = { ...wham, shortResetAt: h.now - H };
    await refresh({ limit_reached: true });
    expect(await gates()).toEqual(BLOCKED);
    expect(await refreshQuotaPause(journal, async () => null, h.now, say)).toBe(h.now + PAUSE_FALLBACK_MS);
    // 之后缺标志的响应照样留着它，没有截止
    const t0 = h.now;
    h.advance(61_000);
    await refresh({});
    expect(await heldInStore()).toEqual({ at: t0, until: null });
    expect((await gates()).flag).toBe(true);
  });

  test("limitHorizon：全部窗口都在事实之后重置才有截止；缺重置时刻、早于或等于观测时刻、没有窗口 → 没有截止", () => {
    expect(limitHorizon(100, [{ resetsAtMs: 150 }, { resetsAtMs: 300 }])).toBe(300);
    for (const ws of [[{ resetsAtMs: 50 }, { resetsAtMs: 300 }], [{ resetsAtMs: 100 }, { resetsAtMs: 300 }], [{ resetsAtMs: null }, { resetsAtMs: 300 }],
      [{}, { resetsAtMs: 300 }], [{ resetsAtMs: NaN }], []]) expect(limitHorizon(100, ws)).toBeNull();
  });

  test("retainLimitFact：形状不对的留存不认，不凭空造出撞限", () => {
    const next = { limitReached: false, limitFact: "unknown", windows: [] };
    for (const limitHeld of [{ at: 5000, until: null }, { at: -1, until: null }, { at: "1", until: null }, { at: 10, until: "x" }, "reached", null]) {
      expect(retainLimitFact({ data: { limitReached: false, limitFact: "unknown", limitHeld }, observedAt: 1000 }, next, 2000)).toBe(next);
    }
    expect(retainLimitFact({ data: { limitReached: false, limitFact: "unknown", limitHeld: { at: 10, until: 1500 } }, observedAt: 1000 }, next, 2000)).toBe(next);
    expect(retainLimitFact(null, next, 2000)).toBe(next);
  });
});

describe("[验收线 1] rollout 没有百分比时，撞限声明照样保留", () => {
  const rollout = (observedAt: number, reached: unknown = "rate_limit_reached") => async () => ({
    source: "codex-rollout" as const,
    ...parseCodexRateLimits({ rate_limit_reached_type: reached,
      primary: { used_percent: null, window_minutes: 300, resets_at: sec(h.now + 2 * H) },
      secondary: { used_percent: null, window_minutes: 10080, resets_at: sec(h.now + 72 * H) } }, h.now)!,
    observedAt, sessionId: "synthetic", cwd: null, agent: null,
  });
  const noRemote = () => { h.store = memoryQuotaStore(); };

  test("两个窗口 used_percent 都是 null：flag=true，运行时与池子都等，暂停按兜底时长", async () => {
    noRemote();
    expect(await gates(rollout(h.now - 1000))).toEqual({ ...BLOCKED, poolTotal: 4 }); // 池子总量的同步读盘不读 rollout（原样）
  });

  test("观测时刻在未来 / 不合法：不认；没有 reached-type：不知道", async () => {
    noRemote();
    for (const at of [h.now + H, NaN, 0, -5]) expect((await gates(rollout(at))).flag).toBeNull();
    expect(await gates(rollout(h.now - 1000, null))).toEqual({ flag: null, full: null, resetsAt: null, paused: false, runtime: null, pool: null, poolTotal: 4 });
  });
});
