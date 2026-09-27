/**
 * Codex 用量（lib/codex-usage.ts）：token_count 累计值做差、rate_limits 解析、最近一次额度观测。
 * 全部用临时目录造假 rollout，不读真实 ~/.codex。
 */

import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileStats } from "../src/lib/agent-stats.js";
import {
  codexTokenDelta,
  findLatestCodexQuota,
  lastRateLimitEvent,
  parseCodexRateLimits,
  scanCodexStatsWindow,
  toCodexQuota,
} from "../src/lib/codex-usage.js";
import { resetPassed } from "../src/lib/usage-cache.js";

const SID = "01a0d336-6344-73d2-8b1d-a3d9399182b3";
const T0 = Date.parse("2026-09-28T01:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function meta(cwd = "/work/demo", sid = SID) {
  return { timestamp: iso(T0), type: "session_meta", payload: { id: sid, session_id: sid, cwd, base_instructions: "x".repeat(40) } };
}
function turnContext(ms: number, model: string) {
  return { timestamp: iso(ms), type: "turn_context", payload: { model, effort: "high" } };
}
function tokenCount(ms: number, total: number, last: number, rl: object | null = RL) {
  return {
    timestamp: iso(ms),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total - 10, cached_input_tokens: 0, output_tokens: 10, total_tokens: total },
        last_token_usage: { input_tokens: last - 10, cached_input_tokens: 0, output_tokens: 10, total_tokens: last },
        model_context_window: 258400,
      },
      rate_limits: rl,
    },
  };
}
const RL = {
  limit_id: "codex",
  primary: { used_percent: 87.0, window_minutes: 300, resets_at: 1790523470 },
  secondary: { used_percent: 15.0, window_minutes: 10080, resets_at: 1791047875 },
  credits: { has_credits: false, unlimited: false, balance: "0" },
  plan_type: "plus",
  rate_limit_reached_type: null,
};
const lines = (recs: object[]) => recs.map((r) => JSON.stringify(r));

describe("codexTokenDelta：累计计数器做差", () => {
  test("正常递增取差", () => expect(codexTokenDelta(100, 150, 50)).toBe(50));
  test("同一累计值重复落盘算 0（last 不同也一样：compact 后的重报）", () => {
    expect(codexTokenDelta(150, 150, 50)).toBe(0);
    expect(codexTokenDelta(150, 150, 32)).toBe(0);
  });
  test("计数器重开（total 等于 last）：这一条就是全部——即使比上一条大", () => {
    expect(codexTokenDelta(18218, 18273, 18273)).toBe(18273);
    expect(codexTokenDelta(58835, 20697, 20697)).toBe(20697);
  });
  test("截断：没有上一条、又不是新计数器 → null（只当基线）", () => {
    expect(codexTokenDelta(null, 500, 100)).toBeNull();
    expect(codexTokenDelta(null, 100, 100)).toBe(100);
  });
  test("累计值变小但重开那条丢了 → 取当前值", () => expect(codexTokenDelta(900, 300, 120)).toBe(300));
});

