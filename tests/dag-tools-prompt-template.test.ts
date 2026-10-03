/** i28-N4：ui 卡的执行者说明多一节截图交付；code / security / 不带模板逐字相同，自定义模板也附上这一节 */
import { describe, expect, test } from "bun:test";
import { renderExecPrompt, type PromptVars } from "../src/lib/dag-tools-prompt.ts";

const V: PromptVars = { task: "T1", title: "标题", pm: "agent-pm", branch: "feat/t1", base: "origin/main", worktree: "/wt/t1", spec: "/l/docs/tasks/T1.md", ledgerDir: "/l" };

describe("renderExecPrompt 按模板", () => {
  const plain = renderExecPrompt(V);

  test("code / security 与不带模板逐字相同，不提截图", () => {
    expect(renderExecPrompt({ ...V, template: "code" })).toBe(plain);
    expect(renderExecPrompt({ ...V, template: "security" })).toBe(plain);
    expect(plain).not.toContain("screenshots");
  });

  test("ui = 原说明 + 截图交付一节：≥ 2 张绝对路径、摘要、task-set 整份替换、headless 不用 Playwright MCP", () => {
    const ui = renderExecPrompt({ ...V, template: "ui" });
    expect(ui.startsWith(plain)).toBe(true);
    const extra = ui.slice(plain.length);
    expect(extra.startsWith("\n## ui 卡：合并前要过前后截图验收\n")).toBe(true);
    for (const s of ["extra.screenshots", "至少 2 个图片的绝对路径", "改前 / 改后", "extra.screenshotsDigest", "64 位十六进制",
      "`ledger task-set T1 --rev <rev> --extra '<json>'`", "原有字段", "headless", "不用 Playwright MCP"]) expect(extra).toContain(s);
    expect(extra).not.toContain("{TASK}");
  });

  test("自定义模板（exec-template.md）也覆盖不掉 ui 这一节", () => {
    const ui = renderExecPrompt({ ...V, template: "ui" }, "自定义 {TASK}\n");
    expect(ui.startsWith("自定义 T1\n")).toBe(true);
    expect(ui).toContain("## ui 卡：合并前要过前后截图验收");
    expect(renderExecPrompt({ ...V, template: "security" }, "自定义 {TASK}\n")).toBe(renderExecPrompt(V, "自定义 {TASK}\n"));
  });
});
