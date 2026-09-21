/**
 * Pi 对话框的 pane 解析（owner 2026-09-21：「pi 里面有些选项没办法发到
 * Claudestra 里面做选择」）。
 *
 * 复现样本按截图逐字抄：权限守门扩展用 ctx.ui.confirm 弹的框。
 */
import { describe, test, expect } from "bun:test";
import { parseAuqPane, parsePiSelectPane } from "../src/lib/auq-pane.js";

const PI_CONFIRM = [
  " ! sandbox-unavailable pi-lens: bubblewrap and prlimit are required",
  "",
  " 工具守门: rm-rf-relative",
  " rm -rf 相对路径，需确认",
  "",
  " 仍要执行吗？",
  "",
  " → Yes",
  "   No",
  "",
  " ↑↓ navigate   enter select   escape/ctrl+c cancel",
  "",
].join("\n");

const CC_PERMISSION = [
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again",
  "   3. No",
  "",
].join("\n");

describe("parsePiSelectPane", () => {
  test("确认框 → 单问题单选，光标在第一项", () => {
    const p = parsePiSelectPane(PI_CONFIRM);
    expect(p).not.toBeNull();
    expect(p!.form).toBe("single");
    expect(p!.multiSelect).toBe(false);
    expect(p!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(p!.options[0].cursor).toBe(true);
    expect(p!.options[1].cursor).toBe(false);
    // 标题块 + 问题块都要进来，否则卡片上只剩「仍要执行吗？」看不出在问什么
    expect(p!.question).toContain("rm-rf-relative");
    expect(p!.question).toContain("仍要执行吗");
  });

  test("光标不在第一项 → 如实报告（键序列靠它算相对步数）", () => {
    const p = parsePiSelectPane(PI_CONFIRM.replace(" → Yes", "   Yes").replace("   No", " → No"));
    expect(p!.options[1].cursor).toBe(true);
  });

  test("parseAuqPane 也认（下游三个消费点一个字不用改）", () => {
    expect(parseAuqPane(PI_CONFIRM)?.options.length).toBe(2);
  });

  test("没有 footer 的普通输出不算对话框", () => {
    expect(parsePiSelectPane(" → Yes\n   No\n")).toBeNull();
  });

  test("没有光标行 → 不算（挡住恰好挨着 footer 的正文）", () => {
    expect(parsePiSelectPane(PI_CONFIRM.replace(" → Yes", "   Yes"))).toBeNull();
  });

  test("多行都带光标 → 不算", () => {
    expect(parsePiSelectPane(PI_CONFIRM.replace("   No", " → No"))).toBeNull();
  });

  test("只有一个选项不算（Pi 的确认至少两项）", () => {
    expect(parsePiSelectPane(PI_CONFIRM.replace("   No\n", ""))).toBeNull();
  });

  test("Claude Code 的权限弹窗不走 Pi 分支（两边 footer 签名互斥）", () => {
    expect(parsePiSelectPane(CC_PERMISSION)).toBeNull();
  });
});
