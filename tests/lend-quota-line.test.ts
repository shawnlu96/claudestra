/**
 * lib/lend-quota-line.ts（QLINE1）：两个家族各自 69/70/79/80/100 的边界、停线 = 0、提醒区间按 06:44 批准的缩法
 * （取整、单槽、0 仍 0、不超过原值、奇偶）、unknown 不收窄、freshness 按来源与真实观测时刻、observe / off、跨家族独立、重置后自动恢复。
 */
import { describe, expect, test } from "bun:test";
import { defaultQuotaLines, type QuotaLinesFile } from "../src/lib/lend-quota-line-config.js";
import { capSlots, familyLine, lendQuotaLineCap, lendQuotaLineSlots, limitFor, lineStateOf, warnSlots, type LineInputs } from "../src/lib/lend-quota-line.js";
import type { QuotaFacts } from "../src/lib/lend-quota-line-facts.js";

const NOW = Date.parse("2026-10-06T06:00:00Z");
const RESET = NOW + 3 * 86_400_000;
const fact = (pct: number, resetAt = RESET) => ({ weekUsedPct: pct, resetAt, observedAt: NOW - 1_000, source: "live" as const });
const inputs = (facts: QuotaFacts, file: QuotaLinesFile = defaultQuotaLines()): LineInputs => ({ lines: { status: "ok", file }, facts });

describe("边界（默认 70 / 80，>= 判）", () => {
  for (const family of ["codex", "claude"] as const) {
    // [用量, 状态, 4 槽 →, 5 槽 →, 1 槽 →]
    const cases: [number, string, number, number, number][] = [[69, "below", 4, 5, 1], [70, "warn", 2, 2, 1], [79, "warn", 2, 2, 1], [80, "stop", 0, 0, 0], [100, "stop", 0, 0, 0]];
    for (const [pct, state, s4, s5, s1] of cases) {
      test(`${family} ${pct}% → ${state}，4/5/1 槽 → ${s4}/${s5}/${s1}`, () => {
        const inp = inputs({ [family]: fact(pct) });
        expect(familyLine(family, inp, NOW).state).toBe(state as never);
        expect([4, 5, 1, 0].map((n) => lendQuotaLineCap(family, n, NOW, inp))).toEqual([s4, s5, s1, 0]);
      });
    }
  }
  test("提醒区间：limit = wouldLimit = half", () => {
    expect(familyLine("codex", inputs({ codex: fact(75) }), NOW)).toMatchObject({ state: "warn", limit: "half", wouldLimit: "half" });
  });
});

describe("提醒区间缩法（监工 06:44 批准）", () => {
  test("取整：0→0 1→1 2→1 3→1 4→2 5→2 9→4", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(warnSlots)).toEqual([0, 1, 1, 1, 2, 2, 4]);
  });
  test("warn → half；单槽保持 1，原 0 仍 0", () => {
    expect(limitFor("warn", "on")).toBe("half");
    expect(limitFor("warn", "observe")).toBe("none");
    expect(capSlots("half", 1)).toBe(1);
    expect(capSlots("half", 0)).toBe(0);
    expect(capSlots("half", 6)).toBe(3);
  });
  test("只收窄不放大：负数 / 小数按 0 / 向下取整", () => {
    expect(capSlots("none", -2)).toBe(0);
    expect(capSlots("none", 2.7)).toBe(2);
    for (const n of [0, 1, 2, 3, 7]) for (const l of ["none", "half", "zero"] as const) expect(capSlots(l, n)).toBeLessThanOrEqual(n);
  });
});

