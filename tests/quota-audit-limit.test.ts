/**
 * QLIMIT1：提供方明确说的「已撞限」要一路带到 Inventory 与各道额度门；不到 100 的读数不被舍入成 100。
 * 全部是合成的额度数据：响应体手写，台账与 journal 在临时目录 / 内存里，quota-state.json 只写进测试进程的临时状态目录。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInventoryQuota, type InventoryQuota } from "../src/lib/ai-quota.js";
import { parseCodexRateLimits, type CodexQuotaObservation } from "../src/lib/codex-usage.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { pausedUntil, PAUSE_FALLBACK_MS, quotaViewOf, refreshQuotaPause } from "../src/lib/lend-health.js";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { STATE_DIR, statePath } from "../src/lib/paths.js";
import { parseClaudeUsage, parseCodexUsage, pctOf } from "../src/lib/quota-dto.js";
import { emptyQuotaState, normalizeQuotaState, type QuotaState } from "../src/lib/quota-state.js";
import { weekOf } from "../src/lib/quota-week.js";
import { quotaPoolTotals } from "../src/lib/scheduler-agent-pool-quota.js";
import { poolQuotaWait } from "../src/lib/scheduler-agent-pool-runtime.js";
import { codexQuotaWait } from "../src/lib/scheduler-local-runtime-quota.js";

const NOW = Date.parse("2026-10-11T06:00:00Z");
const H = 3600_000;
const P = "p";
const sec = (ms: number) => Math.round(ms / 1000);

type Flags = { allowed?: unknown; limit_reached?: unknown };
/** 合成的 wham/usage：周窗口 week%、5 小时窗口 20%，撞限标志由用例给 */
const whamBody = (flags: Flags, week: unknown = 99, short: unknown = 20) => ({
  plan_type: "plus",
  rate_limit: {
    ...flags,
    primary_window: { used_percent: short, limit_window_seconds: 18000, reset_at: sec(NOW + 2 * H) },
    secondary_window: { used_percent: week, limit_window_seconds: 604800, reset_at: sec(NOW + 72 * H) },
  },
});
const rolloutLimits = (reached: unknown, week: unknown = 99, short: unknown = 20) => ({
  primary: { used_percent: short, window_minutes: 300, resets_at: sec(NOW + 2 * H) },
  secondary: { used_percent: week, window_minutes: 10080, resets_at: sec(NOW + 72 * H) },
  plan_type: "plus",
  ...(reached === undefined ? {} : { rate_limit_reached_type: reached }),
});

/** 解析后的 DTO 当成调度器落盘的快照，再按读盘的路子过一遍 normalizeQuotaState */
function diskState(snapshots: Record<string, unknown>, provider: "codex" | "claude" = "codex", observedAt = NOW - 1000): QuotaState {
  const st = emptyQuotaState();
  st.current[provider] = "acct-synthetic";
  st.accounts["acct-synthetic"] = { provider, identity: "assumed", uncertain: false, rateLimitedUntil: null, lastSeenAt: observedAt, health: {},
    snapshots: Object.fromEntries(Object.entries(snapshots).map(([e, data]) => [e, { observedAt, data }])) } as never;
  return normalizeQuotaState(JSON.parse(JSON.stringify(st)));
}
const remoteState = (body: unknown, observedAt?: number) => diskState({ codex_usage: parseCodexUsage(body) }, "codex", observedAt);

function rolloutObservation(rl: unknown, observedAt = NOW - 1000): CodexQuotaObservation {
  return { source: "codex-rollout", ...parseCodexRateLimits(rl, NOW)!, observedAt, sessionId: "synthetic", cwd: null, agent: null };
}

