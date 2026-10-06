/**
 * web/features/lend/lend-quota-model.ts（QLINE1）：表单即时校验（整数 0..100、提醒低于停）、提交体只带一族、
 * 状态徽标只看 bridge 判好的 state / limit（不按百分比猜）、unknown 显示「未知」而不是 0%、实际可接读不到显示「未知」、
 * bridge 固定错误码 → 文案（不显示原始错误）。
 */
import { describe, expect, test } from "bun:test";
import {
  barWidth, configErrorText, draftOf, draftProblem, isDirty, lineBody, slotsText, stateBadge, usedText, warningText, type FamilyLine,
} from "../web/features/lend/lend-quota-model";

const f = (over: Partial<FamilyLine> = {}): FamilyLine => ({ family: "codex", warnPct: 70, stopPct: 80, weekUsedPct: 50, resetAt: 1, observedAt: 1, source: "live",
  freshness: "fresh", state: "below", mode: "on", limit: "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2, ...over });

describe("表单", () => {
  test("合法：0/1、70/80、99/100", () => {
    for (const [w, s] of [["0", "1"], ["70", "80"], ["99", "100"], [" 5 ", "6"]]) expect(draftProblem({ warn: w, stop: s })).toBeNull();
  });
  test("非法：空、小数、负数、101、字母、提醒 >= 停", () => {
    for (const [w, s] of [["", "80"], ["70.5", "80"], ["-1", "80"], ["70", "101"], ["x", "80"], ["80", "80"], ["90", "80"]]) {
      expect(draftProblem({ warn: w, stop: s })).not.toBeNull();
    }
  });
  test("提交体只带这一族的两条线（数字）", () => {
    expect(lineBody("claude", { warn: " 60", stop: "75 " })).toEqual({ family: "claude", warnPct: 60, stopPct: 75 });
  });
  test("draftOf / isDirty", () => {
    expect(draftOf(f())).toEqual({ warn: "70", stop: "80" });
    expect(isDirty(f(), { warn: "70", stop: "80" })).toBe(false);
    expect(isDirty(f(), { warn: "60", stop: "80" })).toBe(true);
  });
});

describe("显示", () => {
  test("停接只看 state + limit：stop + zero = 已停接；observe 下 stop = 未执行", () => {
    expect(stateBadge(f({ state: "stop", limit: "zero" }))).toEqual({ text: "已停接", tone: "error" });
    expect(stateBadge(f({ state: "stop", limit: "none", mode: "observe" })).text).toBe("超过停接线（未执行）");
    expect(stateBadge(f({ state: "warn" })).text).toBe("提醒");
    expect(stateBadge(f({ state: "warn", limit: "half" })).text).toBe("提醒 · 已缩减");
    expect(stateBadge(f({ state: "below", weekUsedPct: 95 })).text).toBe("正常"); // 百分比高但服务端说 below：不自己猜
  });
  test("unknown：显示「未知」，不画条，不当 0%", () => {
    const u = f({ state: "unknown", weekUsedPct: null, freshness: null });
    expect(usedText(u)).toBe("未知");
    expect(barWidth(u)).toBeNull();
    expect(stateBadge(u)).toEqual({ text: "用量未知", tone: "muted" });
    expect(usedText(f({ weekUsedPct: 0 }))).toBe("0%");
  });
});

describe("实际可接 / 固定错误码", () => {
  test("slots null = 未知（不当 0 也不当满）；0 照实", () => {
    expect(slotsText(f({ slots: null }))).toBe("未知");
    expect(slotsText(f({ slots: 0 }))).toBe("0");
  });
  test("config 错误码与 warning 码 → 固定文案；正常为 null", () => {
    expect(configErrorText({ status: "invalid", error: "config_unreadable", mode: "on" })).toContain("读不了");
    expect(configErrorText({ status: "invalid", error: "config_invalid", mode: "on" })).toContain("内容不合法");
    expect(configErrorText({ status: "ok", error: null, mode: "on" })).toBeNull();
    expect(warningText("replaced_invalid")).toContain("已另存");
    expect(warningText(undefined)).toBeNull();
  });
});
