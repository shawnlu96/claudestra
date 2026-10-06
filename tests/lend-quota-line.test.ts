/**
 * lib/lend-quota-line.ts（QLINE1）：两个家族各自 69/70/79/80/100 的边界、停线 = 0、提醒区间未批不收窄、
 * 批准后的缩法（取整、单槽、0 仍 0、不超过原值）、unknown 不收窄、observe / off、跨家族独立、重置后自动恢复。
 */
import { describe, expect, test } from "bun:test";
import { defaultQuotaLines, type QuotaLinesFile } from "../src/lib/lend-quota-line-config.js";
import { capSlots, familyLine, lendQuotaLineCap, lendQuotaLineSlots, limitFor, lineStateOf, warnSlots, WARN_ZONE_APPROVED, type LineInputs } from "../src/lib/lend-quota-line.js";
import type { QuotaFacts } from "../src/lib/lend-quota-line-facts.js";

const NOW = Date.parse("2026-10-06T06:00:00Z");
const RESET = NOW + 3 * 86_400_000;
const fact = (pct: number, resetAt = RESET) => ({ weekUsedPct: pct, resetAt, readAt: NOW - 1_000 });
const inputs = (facts: QuotaFacts, file: QuotaLinesFile = defaultQuotaLines()): LineInputs => ({ lines: { status: "ok", file }, facts });

describe("边界（默认 70 / 80，>= 判）", () => {
  for (const family of ["codex", "claude"] as const) {
    const cases: [number, string, number][] = [[69, "below", 4], [70, "warn", 4], [79, "warn", 4], [80, "stop", 0], [100, "stop", 0]];
    for (const [pct, state, slots] of cases) {
      test(`${family} ${pct}% → ${state}，4 槽 → ${slots}（提醒区间未批不收窄）`, () => {
        const v = familyLine(family, inputs({ [family]: fact(pct) }), NOW);
        expect(v.state).toBe(state as never);
        expect(lendQuotaLineCap(family, 4, NOW, inputs({ [family]: fact(pct) }))).toBe(slots);
      });
    }
  }
  test("未批准常量为 false：提醒区间只报 warn，wouldLimit 也是 none", () => {
    expect(WARN_ZONE_APPROVED).toBe(false);
    expect(familyLine("codex", inputs({ codex: fact(75) }), NOW)).toMatchObject({ state: "warn", limit: "none", wouldLimit: "none" });
  });
});

describe("提醒区间缩法（候选，批准后启用）", () => {
  test("取整：0→0 1→1 2→1 3→1 4→2 5→2 9→4", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(warnSlots)).toEqual([0, 1, 1, 1, 2, 2, 4]);
  });
  test("批准后 warn → half；单槽保持 1，原 0 仍 0", () => {
    expect(limitFor("warn", "on", true)).toBe("half");
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
    expect(lendQuotaLineCap("codex", 3, later, inputs({ codex: { weekUsedPct: 2, resetAt: later + 7 * 86_400_000, readAt: later } }))).toBe(3);
  });
  test("读数超过两个刷新周期：标 last_known，仍按本代读数判（不当 0%）", () => {
    const old = { weekUsedPct: 85, resetAt: RESET, readAt: NOW - 10 * 60_000 };
    expect(familyLine("codex", inputs({ codex: old }), NOW)).toMatchObject({ freshness: "last_known", state: "stop", limit: "zero" });
    expect(familyLine("codex", inputs({ codex: fact(85) }), NOW).freshness).toBe("fresh");
    expect(familyLine("codex", inputs({}), NOW).freshness).toBeNull();
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
    const s = lendQuotaLineSlots({ codex: { total: 3, busy: 0 }, claude: { total: 2, busy: 2 } }, NOW, inputs({ codex: fact(79), claude: fact(80) }));
    expect(s).toEqual({ codex: { total: 3, busy: 0 }, claude: { total: 0, busy: 2 } });
  });
  test("原有效容量已是 0（暂停 / 收回 / 过期）：本规则不恢复", () => {
    expect(lendQuotaLineCap("codex", 0, NOW, inputs({ codex: fact(1) }))).toBe(0);
    expect(lendQuotaLineSlots({ codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } }, NOW, inputs({}))).toEqual({ codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } });
  });
  test("不认识的家族原样返回", () => {
    expect(lendQuotaLineCap("pi", 5, NOW, inputs({ codex: fact(99) }))).toBe(5);
  });
});