async function codexInventory(src: { state?: QuotaState; rollout?: CodexQuotaObservation }): Promise<InventoryQuota> {
  const all = await readInventoryQuota({ now: NOW, enabled: () => true, loadState: async () => src.state ?? emptyQuotaState(),
    claudeCache: () => null, codexRollout: async () => src.rollout ?? null });
  return all.codex;
}
const fromWham = (flags: Flags, week?: unknown, short?: unknown) => codexInventory({ state: remoteState(whamBody(flags, week, short)) });
const fromRollout = (reached: unknown, week?: unknown, short?: unknown) => codexInventory({ rollout: rolloutObservation(rolloutLimits(reached, week, short)) });
const pct = (q: InventoryQuota, id: string) => q.windows.find((w) => w.id === id)?.usedPct;

let dir: string, ledgerPath: string, db: Database, journal: Database;
const log: string[] = [];
const say = (m: string) => { log.push(m); };
const at = () => ({ project: P, ledgerPath });
const setLines = (value: Record<string, number>) =>
  db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'autostart', ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run(P, JSON.stringify(value));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qlimit-synthetic-"));
  ledgerPath = join(dir, "ledger.sqlite");
  db = openLedger(ledgerPath);
  journal = openLendJournal(":memory:");
  log.length = 0;
});
afterEach(() => {
  journal.close();
  closeLedger(ledgerPath);
  rmSync(dir, { recursive: true, force: true });
});

/** 池子总量走它自己的同步读盘：把合成快照放进测试进程的临时状态目录，读完就删，不留给同进程的其它用例 */
function poolTotals(state: QuotaState): { claude: number; codex: number } {
  mkdirSync(STATE_DIR, { recursive: true });
  const path = statePath("quota-state.json");
  writeFileSync(path, JSON.stringify(state));
  try { return quotaPoolTotals(db, P, { claude: 4, codex: 4 }, NOW); }
  finally { rmSync(path, { force: true }); }
}

/** 四道门此刻的结论：出借暂停截止、本机运行时、池子运行时 */
async function gates(q: InventoryQuota) {
  const view = quotaViewOf(q);
  return { view, pause: await refreshQuotaPause(journal, async () => view, NOW, say),
    runtime: await codexQuotaWait(async () => q, NOW, at()), pool: await poolQuotaWait("codex", async () => q, NOW, at()) };
}