describe("scanCodexStatsWindow", () => {
  const DAY = 86400_000;
  const dayTs = T0 - 1000;
  const weekTs = T0 - 3 * DAY;

  test("从文件头扫：重开、重复、上一天都分对", () => {
    const recs = [
      meta(),
      turnContext(T0 - DAY, "gpt-old"),
      tokenCount(T0 - DAY, 100, 100), // 周内、今日前
      tokenCount(T0 - DAY + 5, 150, 50),
      turnContext(T0, "gpt-6"),
      tokenCount(T0, 30, 30), // 新进程：计数器重开
      tokenCount(T0 + 1, 30, 30), // 重复落盘
      tokenCount(T0 + 2, 70, 40),
    ];
    const { stats, oldestTs } = scanCodexStatsWindow(lines(recs), dayTs, weekTs, true);
    expect(stats.week.tokens).toBe(100 + 50 + 30 + 40);
    expect(stats.week.requests).toBe(4);
    expect(stats.today.tokens).toBe(70);
    expect(stats.today.requests).toBe(2);
    expect(stats.model).toBe("gpt-6");
    expect(stats.contextTokens).toBe(40);
    expect(stats.contextWindow).toBe(258400);
    expect(stats.week.costUsd).toBe(0); // 没有牌价，不虚报
    expect(oldestTs).toBe(T0 - DAY);
  });

  test("窗口从半截开始：首行半截 JSON 丢掉，第一条只当基线", () => {
    const body = lines([tokenCount(T0, 500, 100), tokenCount(T0 + 1, 600, 100)]);
    const truncated = ['_tokens":42}}}', ...body];
    const { stats } = scanCodexStatsWindow(truncated, dayTs, weekTs, false);
    expect(stats.week.tokens).toBe(100);
    expect(stats.week.requests).toBe(1);
  });

  test("info 为 null（只有限流信息）的 token_count 跳过；周界之前的不计", () => {
    const onlyRl = { timestamp: iso(T0), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: RL } };
    const recs = [tokenCount(weekTs - DAY, 100, 100), onlyRl, tokenCount(T0, 160, 60)];
    const { stats, oldestTs } = scanCodexStatsWindow(lines(recs), dayTs, weekTs, true);
    expect(stats.week.tokens).toBe(60);
    expect(oldestTs).toBe(weekTs - DAY); // 已越过周界 → readFileStats 不用再扩窗
  });

  test("有 token_usage_record 的请求按它计：计数器重开那条丢了也不少算；紧跟的 token_count 不重复计", () => {
    const rec = (ms: number, n: number) => ({ timestamp: iso(ms), type: "token_usage_record", payload: { usage: { input_tokens: n - 5, output_tokens: 5, total_tokens: n } } });
    const recs = [
      tokenCount(T0, 100, 100), // 老版本写的：没有 record，按做差
      rec(T0 + 1, 50), tokenCount(T0 + 1, 150, 50),
      rec(T0 + 2, 80), tokenCount(T0 + 2, 120, 80), // 计数器重开（丢了重开那条）：做差只能拿 120，record 给准数 80
      tokenCount(T0 + 3, 120, 80), // 重复落盘：没有 record，做差 0
      rec(T0 + 4, 40), tokenCount(T0 + 4, 160, 40),
    ];
    const { stats } = scanCodexStatsWindow(lines(recs), dayTs, weekTs, true);
    expect(stats.week.tokens).toBe(100 + 50 + 80 + 40);
    expect(stats.week.requests).toBe(4);
    expect(stats.today.tokens).toBe(270);
    expect(stats.contextTokens).toBe(40);
  });

  test("接进 readFileStats：首行 session_meta 认出 Codex；小窗口扩窗后与全读一致", async () => {
    const now = Date.now();
    const recs: object[] = [meta(), turnContext(now, "gpt-6")];
    for (let i = 0; i < 20; i++) recs.push(tokenCount(now - 20 + i, 1000 * (i + 1), 1000));
    const mk = () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-usage-stats-"));
      const p = join(dir, `rollout-2026-09-28T01-00-00-${SID}.jsonl`);
      writeFileSync(p, lines(recs).join("\n") + "\n");
      return p;
    };
    const full = await readFileStats(mk(), { tailStartBytes: 1 << 30 });
    const tail = await readFileStats(mk(), { tailStartBytes: 200 });
    expect(full.today.tokens).toBe(20_000);
    expect(full.today.requests).toBe(20);
    expect(tail.today).toEqual(full.today);
    expect(full.model).toBe("gpt-6");
    expect(full.contextTokens).toBe(1000);
  });
});

describe("parseCodexRateLimits", () => {
  const BEFORE = 1790523470_000 - 60_000;

  test("完整样本：5h / 7d 两个窗口、plan、credits", () => {
    const r = parseCodexRateLimits(RL, BEFORE)!;
    expect(r.plan).toBe("plus");
    expect(r.windows.map((w) => [w.id, w.pct, w.windowMinutes, w.resetPassed])).toEqual([
      ["5h", 87, 300, false],
      ["7d", 15, 10080, false],
    ]);
    expect(r.windows[0].resetsAtMs).toBe(1790523470_000);
    expect(r.windows[0].resets).not.toBe("");
    expect(r.credits).toEqual({ hasCredits: false, unlimited: false, balance: "0" });
    expect(r.limitReached).toBeNull();
  });

  test("过了 resets_at：标 resetPassed，但不把百分比改成 0（前端显示「待刷新」）", () => {
    const r = parseCodexRateLimits(RL, 1790523470_000 + 1)!;
    expect(r.windows[0].resetPassed).toBe(true);
    expect(r.windows[0].pct).toBe(87);
    expect(r.windows[1].resetPassed).toBe(false);
    expect(resetPassed(null, Date.now())).toBe(false); // 时刻未知 = 判不出，按没过
  });

  test("字段缺失容忍：没 secondary / plan / credits / window_minutes 也能出卡", () => {
    const r = parseCodexRateLimits({ primary: { used_percent: 140 } }, BEFORE)!;
    expect(r.windows).toEqual([
      { id: "primary", windowMinutes: null, pct: 100, resets: "", resetsAtMs: null, resetPassed: false },
    ]);
    expect(r.plan).toBeNull();
    expect(r.credits).toBeNull();
  });

  test("一个窗口都拿不到 / 不是对象 → null", () => {
    expect(parseCodexRateLimits({ primary: {}, secondary: "x" }, BEFORE)).toBeNull();
    expect(parseCodexRateLimits(null, BEFORE)).toBeNull();
    expect(parseCodexRateLimits("codex", BEFORE)).toBeNull();
  });

  test("未知窗口长度按分钟命名（30 天 → 30d）", () => {
    const r = parseCodexRateLimits({ primary: { used_percent: 1, window_minutes: 43200 } }, BEFORE)!;
    expect(r.windows[0].id).toBe("30d");
  });
});

