/**
 * v2.9.1+ sessionResetSuspect 单测 —— 5h reset 超出窗口约束时标可疑（只标记
 * 不纠正；上游 /status 面板实测过把 5pm 印成 5am）。
 * scrapedAt 用本地时区构造，任何时区跑测试结论一致。
 */

import { describe, test, expect } from "bun:test";
import { sessionResetSuspect } from "../src/bridge/stats-dashboard.js";

/** 今天本地 hh:mm 的时间戳 */
function at(h: number, m = 0): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

describe("sessionResetSuspect", () => {
  test("实测案例：下午 14:38 显示 5am（明天凌晨，14h+ 后）→ 可疑", () => {
    expect(sessionResetSuspect("5am (Asia/Tokyo)", at(14, 38))).toBe(true);
  });

  test("合理值：14:38 显示 5pm（2.4h 后）→ 正常", () => {
    expect(sessionResetSuspect("5pm (Asia/Tokyo)", at(14, 38))).toBe(false);
  });

  test("12am/12pm 边界：23:00 显示 12am（1h 后）正常，12pm（13h 后）可疑", () => {
    expect(sessionResetSuspect("12am (Asia/Tokyo)", at(23, 0))).toBe(false);
    expect(sessionResetSuspect("12pm (Asia/Tokyo)", at(23, 0))).toBe(true);
  });

  test("解析不了的格式（周 reset 等）不标", () => {
    expect(sessionResetSuspect("Jul 15 at 6am (Asia/Tokyo)", at(14, 0))).toBe(false);
    expect(sessionResetSuspect("", at(14, 0))).toBe(false);
  });
});

// ── v2.17.2 panelResidue 回归(peer 报告:回执文本毒死全部候选窗,停摆 6 天)──
import { panelResidue } from "../src/bridge/stats-dashboard.js";

describe("panelResidue 只认「面板开着」", () => {
  test("抓取回执 ⎿ Settings dialog dismissed → 不算残留(自锁根因)", () => {
    expect(panelResidue("⏺ 查完了\n  ⎿  Settings dialog dismissed\n\n❯ ")).toBe(false);
  });

  test("transcript 引用面板内容(bug 报告贴用量数字)→ 不算残留", () => {
    expect(panelResidue("对方看板显示 Current session 100% used,但 TUI 是 0%\n❯ ")).toBe(false);
  });

  test("开着的 settings 对话框(无 dismissed 后缀)→ 残留", () => {
    expect(panelResidue(" Settings dialog\n  Theme: dark\n")).toBe(true);
  });

  test("开着的 /status 面板(tab 栏在屏)→ 残留", () => {
    expect(panelResidue(" Settings  Status  Config  Usage\n Current session: 19% used\n")).toBe(true);
  });

  test("Esc to cancel(开启态独有 footer)→ 残留", () => {
    expect(panelResidue("some dialog\nEsc to cancel\n")).toBe(true);
  });

  test("干净 idle pane → 无残留", () => {
    expect(panelResidue("⏺ done\n\n❯ \n  ⏵⏵ bypass permissions on\n")).toBe(false);
  });
});