describe("[验收线 1] 明确已撞限：99% 周、20% 短窗、线 100 也不开放新工作", () => {
  beforeEach(() => setLines({ weeklyLinePct: 100, codexWeeklyLinePct: 100 }));

  const sources: [string, () => Promise<InventoryQuota>][] = [
    ["wham limit_reached=true", () => fromWham({ allowed: true, limit_reached: true })],
    ["wham allowed=false", () => fromWham({ allowed: false, limit_reached: false })],
    ["wham 只给 allowed=false", () => fromWham({ allowed: false })],
    ["rollout rate_limit_reached_type", () => fromRollout("rate_limit_reached")],
  ];
  for (const [name, read] of sources) test(`${name} → Inventory 带着事实，quotaView / 暂停 / 运行时 / 池子运行时都拦`, async () => {
    const q = await read();
    expect(q.limitReached).toBe(true);
    // 事实与百分比互不改写：读数还是 99 / 20
    expect([pct(q, "7d"), pct(q, "5h")]).toEqual([99, 20]);
    const g = await gates(q);
    expect(g.view.full).toBe(true);
    // 撞的是哪个窗口接口没说：不拿 99% 那个窗口的重置时刻当截止，按兜底时长
    expect(g.view.resetsAt).toBeNull();
    expect(g.pause).toBe(NOW + PAUSE_FALLBACK_MS);
    expect(g.runtime).toMatchObject({ kind: "wait", reason: expect.stringContaining("已撞限") });
    expect(g.pool).toMatchObject({ kind: "wait", reason: expect.stringContaining("已撞限") });
  });

  test("池子总量：明确已撞限的那家名额归 0，另一家 4 位不动", () => {
    expect(poolTotals(remoteState(whamBody({ allowed: true, limit_reached: true })))).toEqual({ claude: 4, codex: 0 });
    expect(poolTotals(remoteState(whamBody({ allowed: false })))).toEqual({ claude: 4, codex: 0 });
  });

  test("明确没撞限（allowed=true / limit_reached=false）且 99%：四道门照旧放行", async () => {
    for (const flags of [{ allowed: true, limit_reached: false }, { limit_reached: false }, { allowed: true }]) {
      const q = await fromWham(flags);
      expect(q.limitReached).toBe(false);
      const g = await gates(q);
      expect([g.view.full, g.pause, g.runtime, g.pool]).toEqual([false, null, null, null]);
      expect(poolTotals(remoteState(whamBody(flags)))).toEqual({ claude: 4, codex: 4 });
    }
  });

  test("缺标志 / 标志不是布尔值 = 不知道，不是 false；门按百分比照旧", async () => {
    const unknowns = [await fromWham({}), await fromWham({ allowed: "yes", limit_reached: 1 }), await fromWham({ allowed: null, limit_reached: null }),
      await fromRollout(undefined), await fromRollout(null), await fromRollout("")];
    for (const q of unknowns) {
      expect(q.limitReached ?? null).toBeNull();
      const g = await gates(q);
      expect([g.view.full, g.view.limit, g.pause, g.runtime, g.pool]).toEqual([false, undefined, null, null, null]);
    }
    expect(poolTotals(remoteState(whamBody({})))).toEqual({ claude: 4, codex: 4 });
  });

  test("标志与百分比独立：明确没撞限但窗口真到 100 仍是 full，截止取那个窗口的重置时刻", async () => {
    const q = await fromWham({ allowed: true, limit_reached: false }, 100);
    expect(q.limitReached).toBe(false);
    expect(quotaViewOf(q)).toMatchObject({ full: true, resetsAt: sec(NOW + 72 * H) * 1000 });
    // 已撞限且有窗口真到 100：截止只取真满的窗口，不取没满的短窗
    const both = await fromWham({ limit_reached: true }, 100);
    expect(quotaViewOf(both)).toMatchObject({ full: true, resetsAt: sec(NOW + 72 * H) * 1000 });
  });

  test("观测时刻不可信，或观测后已有窗口过了重置时刻：事实按不知道，不沿用", async () => {
    const future = await codexInventory({ state: remoteState(whamBody({ limit_reached: true }), NOW + H) });
    expect(future.limitReached ?? null).toBeNull();
    const body = whamBody({ limit_reached: true });
    body.rate_limit.primary_window.reset_at = sec(NOW - H);
    const passed = await codexInventory({ state: remoteState(body) });
    expect(passed.limitReached ?? null).toBeNull();
    const rl = rolloutLimits("rate_limit_reached");
    rl.primary.resets_at = sec(NOW - H);
    expect((await codexInventory({ rollout: rolloutObservation(rl) })).limitReached ?? null).toBeNull();
    expect((await codexInventory({ rollout: rolloutObservation(rolloutLimits("rate_limit_reached"), NOW + H) })).limitReached ?? null).toBeNull();
  });

  test("旧旗标只认明确的解闸：缺字段的新读数不恢复借单，allowed=true / limit_reached=false 才恢复", async () => {
    const reached = quotaViewOf(await fromWham({ limit_reached: true }));
    expect(await refreshQuotaPause(journal, async () => reached, NOW, say)).toBe(NOW + PAUSE_FALLBACK_MS);
    const later = (flags: Flags) => codexInventory({ state: remoteState(whamBody(flags, 99), NOW + 60_000) });
    // 之后的读数没带标志、百分比不满：不能当成解闸
    const silent = quotaViewOf(await later({}));
    expect(silent.full).toBe(false);
    expect(await refreshQuotaPause(journal, async () => ({ ...silent, observedAt: NOW + 60_000 }), NOW + 61_000, say)).toBe(NOW + PAUSE_FALLBACK_MS);
    const cleared = quotaViewOf(await later({ allowed: true, limit_reached: false }));
    expect(await refreshQuotaPause(journal, async () => ({ ...cleared, observedAt: NOW + 60_000 }), NOW + 62_000, say)).toBeNull();
    expect(pausedUntil(journal, NOW + 62_000)).toBeNull();
  });

  test("不是撞限旗标引起的暂停：观测到不满照旧恢复（不要求带标志）", async () => {
    const full = quotaViewOf(await fromWham({}, 100));
    expect(await refreshQuotaPause(journal, async () => full, NOW, say)).toBe(sec(NOW + 72 * H) * 1000);
    const notFull = { ...quotaViewOf(await fromWham({}, 40)), observedAt: NOW + 60_000 };
    expect(await refreshQuotaPause(journal, async () => notFull, NOW + 61_000, say)).toBeNull();
  });

  test("先因 worker 撞额度暂停，之后观测到明确已撞限：这次暂停同样只认明确的解闸", async () => {
    const full = quotaViewOf(await fromWham({}, 100));
    const until = await refreshQuotaPause(journal, async () => full, NOW, say);
    const reached = { ...quotaViewOf(await fromWham({ limit_reached: true })), observedAt: NOW + 30_000 };
    expect(await refreshQuotaPause(journal, async () => reached, NOW + 31_000, say)).toBe(until);
    const silent = { ...quotaViewOf(await fromWham({}, 40)), observedAt: NOW + 60_000 };
    expect(await refreshQuotaPause(journal, async () => silent, NOW + 61_000, say)).toBe(until);
  });
});

