import { describe, expect, test } from "bun:test";
import { itemRows, kindOf, toolOf, toolRows } from "../src/lib/acp/tui/blocks.ts";
import { stripSgr } from "../src/lib/acp/tui/text.ts";
import { transcriptOfEntry, transcriptOfFailure, transcriptOfInbound, transcriptOfStop } from "../src/lib/acp/transcript.ts";
import { permissionLines } from "../src/lib/acp/tty-input.ts";
import { PERMISSION } from "./helpers/acp-tui-session.ts";

// 宿主交给窗口的段（transcript.ts 的格式）→ 认种类 → 定稿样子

const at = new Date(2026, 9, 14, 21, 3, 5);
const rows = (item: string, cols = 60) => itemRows(kindOf(item), item, cols, at).map(stripSgr);
const tool = (name: string, input: object) => transcriptOfEntry({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name, input }] } })[0]!;

describe("认种类：只看段的格式，和是哪个 harness 无关", () => {
  test("transcript.ts 产出的每一种段都认得出", () => {
    expect(kindOf(tool("Bash", { command: "ls" }))).toBe("tool");
    expect(kindOf(tool("mcp__claudestra__send_to_agent", { target: "a", text: "b" }))).toBe("tool");
    expect(kindOf(tool("update_plan", { plan: [{ step: "a", status: "completed" }] }))).toBe("plan");
    expect(kindOf(tool("mcp__claudestra__reply", { text: "好" }))).toBe("message");
    expect(kindOf("● 正文(带括号)\n第二行")).toBe("message");
    expect(kindOf("  ⎿ 3 行输出")).toBe("result");
    expect(kindOf(transcriptOfInbound("hi", { user: "owner" }))).toBe("inbound");
    expect(kindOf("✻ 上下文已压缩")).toBe("thinking");
    expect(kindOf(permissionLines(PERMISSION))).toBe("permission");
    expect(kindOf(transcriptOfFailure({ kind: "quota", message: "x" } as never))).toBe("failure");
    expect(kindOf(transcriptOfStop({ event: "Stop", stopHookActive: false }))).toBe("stop");
    expect(kindOf("⏹ 已请求打断")).toBe("notice");
    expect(kindOf("❯ /model x")).toBe("plain");
  });

  test("工具段拆出名字和摘要", () => {
    expect(toolOf("● Bash(git status)")).toEqual({ name: "Bash", arg: "git status" });
    expect(toolOf("● claudestra/send_to_agent(a: b)")).toEqual({ name: "claudestra/send_to_agent", arg: "a: b" });
  });
});

describe("定稿样子", () => {
  test("工具头：状态符号（成功 ✓ / 失败 ✗ / 未完成 ◌）+ 名字(摘要)；ACP 类型只在名字看不出来时标", () => {
    expect(toolRows({ name: "Bash", arg: "ls", kind: "execute", status: "ok" }, 60).map(stripSgr)).toEqual(["✓ Bash(ls)"]);
    expect(toolRows({ name: "Bash", arg: "ls", status: "fail" }, 60).map(stripSgr)).toEqual(["✗ Bash(ls)"]);
    expect(toolRows({ name: "Read", arg: "a.ts", kind: "read", status: "lost" }, 60).map(stripSgr)).toEqual(["◌ Read(a.ts) · 未完成"]);
    expect(toolRows({ name: "apply_patch", arg: "a.ts", kind: "edit", status: "ok" }, 60).map(stripSgr)).toEqual(["✓ apply_patch(a.ts)"]);
    expect(toolRows({ name: "lookup", arg: "x", kind: "fetch", status: "ok" }, 60).map(stripSgr)).toEqual(["✓ lookup(x) · 抓取"]);
    expect(toolRows({ name: "claudestra/reply", arg: "", kind: "other", status: "ok" }, 60).map(stripSgr)).toEqual(["✓ claudestra/reply()"]);
  });

  test("多条命令串的「＋N 条」写成「(+N 条命令)」", () => {
    expect(toolOf("● Bash(git status --short ＋5 条)")).toEqual({ name: "Bash", arg: "git status --short (+5 条命令)" });
    expect(toolOf("● Bash(cat x（3 行脚本）)").arg).toBe("cat x（3 行脚本）");
  });

  test("结果：成功的暗色一行，失败的红色留末尾几行（续行对齐）", () => {
    expect(rows("  ⎿ 12 行输出")).toEqual(["  ⎿ 12 行输出"]);
    expect(rows("  ⎿ ✗ （共 9 行，末尾 4 行）\n    a\n    b")).toEqual(["  ⎿ ✗ （共 9 行，末尾 4 行）", "    a", "    b"]);
    expect(itemRows("result", "  ⎿ ✗ boom", 60, at)[0]).toContain("\x1b[31m");
  });

  test("计划：清单带完成数，每项有状态", () => {
    expect(rows(tool("update_plan", { plan: [{ step: "读", status: "completed" }, { step: "跑", status: "in_progress" }, { step: "写", status: "pending" }] })))
      .toEqual(["● 计划 · 1/3", "  ✓ 读", "  ▸ 跑", "  ○ 写"]);
  });

  test("收到的消息：竖线 + 来源 + 时间，正文跟在下面", () => {
    expect(rows(transcriptOfInbound("第一行\n第二行", { user: "agent-x" }))).toEqual(["┃ agent-x · 21:03", "┃ 第一行", "┃ 第二行"]);
  });

  test("审批：框起来，选项一行一个，键位提示原文照搬", () => {
    expect(rows(permissionLines(PERMISSION))).toEqual([
      "╭─ ⏸ 需要审批", "│ 要运行命令：rm -rf build/", "│ 工作目录 ~/repo", "│ [1] 允许", "│ [2] 总是允许", "│ [3] 拒绝",
      "│ y 允许 / n 拒绝 / 序号，再按回车；网页卡片也能答", "╰─",
    ]);
  });

  test("回合分隔：结局 + 时间的一道线，窄屏不超宽", () => {
    expect(rows("── 已打断 ──", 30)).toEqual(["── 已打断 · 21:03:05 ────────"]);
    // 满宽：和输入框的线一样长（列数 − 1），宽窗口也不停在半截
    for (const c of [30, 52, 120]) expect(Bun.stringWidth(rows("── 回合结束 ──", c)[0]!)).toBe(c - 1);
  });
});
