/** i28-M8b 自动卡派单提示：开工 / 修复单要先开 PR 再 deliver；DEFAULT_TEMPLATE 与 AUTO_SECTION 其它句子逐字不变 */
import { describe, expect, test } from "bun:test";
import { ASK_DEFAULT_GUIDANCE } from "../src/lib/order-standard-answers.js";
import { renderExecPrompt, type PromptVars } from "../src/lib/dag-tools-prompt.ts";

const V: PromptVars = { task: "T1", title: "标题", pm: "agent-pm", branch: "feat/t1", base: "origin/main", worktree: "/wt/t1", spec: "/l/docs/tasks/T1.md", ledgerDir: "/l" };

/** 改前的 DEFAULT_TEMPLATE 按 V 渲染后的全文（逐字） */
const DEFAULT_RENDERED = `你是 T1「标题」的执行者。PM 是 agent-pm。审查由调度器另派一个跨模型的审查会话做，你不用自己找审查员。

## 先读
1. 规格卡 /l/docs/tasks/T1.md（只读）。
2. 仓库根目录的 CLAUDE.md / AGENTS.md 里的规矩（worktree 里同一份）。

## 做法
- 你的 worktree 就是当前目录 /wt/t1，分支 feat/t1（base origin/main）。小步 commit。
- 按仓库规矩自检全绿再交付；能在沙箱实测的实测。
- 不合并、不部署、不打 tag、不发 release；push 分支和开 PR 可以。只在当前 worktree 改文件，不碰主树。
- 代码里不放 secrets、IP、个人信息。
`;

/** AUTO_SECTION 里除「开工 / 修复」以外的行（改前逐字） */
const AUTO_KEPT = [
  "## 本卡是自动卡：生命周期归调度器，不找 PM",
  "- 派单全部来自调度服务（take_order 取单）。**不要给 agent-pm 发任何进度、交付或「收到」消息**，PM 不在这条链上。",
  "- 「复述」单：把复述（≤ 40 行）写进 /l/reviews/T1-restate.md，再把阶段推到 restate（`ledger stage T1 --from spec --to restate --text \"复述见 reviews/T1-restate.md\"`），然后停下等开工单。",
  `- ${ASK_DEFAULT_GUIDANCE}`,
  "- 规格外文件交付时自动登记，审查员判断理由是否充分（不充分记 P2）；与其他在跑卡共改时冲突两边保留。",
];

describe("renderExecPrompt：自动卡开工 / 修复先开 PR", () => {
  const out = renderExecPrompt(V);
  const auto = out.slice(DEFAULT_RENDERED.length);

  test("DEFAULT_TEMPLATE 段与改前逐字相同", () => {
    expect(out.startsWith(DEFAULT_RENDERED)).toBe(true);
  });

  test("开工 / 修复那条：push → 开 PR（base main）→ deliver，PR 自动登记、没开会被拒；CLI 兜底带 --pr", () => {
    const line = auto.split("\n").find((l) => l.startsWith("- 「开工 / 修复」单"));
    expect(line).toBeDefined();
    for (const s of ["push", "开好 PR", "base main", "已开过的不用重开", "deliver 工具", "自动登记", "没开 PR 会被拒"]) expect(line).toContain(s);
    expect(line).toContain("`ledger deliver T1 --from build|fix --head <完整 sha> --pr <完整 PR 链接>`");
    expect(line!.indexOf("push")).toBeLessThan(line!.indexOf("开好 PR"));
    expect(line!.indexOf("开好 PR")).toBeLessThan(line!.indexOf("deliver 工具"));
    expect(out).not.toContain("做完 push，用 deliver");
  });

  test("AUTO_SECTION 其它行逐字不变，行数不变", () => {
    const lines = auto.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBe(AUTO_KEPT.length + 1);
    expect(lines.filter((l) => !l.startsWith("- 「开工 / 修复」单"))).toEqual(AUTO_KEPT);
  });

  test("自定义模板也总附上同一段 auto 说明", () => {
    expect(renderExecPrompt(V, "自定义 {TASK}\n")).toBe(`自定义 T1\n${auto}`);
  });
});