describe("lastRateLimitEvent", () => {
  test("倒着找最后一条带 rate_limits 的 token_count，坏行跳过", () => {
    const later = { ...RL, primary: { ...RL.primary, used_percent: 90 } };
    const ls = [...lines([tokenCount(T0, 10, 10), tokenCount(T0 + 5, 20, 10, later)]), '{"type":"event_msg","payload":{"rate_limits"'];
    const hit = lastRateLimitEvent(ls)!;
    expect(hit.observedAt).toBe(T0 + 5);
    expect(hit.rateLimits.primary.used_percent).toBe(90);
  });
  test("没有观测 → null", () => {
    expect(lastRateLimitEvent(lines([meta(), tokenCount(T0, 10, 10, null)]))).toBeNull();
  });
});

describe("findLatestCodexQuota / toCodexQuota", () => {
  function rollout(root: string, day: string, sid: string, recs: object[], mtimeMs: number): string {
    const dir = join(root, ...day.split("/"));
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `rollout-${day.replace(/\//g, "-")}T01-00-00-${sid}.jsonl`);
    writeFileSync(p, lines(recs).join("\n") + "\n");
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  }
  const SID2 = "01a0ca8c-da9a-7742-a2b8-429bc956a7a0";

  test("取观测时间最新的那条，带上会话 id 与 cwd；老目录里被续写的会话也能找到", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-root-"));
    const newer = { ...RL, primary: { ...RL.primary, used_percent: 55 } };
    // 老日期目录里的会话被 resume 续写（mtime 最新）——不能按目录日期找
    const resumed = rollout(root, "2026/09/24", SID, [meta("/work/old"), tokenCount(T0 + 60_000, 50, 50, newer)], T0 + 61_000);
    rollout(root, "2026/09/27", SID2, [meta("/work/new", SID2), tokenCount(T0, 10, 10)], T0 + 1000);
    const raw = (await findLatestCodexQuota(root))!;
    expect(raw.path).toBe(resumed);
    expect(raw.sessionId).toBe(SID);
    expect(raw.cwd).toBe("/work/old");
    const q = toCodexQuota(raw, [{ name: "agent-codex", jsonl: resumed }], T0)!;
    expect(q.agent).toBe("agent-codex");
    expect(q.windows[0].pct).toBe(55);
    expect(q.observedAt).toBe(T0 + 60_000);
    expect(q.source).toBe("codex-rollout");
  });

  test("最新文件还没请求过（没有 token_count）→ 往前找上一个会话", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-usage-root-"));
    rollout(root, "2026/09/28", SID, [meta()], T0 + 5000);
    rollout(root, "2026/09/27", SID2, [meta("/work/b", SID2), tokenCount(T0, 10, 10)], T0 + 1000);
    const raw = (await findLatestCodexQuota(root))!;
    expect(raw.sessionId).toBe(SID2);
    expect(toCodexQuota(raw, [], T0)!.agent).toBeNull();
  });

  test("没有 rollout 的机器 → null（前端不显示 Codex 卡）", async () => {
    expect(await findLatestCodexQuota(join(tmpdir(), "no-such-codex-root-xyz"))).toBeNull();
    expect(await findLatestCodexQuota(mkdtempSync(join(tmpdir(), "codex-usage-empty-")))).toBeNull();
  });
});
