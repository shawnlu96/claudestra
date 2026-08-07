/**
 * v2.17.2 AskUserQuestion pane 侧解析 —— parseAuqPane 纯函数单测。
 *
 * fixture 全部来自 CC 2.1.222 隔离会话的真实 tmux capture（2026-08-07 auq-lab
 * 逐键实验），非手写想象。背景：CC 2.1.x 把 AUQ tool_use 攒到作答后才落盘，
 * pane 识别是唯一及时通路。
 */

import { describe, test, expect } from "bun:test";
import { parseAuqPane, parseAuqTabSections } from "../src/lib/auq-pane.ts";

// 单问题单选：☐ 标题行 + 右侧 preview 框 + Notes 提示 + 无编号 Chat about this
const SINGLE_SELECT_PANE = `
────────────────────────────────────────────────────────────────────────────────────────────
 ☐ 布局方案

接下来这个演示页面，你想用哪种布局方案？

❯ 1. 侧边栏 + 主区（推荐）        ┌─────────────────────────────────────────────┐
  2. 顶部导航 + 单栏              │ ┌──────────┬────────────────────────────┐   │
  3. 三栏（导航+内容+详情）       │ │ ▸ 概览   │  标题                      │   │
                                  │ │ ▸ 数据   │  ────────────────────────  │   │
                                  │ │ ▸ 设置   │                            │   │
                                  │ └──────────┴────────────────────────────┘   │
                                  └─────────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
`;

// 多问题（tabbed）：当前 section 是多选，选项带 [ ] + 描述行 + Type something 伪选项
const MULTI_QUESTION_PANE = `
←  ☐ 页面模块  ☐ 主题  ✔ Submit  →

顶部导航 + 单栏这个页面，你想包含哪些模块？（可多选）

❯ 1. [ ] 顶部指标卡片行
  导航下方一排 KPI 数字卡片（总量、今日新增、异常数等），一眼看到关键数据。
  2. [✔] 图表区
  一到两个趋势图 / 分布图，展示随时间变化或分类占比。
  3. [ ] 明细表格
  可排序、可筛选的数据表格，放在页面下半部分，支持翻页。
  4. [ ] Type something
     Next
────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// 单问题多选（tabbed，只有一个 section + Submit）
const SINGLE_MULTI_PANE = `
←  ☐ 图表类型  ✔ Submit  →

图表区里放哪几种图？（可多选）

❯ 1. [ ] 时间趋势折线图
  横轴时间、纵轴数值，看指标随时间的涨跌和拐点。适合日/周粒度的连续数据。
  2. [ ] 分类对比柱状图
  按类别排序的水平或垂直柱子，方便比大小、找 Top N。
  3. [ ] 占比堆叠面积图
  多个分量堆叠展示总量及各自占比随时间的变化，比饼图更能看出结构趋势。
  4. [ ] Type something
     Submit
────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// Review/Submit 段：只有 "1. Submit answers" 一个真实选项 → 不是可解析弹窗
const REVIEW_PANE = `
←  ☒ 页面模块  ☒ 主题  ✔ Submit  →

Review your answers

 ● 顶部导航 + 单栏这个页面，你想包含哪些模块？（可多选）
   → 图表区
 ● 配色主题怎么定？
   → 只做一套浅色

Ready to submit your answers?

❯ 1. Submit answers

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// 空闲输入框（无弹窗）
const IDLE_PANE = `
⏺ 好的，已完成。

✻ Cooked for 1m 24s
────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents
`;

// 运行时权限弹窗（有编号选项但无 ☐ 标题/tab 栏）→ 不能误报成 AUQ
const PERMISSION_PANE = `
 Do you want to make this edit to config.ts?

❯ 1. Yes
  2. Yes, allow all edits during this session (shift+tab)
  3. No, and tell Claude what to do differently (esc)

Enter to select · Esc to cancel
`;

describe("parseAuqPane", () => {
  test("单问题单选：☐ 标题 + preview 框剥离", () => {
    const p = parseAuqPane(SINGLE_SELECT_PANE)!;
    expect(p).not.toBeNull();
    expect(p.form).toBe("single");
    expect(p.sections).toEqual(["布局方案"]);
    expect(p.question).toBe("接下来这个演示页面，你想用哪种布局方案？");
    expect(p.multiSelect).toBe(false);
    expect(p.options.map((o) => o.label)).toEqual([
      "侧边栏 + 主区（推荐）",
      "顶部导航 + 单栏",
      "三栏（导航+内容+详情）",
    ]);
    expect(p.options[0].cursor).toBe(true);
    expect(p.options[1].cursor).toBe(false);
  });

  test("多问题 tabbed：sections + 当前段选项/勾选态/描述", () => {
    const p = parseAuqPane(MULTI_QUESTION_PANE)!;
    expect(p).not.toBeNull();
    expect(p.form).toBe("tabbed");
    expect(p.sections).toEqual(["页面模块", "主题"]);
    expect(p.multiSelect).toBe(true);
    expect(p.options.length).toBe(3); // Type something / Chat about this 剔除
    expect(p.options[1].label).toBe("图表区");
    expect(p.options[1].checked).toBe(true);
    expect(p.options[0].checked).toBe(false);
    expect(p.options[0].description).toContain("KPI 数字卡片");
    // Type something 下面的 "Next" 提示不能误附到选项 3 的描述里
    expect(p.options[2].description).not.toContain("Next");
  });

  test("单问题多选 tabbed：单 section", () => {
    const p = parseAuqPane(SINGLE_MULTI_PANE)!;
    expect(p).not.toBeNull();
    expect(p.form).toBe("tabbed");
    expect(p.sections).toEqual(["图表类型"]);
    expect(p.multiSelect).toBe(true);
    expect(p.options.map((o) => o.label)).toEqual([
      "时间趋势折线图",
      "分类对比柱状图",
      "占比堆叠面积图",
    ]);
  });

  test("Review/Submit 段（只剩 Submit answers 一项）→ null", () => {
    expect(parseAuqPane(REVIEW_PANE)).toBeNull();
  });

  test("空闲 pane → null", () => {
    expect(parseAuqPane(IDLE_PANE)).toBeNull();
  });

  test("运行时权限弹窗（无 ☐ 标题/tab 栏）→ null", () => {
    expect(parseAuqPane(PERMISSION_PANE)).toBeNull();
  });
});

describe("parseAuqTabSections", () => {
  test("双 section + Submit", () => {
    expect(parseAuqTabSections("←  ☐ 页面模块  ☒ 主题  ✔ Submit  →")).toEqual(["页面模块", "主题"]);
  });
  test("单 section", () => {
    expect(parseAuqTabSections("←  ☐ 图表类型  ✔ Submit  →")).toEqual(["图表类型"]);
  });
});
