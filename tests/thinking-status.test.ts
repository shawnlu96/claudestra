import { describe, expect, test } from "bun:test";
import { parseThinkingStatus, StallTracker } from "../src/lib/thinking-status";

// 真机抓的样本（2026-07-26 temp 实测）
const PANE = `
端用户「web-ui」（HTTP API 接入，非 Discord）…
  Called claudestra
⏺ 已回复「好」。
✻ Sautéed for 7s
← claudestra · web-ui: [🌐 来自 Web
✢ Hatching… (7s · ↓ 130 tokens · thought for 1s)
                                   88% context used
──────────────────────────────────────────── temp ──
❯
`;

describe("parseThinkingStatus", () => {
  test("真机样本：耗时 + token + verb", () => {
    const st = parseThinkingStatus(PANE);
    expect(st).not.toBeNull();
    expect(st!.verb).toBe("Hatching");
    expect(st!.elapsedSec).toBe(7);
    expect(st!.elapsedRaw).toBe("7s");
    expect(st!.tokens).toBe(130);
  });

  test("思考深水区：effort 在场、无 token", () => {
    const st = parseThinkingStatus("✽ Hatching… (5s · thinking with xhigh effort)");
    expect(st!.effort).toBe("xhigh");
    expect(st!.tokens).toBeNull();
    expect(st!.elapsedSec).toBe(5);
  });

  test("k 后缀 token + 分钟级耗时", () => {
    const st = parseThinkingStatus("✻ Crunching… (3m 12s · ↓ 2.1k tokens · esc to interrupt)");
    expect(st!.tokens).toBe(2100);
    expect(st!.elapsedSec).toBe(192);
    expect(st!.elapsedRaw).toBe("3m 12s");
  });

  test("刚起步：无括号也认（全字段 null + verb）", () => {
    const st = parseThinkingStatus("✳ Hatching…");
    expect(st).not.toBeNull();
    expect(st!.verb).toBe("Hatching");
    expect(st!.elapsedSec).toBeNull();
    expect(st!.tokens).toBeNull();
  });

  test("完成态（Brewed for 9s，无省略号）不误认", () => {
    expect(parseThinkingStatus("✻ Brewed for 9s")).toBeNull();
    expect(parseThinkingStatus("✻ Crunched for 3m 29s")).toBeNull();
  });

  test("空闲 pane（无 spinner 行）→ null", () => {
    expect(parseThinkingStatus("❯ \n──────\n  ⏵⏵ bypass permissions on")).toBeNull();
  });

  test("自底向上取最下面的状态行（滚动残留的旧行不算）", () => {
    const pane = "✽ Percolating… (2s)\n中间输出若干\n✢ Hatching… (9s · ↓ 42 tokens)";
    const st = parseThinkingStatus(pane);
    expect(st!.elapsedSec).toBe(9);
    expect(st!.tokens).toBe(42);
  });

  test("小时级耗时", () => {
    const st = parseThinkingStatus("✻ Elaborating… (1h 2m 3s · ↓ 9.9k tokens)");
    expect(st!.elapsedSec).toBe(3723);
    expect(st!.tokens).toBe(9900);
  });
});

describe("StallTracker", () => {
  const S = (tokens: number | null) =>
    ({ elapsedSec: 1, elapsedRaw: "1s", tokens, effort: null, verb: "Hatching" });

  test("token 冻结满阈值 → 恰好报一次", () => {
    const t = new StallTracker(1000);
    expect(t.sample("a", S(100), 0)).toBe(false); // 建基线
    expect(t.sample("a", S(100), 500)).toBe(false); // 未满
    expect(t.sample("a", S(100), 1000)).toBe(true); // 满,报
    expect(t.sample("a", S(100), 2000)).toBe(false); // 已报过,不重复
    expect(t.frozenFor("a", 2000)).toBe(2000);
  });

  test("token 跳动 → 基线重置,不误报", () => {
    const t = new StallTracker(1000);
    t.sample("a", S(100), 0);
    expect(t.sample("a", S(150), 900)).toBe(false); // 涨了,重置
    expect(t.sample("a", S(150), 1500)).toBe(false); // 距重置只 600ms
    expect(t.sample("a", S(150), 1900)).toBe(true);
  });

  test("纯思考阶段（tokens null）不建基线——那归 wedge-watcher 管", () => {
    const t = new StallTracker(1000);
    expect(t.sample("a", S(null), 0)).toBe(false);
    expect(t.sample("a", S(null), 5000)).toBe(false);
    expect(t.frozenFor("a")).toBe(0);
  });

  test("回合结束（null 采样）清基线,下回合重新计", () => {
    const t = new StallTracker(1000);
    t.sample("a", S(100), 0);
    t.sample("a", null, 500); // 回合结束
    expect(t.sample("a", S(100), 600)).toBe(false); // 新基线
    expect(t.sample("a", S(100), 1500)).toBe(false); // 距新基线 900ms,未满
    expect(t.sample("a", S(100), 1700)).toBe(true);
  });

  test("多 agent 互不串", () => {
    const t = new StallTracker(1000);
    t.sample("a", S(100), 0);
    t.sample("b", S(100), 0);
    expect(t.sample("a", S(100), 1000)).toBe(true);
    expect(t.sample("b", S(200), 1000)).toBe(false); // b 在动
  });
});
