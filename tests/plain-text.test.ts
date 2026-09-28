/** reply 正文 → 纯文本（src/lib/plain-text.ts）与推送通知正文（notificationBody）：不露出任何样式记号 */
import { describe, expect, test } from "bun:test";
import { markdownToPlain } from "../src/lib/plain-text.js";
import { notificationBody } from "../src/bridge/push/dispatcher.js";

describe("markdownToPlain", () => {
  test("粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片 / 标题 / 引用 / 列表 / HTML", () => {
    expect(markdownToPlain("## 结论\n**v2.30.2 已发布**，见 [链接](https://x.y/z) 与 `web-release deploy`")).toBe("结论\nv2.30.2 已发布，见 链接 与 web-release deploy");
    expect(markdownToPlain("> 引用\n- 一\n2. 二\n- [x] 完成")).toBe("引用\n一\n二\n完成");
    expect(markdownToPlain("~~旧~~ *斜* _体_ ![图](a.png) <b>粗</b><br>")).toBe("旧 斜 体 图 粗");
  });
  test("下划线在词中间不当斜体（文件名、变量名原样保留）", () => {
    expect(markdownToPlain("改了 web_build_lock 和 snake_case_name")).toBe("改了 web_build_lock 和 snake_case_name");
  });
  test("行内按钮 / chip：按钮留 [label]，badge / agent / copy 留文字", () => {
    expect(markdownToPlain("T0 [[{.badge .success}已上线]]，找 [[{.agent}agent-task-t1]]，跑 [[{.copy}bun x]] [[{#go .primary}批准]]"))
      .toBe("T0 已上线，找 agent-task-t1，跑 bun x [批准]");
  });
  test("表格：分隔行丢掉，单元格用 · 连起来；代码块留内容去围栏；分割线丢掉", () => {
    expect(markdownToPlain("| 任务 | 状态 |\n|---|:---:|\n| T1 | 进行中 |\n---\n```ts\nconst a = 1;\n```"))
      .toBe("任务 · 状态\n\nT1 · 进行中\n\nconst a = 1;");
  });
});

describe("notificationBody", () => {
  test("样式去掉后压成一行，超长截断", () => {
    expect(notificationBody("**T0 [[{.badge .success}已上线]]**\n\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("T0 已上线 a · b 1 · 2");
    expect(notificationBody("x".repeat(300))).toHaveLength(181);
  });
});
