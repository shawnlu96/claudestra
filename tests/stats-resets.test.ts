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

// ── v2.17.2 TOCTOU recheck 反向判据(peer 二层定案:补全菜单自我否决,抓取 100% 失败)──
import { typedRecheckOk } from "../src/bridge/stats-dashboard.js";

describe("typedRecheckOk 敲入后二次确认", () => {
  // peer 实证:敲 /status 后补全菜单 11 行,❯ 被顶到倒数第 12 行
  const MENU_PANE = `some transcript
❯ /status
─────────────────────────────────────────
/status             Show Claude Code status
                    including version, model, a…
/statusline         Set up Claude Code's status
                    line UI
…elegram:configure  (telegram) Set up the
                    Telegram channel — save the…
/ide                Manage IDE integrations and
                    show status
/usage              Show session cost, plan
                    usage, and activity stats`;

  test("补全菜单在场(敲入的预期结果)→ 安全", () => {
    expect(typedRecheckOk(MENU_PANE, "/status")).toBe(true);
  });

  test("回合开始了(esc to interrupt)→ 撤退", () => {
    expect(typedRecheckOk(MENU_PANE + "\n✻ Cooking… esc to interrupt", "/status")).toBe(false);
  });

  test("输入行混入他人内容(用户半截输入)→ 撤退", () => {
    expect(typedRecheckOk("transcript\n❯ 帮我查一下/status\nmenu…", "/status")).toBe(false);
  });

  test("输入行带光标占位符 ▎ → 仍安全", () => {
    expect(typedRecheckOk("x\n❯ /status▎\nmenu", "/status")).toBe(true);
  });

  test("找不到输入行 → 保守撤退", () => {
    expect(typedRecheckOk("blank screen", "/status")).toBe(false);
  });

  test("transcript 里的旧 ❯ 行不干扰(取最后一条 ❯ 为输入行)", () => {
    expect(typedRecheckOk("❯ /model claude-opus-5\n⎿ Set model\n❯ /status\nmenu", "/status")).toBe(true);
  });
});

// ── v2.19.0 Rewind 对话框：不是我们的面板，不许当残留去 Esc ─────────────
// 2026-08-11 事故：CC 2.1.x 把「≤600ms 内连按两个 Esc」当 Rewind 手势，抓取
// 收尾的 350ms 间隔正好落在窗口里 → 窗口卡进 Rewind → pane 永远非 idle →
// 抓取换下一个窗口下手，一夜毒死 8 个 agent。Rewind 页脚也含「Esc to cancel」，
// 若当成遗留面板去清场，等于每轮补一发 Esc 把它开开关关。
import { isRewindDialog } from "../src/lib/tmux-helper.js";

const REWIND_PANE = [
  "  Rewind",
  "",
  "  Restore the code and/or conversation to the point before…",
  "",
  "    /compact",
  "    ⚠ No code restore",
  "",
  "  ❯ (current)",
  "",
  "  Enter to continue · Esc to cancel",
].join("\n");

describe("Rewind 对话框识别", () => {
  test("真机 pane → 认出是 Rewind", () => {
    expect(isRewindDialog(REWIND_PANE)).toBe(true);
  });

  test("Rewind 不算「遗留面板」——否则会被周期性补 Esc 反复开关", () => {
    expect(panelResidue(REWIND_PANE)).toBe(false);
  });

  test("Usage 面板照常算残留（护栏不能把真残留一起放走）", () => {
    expect(panelResidue("  Settings   Status   Config   Usage\n  Current session 12% used")).toBe(true);
  });

  test("正常对话界面不误判", () => {
    expect(isRewindDialog("⏺ 改完了\n❯ \n  ⏵⏵ bypass permissions on")).toBe(false);
  });

  test("对话里提到 Rewind 这个词不误判（要页脚+标题同时成立）", () => {
    expect(isRewindDialog("⏺ 我用 Rewind 回滚了一下,没问题\n❯ ")).toBe(false);
  });
});

// 双击护栏的时间常数：必须显著大于实测阈值（真机二分:≤600ms 必开,≥700ms 不开）
import { ESC_DOUBLE_TAP_MS } from "../src/lib/tmux-helper.js";

describe("Esc 双击护栏常数", () => {
  test("间隔下限对 700ms 实测阈值留足余量", () => {
    expect(ESC_DOUBLE_TAP_MS).toBeGreaterThanOrEqual(1200);
  });
});