describe("unknown / 模式 / 自定义线", () => {
  test("没有读数 = unknown，不收窄（交回 QP1 原处理），不伪造低用量", () => {
    const v = familyLine("codex", inputs({}), NOW);
    expect(v).toMatchObject({ state: "unknown", weekUsedPct: null, resetAt: null, limit: "none" });
    expect(lineStateOf(null, { warnPct: 70, stopPct: 80 })).toBe("unknown");
  });
  test("resetAt 已过的旧读数不当数：unknown", () => {
    expect(familyLine("codex", inputs({ codex: fact(95, NOW) }), NOW).state).toBe("unknown");
    expect(lendQuotaLineCap("codex", 3, NOW, inputs({ codex: fact(95, NOW - 1) }))).toBe(3);
  });
  test("重置后读到新窗口低用量：自动恢复，无需按钮", () => {
    expect(lendQuotaLineCap("codex", 3, NOW, inputs({ codex: fact(90) }))).toBe(0);
    const later = RESET + 60_000;
    expect(lendQuotaLineCap("codex", 3, later, inputs({ codex: { weekUsedPct: 2, resetAt: later + 7 * 86_400_000, observedAt: later, source: "live" } }))).toBe(3);
  });
  test("freshness 按来源与真实观测时刻：live_stale 或观测超过 15 分钟 = last_known，仍按本代读数判（不当 0%）", () => {
    const old = { weekUsedPct: 85, resetAt: RESET, observedAt: NOW - 16 * 60_000, source: "live" as const };
    expect(familyLine("codex", inputs({ codex: old }), NOW)).toMatchObject({ freshness: "last_known", state: "stop", limit: "zero", observedAt: old.observedAt, source: "live" });
    expect(familyLine("codex", inputs({ codex: { ...fact(85), source: "live_stale" } }), NOW)).toMatchObject({ freshness: "last_known", state: "stop" });
    expect(familyLine("codex", inputs({ codex: fact(85) }), NOW).freshness).toBe("fresh");
    expect(familyLine("codex", inputs({ codex: { ...fact(85), source: "local_cache" } }), NOW).freshness).toBe("fresh");
    expect(familyLine("codex", inputs({}), NOW)).toMatchObject({ freshness: null, observedAt: null, source: null });
  });
  test("observe 只报告、off 不收窄", () => {
    const f = defaultQuotaLines();
    for (const mode of ["observe", "off"] as const) {
      const v = familyLine("claude", inputs({ claude: fact(90) }, { ...f, mode }), NOW);
      expect(v).toMatchObject({ state: "stop", mode, limit: "none", wouldLimit: "zero" });
      expect(lendQuotaLineCap("claude", 2, NOW, inputs({ claude: fact(90) }, { ...f, mode }))).toBe(2);
    }
  });
  test("自定义线：codex 50/60 时 60 停、claude 仍按 70/80", () => {
    const file = { ...defaultQuotaLines(), families: { codex: { warnPct: 50, stopPct: 60 }, claude: { warnPct: 70, stopPct: 80 } } };
    const inp = inputs({ codex: fact(60), claude: fact(60) }, file);
    expect(lendQuotaLineCap("codex", 2, NOW, inp)).toBe(0);
    expect(lendQuotaLineCap("claude", 2, NOW, inp)).toBe(2);
  });
});

describe("跨家族独立 / hello slots", () => {
  test("codex 停接不影响 claude 的容量；busy 照实报", () => {
    const s = lendQuotaLineSlots({ codex: { total: 3, busy: 2 }, claude: { total: 2, busy: 1 } }, NOW, inputs({ codex: fact(85), claude: fact(10) }));
    expect(s).toEqual({ codex: { total: 0, busy: 2 }, claude: { total: 2, busy: 1 } });
  });
  test("claude 停接不影响 codex", () => {
    const s = lendQuotaLineSlots({ codex: { total: 3, busy: 0 }, claude: { total: 2, busy: 2 } }, NOW, inputs({ codex: fact(69), claude: fact(80) }));
    expect(s).toEqual({ codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 2 } });
  });
  test("提醒区间忙槽：4 槽忙 3 → total 2、busy 照实 3（不撤单，借入方按 busy >= total 不再派）", () => {
    const s = lendQuotaLineSlots({ codex: { total: 4, busy: 3 }, claude: { total: 2, busy: 0 } }, NOW, inputs({ codex: fact(75), claude: fact(10) }));
    expect(s).toEqual({ codex: { total: 2, busy: 3 }, claude: { total: 2, busy: 0 } });
  });
  test("原有效容量已是 0（暂停 / 收回 / 过期）：本规则不恢复", () => {
    expect(lendQuotaLineCap("codex", 0, NOW, inputs({ codex: fact(1) }))).toBe(0);
    expect(lendQuotaLineSlots({ codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } }, NOW, inputs({}))).toEqual({ codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } });
  });
  test("不认识的家族原样返回", () => {
    expect(lendQuotaLineCap("pi", 5, NOW, inputs({ codex: fact(99) }))).toBe(5);
  });
});