describe("[验收线 2] 不到 100 的读数不舍入成 full", () => {
  const NEAR = [99.49, 99.5, 99.96, 99.999];

  test("远程（0.1 精度）：99.49 / 99.5 / 99.96 最多 99.9，不 full；真实 100 与超额才是 100", async () => {
    expect(NEAR.map(pctOf)).toEqual([99.5, 99.5, 99.9, 99.9]);
    expect([100, 100.04, 137].map(pctOf)).toEqual([100, 100, 100]);
    for (const raw of NEAR) {
      const q = await fromWham({ allowed: true, limit_reached: false }, raw);
      expect(pct(q, "7d")!).toBeLessThan(100);
      expect(quotaViewOf(q).full).toBe(false);
    }
    expect(quotaViewOf(await fromWham({ allowed: true, limit_reached: false }, 100)).full).toBe(true);
    // 明确的标志才让不满的读数算 full
    expect(quotaViewOf(await fromWham({ limit_reached: true }, 99.96)).full).toBe(true);
  });

  test("Claude 的两种响应形态走同一个边界", () => {
    const limits = { limits: [{ kind: "weekly_all", percent: 99.96, resets_at: new Date(NOW + H).toISOString() }] };
    expect(parseClaudeUsage(limits, (s) => s)?.windows[0]?.usedPct).toBe(99.9);
    expect(parseClaudeUsage({ seven_day: { utilization: 99.96, resets_at: new Date(NOW + H).toISOString() } }, (s) => s)?.windows[0]?.usedPct).toBe(99.9);
  });

  test("本地 rollout（整数精度）：最多 99，不 full；真实 100 才 full", async () => {
    for (const raw of NEAR) {
      const q = await fromRollout(null, raw);
      expect(pct(q, "7d")).toBe(99);
      expect(quotaViewOf(q).full).toBe(false);
    }
    const q = await fromRollout(null, 100);
    expect(pct(q, "7d")).toBe(100);
    expect(quotaViewOf(q).full).toBe(true);
    expect(pct(await fromRollout(null, 250), "7d")).toBe(100);
  });

  test("peer 整数 wire（hello 的 weekUsedPct）：远程、本地读数出去都最多 99，真实 100 才是 100", async () => {
    for (const raw of NEAR) {
      for (const q of [await fromWham({}, raw), await fromRollout(null, raw)]) {
        const w = weekOf(q, NOW)!;
        expect(w.weekUsedPct).toBe(99);
        expect(Number.isInteger(w.weekUsedPct)).toBe(true);
      }
    }
    for (const q of [await fromWham({}, 100), await fromRollout(null, 100)]) expect(weekOf(q, NOW)!.weekUsedPct).toBe(100);
    // 明确已撞限不改 wire 上的百分比：事实与读数独立，wire 也没有放它的字段
    expect(weekOf(await fromWham({ limit_reached: true }), NOW)).toEqual({ weekUsedPct: 99, resetAt: sec(NOW + 72 * H) * 1000 });
  });

  test("invalid / null / 缺窗不伪造成 0", async () => {
    const noWeek = whamBody({});
    delete (noWeek.rate_limit as Record<string, unknown>).secondary_window;
    for (const body of [...[null, "99", NaN, -1].map((bad) => whamBody({}, bad)), noWeek]) {
      const remote = await codexInventory({ state: remoteState(body) });
      expect(remote.windows.map((w) => w.id)).toEqual(["5h"]);
      expect(weekOf(remote, NOW)).toBeNull();
    }
    const noPct = rolloutLimits(null);
    delete (noPct.secondary as Record<string, unknown>).used_percent;
    for (const rl of [...[null, "99", NaN].map((bad) => rolloutLimits(null, bad)), noPct]) {
      const local = await codexInventory({ rollout: rolloutObservation(rl) });
      expect(pct(local, "7d")).toBeNull();
      expect(weekOf(local, NOW)).toBeNull();
      // 有窗口没数：不知道，不当成「不满」
      expect(quotaViewOf(local).full).toBeNull();
    }
    const none = await codexInventory({});
    expect([none.status, none.windows, none.limitReached ?? null]).toEqual(["unknown", [], null]);
    expect(quotaViewOf(none)).toEqual({ observedAt: null, full: null, resetsAt: null });
    expect(parseCodexUsage({ plan_type: "plus", rate_limit: { limit_reached: true } })).toBeNull();
  });

  test("95 / 70 / 80 的比较与舍入原样（只做回归对照）", async () => {
    expect([94.96, 94.94, 69.96, 69.94, 79.96, 79.94, 41.64].map(pctOf)).toEqual([95, 94.9, 70, 69.9, 80, 79.9, 41.6]);
    // wire 那一列是远程 0.1 精度读数再取整（94.49 → 94.5 → 95），原来就是这样，不在本卡统一
    for (const [raw, local, wire] of [[94.5, 95, 95], [94.49, 94, 95], [94.44, 94, 94], [69.5, 70, 70], [79.5, 80, 80], [0.4, 0, 0]] as const) {
      expect(pct(await fromRollout(null, raw), "7d")).toBe(local);
      expect(weekOf(await fromWham({}, raw), NOW)!.weekUsedPct).toBe(wire);
    }
    setLines({ weeklyLinePct: 70, codexWeeklyLinePct: 95 });
    const wait = async (raw: number) => {
      const q = await fromWham({ allowed: true, limit_reached: false }, raw);
      return [await codexQuotaWait(async () => q, NOW, at()), await poolQuotaWait("codex", async () => q, NOW, at())].map((w) => w?.kind ?? null);
    };
    expect(await wait(94.94)).toEqual([null, null]);
    expect(await wait(94.96)).toEqual(["wait", "wait"]);
    expect(await wait(95)).toEqual(["wait", "wait"]);
    const codexAt = (raw: number) => poolTotals(remoteState(whamBody({ allowed: true, limit_reached: false }, raw))).codex;
    expect([94.94, 94.96, 95].map(codexAt)).toEqual([4, 0, 0]);
    const claudeAt = (raw: number) => poolTotals(diskState({ claude_usage: parseClaudeUsage({ limits: [
      { kind: "weekly_all", percent: raw, resets_at: new Date(NOW + 72 * H).toISOString() }] }, (s) => s) }, "claude")).claude;
    expect([69.94, 69.96, 70, 99.96].map(claudeAt)).toEqual([4, 0, 0, 0]);
  });
});
