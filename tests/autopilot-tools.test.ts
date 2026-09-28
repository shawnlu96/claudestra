/** lib/autopilot-tools.ts：哪些工具调用算「有实质进展」——只读工具、通信工具、只读 shell 都不算 */
import { describe, expect, test } from "bun:test";
import { bashCommandOf, countsAsTool, isMutatingTool, isReadOnlyBash } from "../src/lib/autopilot-tools.js";

describe("countsAsTool / isMutatingTool", () => {
  test("通信工具（MCP 名和 Pi 裸名）不算调工具，也不算写", () => {
    for (const n of ["mcp__claudestra__reply", "send_to_agent", "project_info", "mcp__claudestra__send_to_agent", "check_inbox"]) {
      expect(countsAsTool(n)).toBe(false);
      expect(isMutatingTool(n)).toBe(false);
    }
  });
  test("只读工具不算写；Edit / Write 算", () => {
    expect(isMutatingTool("Read")).toBe(false);
    expect(isMutatingTool("Grep")).toBe(false);
    expect(isMutatingTool("Edit")).toBe(true);
    expect(isMutatingTool("Write")).toBe(true);
  });
  test("Bash 按命令判：detail 是「描述\\n───\\n命令」", () => {
    expect(isMutatingTool("Bash", "看 CI\n───\ngh pr checks 146")).toBe(false);
    expect(isMutatingTool("Bash", "Show status\n───\ngit status && git log --oneline -3")).toBe(false);
    expect(isMutatingTool("Bash", "提交\n───\ngit commit -m x")).toBe(true);
    expect(isMutatingTool("Bash")).toBe(true); // 没有命令：分不清就算写
    expect(bashCommandOf("a\n───\nb")).toBe("b");
  });
});

describe("isReadOnlyBash", () => {
  test("只读：git status / log、gh pr checks、ls、cat | grep、带 2>/dev/null、cd 之后再看", () => {
    for (const c of ["git status", "git log --oneline -5", "gh pr checks 146", "gh run view 123 --log", "ls -la", "cat a.txt | grep x | wc -l",
      "tail -n 50 log 2>/dev/null", "cd /repo && git diff --stat", "gh api repos/x/y/pulls/1", "find . -name '*.ts'", "[ -f x ] && echo yes"]) {
      expect(isReadOnlyBash(c)).toBe(true);
    }
  });
  test("写：重定向、git commit / push、rm、find -delete、命令替换、gh api 带 -f / -X、没见过的命令", () => {
    for (const c of ["echo x >> log.txt", "git commit -am x", "git push", "rm -f a", "find . -name x -delete", "cat $(which x)",
      "gh api repos/x/y/issues -f title=t", "gh api -X DELETE repos/x", "bun src/manager.ts kill w", "cat x | sh", "curl -X POST http://x"]) {
      expect(isReadOnlyBash(c)).toBe(false);
    }
  });
});
