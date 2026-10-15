/**
 * QWD-1：Claude 的周重置时刻每次观测都带几百毫秒抖动（生产 lend-quota-line-facts.json 连续三次 live 观测：
 * 1792418399564 / 1792418399963 / 1792418400347），旧逻辑按字符串全等比世代，每次新观测都把关掉记录作废、提醒条又弹。
 * 走横幅同一顺序：关掉 → 每次轮询 observeDismissed → isDismissed。
 */
import { describe, expect, test } from "bun:test";
import type { FamilyLine, QuotaLinesView } from "../web/features/lend/lend-quota-model";
import { isDismissed, observeDismissed, parseDismissed, sameGen, warningItems, withDismissed, type DismissMap } from "../web/features/lend/quota-warning-model";

const NOW = 1792058526130;
const SEEN = [1792418399564, 1792418399963, 1792418400347];
const f = (over: Partial<FamilyLine> = {}): FamilyLine => ({ family: "claude", warnPct: 90, stopPct: 99, weekUsedPct: 95, resetAt: SEEN[0]!, observedAt: NOW,
  source: "live", freshness: "fresh", state: "warn", mode: "on", limit: "half", wouldLimit: "half", granted: 2, lineCap: 2, available: 1, slots: 1, ...over });
const view = (fl: FamilyLine, mode: "on" | "observe" | "off" = "on"): QuotaLinesView => ({ ok: true, config: { status: "ok", error: null, mode }, at: NOW, families: [fl] });

/** 一次轮询：observe 推进失效（经 localStorage 往返）后，这次回包里的提醒还显示不显示 */
function poll(m: DismissMap, fl: FamilyLine, mode: "on" | "observe" = "on", at = NOW): { m: DismissMap; shown: boolean } {
  const next = parseDismissed(JSON.stringify(observeDismissed(m, "fp1", view(fl, mode), at)));
  const it = warningItems(view(fl, mode), at)[0];
  return { m: next, shown: !!it && !isDismissed(next, "fp1", it) };
}

describe("同一周 resetAt 抖动不算新一代", () => {
  const closed = withDismissed({}, "fp1", warningItems(view(f()), NOW)[0]!, NOW);
  test("生产实测的三次读数轮流出现：关掉后都不再弹", () => {
    let m = closed;
    for (const resetAt of [...SEEN, SEEN[0]!, SEEN[2]!]) {
      const r = poll(m, f({ resetAt }));
      expect(r.shown).toBe(false);
      m = r.m;
    }
  });
  test("差几百毫秒、几秒、几分钟内：不再弹（跨分钟边界也一样）", () => {
    for (const d of [-400, 383, 999, 3_000, -7_000, 4 * 60_000]) expect(poll(closed, f({ resetAt: SEEN[0]! + d })).shown).toBe(false);
  });
  test("抖动观测之后再看原值：记录没被抖动推走", () => {
    const a = poll(closed, f({ resetAt: SEEN[2]! })).m;
    expect(poll(a, f({ resetAt: SEEN[0]! })).shown).toBe(false);
  });
});

describe("真换代仍再弹（抖动观测之后也是）", () => {
  const jittered = poll(withDismissed({}, "fp1", warningItems(view(f()), NOW)[0]!, NOW), f({ resetAt: SEEN[1]! })).m;
  test("新的一周（resetAt 差一天以上）", () => {
    expect(poll(jittered, f({ resetAt: SEEN[0]! + 7 * 86_400_000 })).shown).toBe(true);
    expect(poll(jittered, f({ resetAt: SEEN[0]! + 86_400_000 + 1 })).shown).toBe(true);
  });
  test("改线、改模式、提醒 → 停接", () => {
    expect(poll(jittered, f({ resetAt: SEEN[2]!, warnPct: 80 })).shown).toBe(true);
    expect(poll(jittered, f({ resetAt: SEEN[2]!, limit: "none", wouldLimit: "half" }), "observe").shown).toBe(true);
    expect(poll(jittered, f({ resetAt: SEEN[2]!, weekUsedPct: 99, state: "stop", limit: "zero", wouldLimit: "zero" })).shown).toBe(true);
  });
});

describe("sameGen", () => {
  test("线 / 模式必须全等，resetAt 只在两边都是数字时容差", () => {
    expect(sameGen("1000|90/99|on", "1300|90/99|on")).toBe(true);
    expect(sameGen("1000|90/99|on", "1000|80/99|on")).toBe(false);
    expect(sameGen("1000|90/99|on", "1000|90/99|observe")).toBe(false);
    expect(sameGen("noreset|90/99|on", "noreset|90/99|on")).toBe(true);
    expect(sameGen("noreset|90/99|on", "0|90/99|on")).toBe(false);
    expect(sameGen("|90/99|on", "0|90/99|on")).toBe(false);
    expect(sameGen("0|90/99|on", String(5 * 60_000 + 1) + "|90/99|on")).toBe(false);
  });
});
