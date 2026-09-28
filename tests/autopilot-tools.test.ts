/** lib/autopilot-tools.ts：哪些工具调用算「有实质进展」——只读工具、通信工具、只读 shell 都不算 */
import { describe, expect, test } from "bun:test";
import { bashCommandOf, countsAsTool, isMutatingTool } from "../src/lib/autopilot-tools.js";
import { isReadOnlyBash } from "../src/lib/shell-readonly.js";

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

/** 第 3 轮对抗式复验的探针（t14-r3/shell-probe.ts）：74 条会写的、36 条只读的 */
const WRITES = [
  "git status > f", "ls; rm x", "cat a | tee b", "find . -fprint f", "find . -fprintf f '%p'", "find . -fls f", "find . -okdir rm {} ;",
  "find . -fdelete", "sed -i s/a/b/ f", "gh api -X POST repos/x", "gh api --method POST repos/x", "gh api -F a=b repos/x",
  "gh api -XPOST repos/x/issues", "gh api repos/x/issues -ftitle=t", "gh api repos/x/issues -Ftitle=t", "gh api repos/x/issues \"-X\" POST",
  "gh api repos/x/labels --method=DELETE", "gh pr merge 1", "git stash", "git -c x=y status", "FOO=1 rm x", "command rm x", "ls | xargs rm",
  "echo $(rm x)", "echo `rm x`", "cat <(rm -rf x)", "diff <(git push) a", "cat <<EOF > f\nx\nEOF", "true && rm x", "false || rm x", "ls\nrm x",
  "ls >| f", "ls 2> f", "ls &> f", "echo x >&out.txt", "ls & rm -rf x", "sleep 1 & git push", "git branch -D feat", "git branch newb",
  "git branch -m a b", "git remote add up url", "git remote set-url origin x", "git remote remove origin", "git fetch origin main:main",
  "git diff --output=patch.txt", "git log --output=f", "git show HEAD --output=f", "sort -o out in", "uniq in out", "curl -o f http://x",
  "curl -O http://x/f", "curl --output f http://x", "curl --request POST http://x", "curl -XPOST http://x", "curl -sX POST http://x",
  "curl --json '{}' http://x", "curl --form a=b http://x", "curl -dfoo http://x", "curl -K cfg http://x", "tmux capture-pane -b buf -p",
  "rg --pre ./evil.sh x", "GIT_EXTERNAL_DIFF=./x.sh git diff", "find . -name x -de''lete", "find . \"-delete\"",
  "gh release view v1 && gh release delete v1 --yes", "gh run rerun 1", "gh pr view 1 --json x | sh", "date -s 2020-01-01",
  "git status\n───\nls", "jq . a > b", "tail -n1 f | tee -a g", "echo x >/dev/null; rm y", "ls >/dev/null2", "echo x 1>f",
];
const READS = [
  "git -C /wt status", "git -C /wt log --oneline -3", "grep -E 'a|b' f", "rg 'foo|bar' src", "jq '.[] | .name' f",
  "gh pr view 146 --json statusCheckRollup --jq '.statusCheckRollup[] | .conclusion'", "echo \"done; next\"", "timeout 60 gh pr checks 1 --watch",
  "[[ -f x ]] && echo y", "echo $((1+2))", "cd \"/path with space\" && git status", "sed -n 1,20p f", "awk '{print $1}' f", "git worktree list",
  "git merge-base HEAD origin/main", "git rev-list --count HEAD", "git shortlog -s", "git tag --list", "gh pr diff 1 | head", "cat f | head -n 5",
  "ls -la ~/.x 2>&1 | head", "env | grep X", "bun run check 2>&1 | tail -20", "git log --grep='fix|feat'", "gh search prs x",
  "git status --short | wc -l", "bun test tests/x.test.ts", "readlink -f x", "realpath x", "less f", "nl f", "od -c f", "xxd f", "diff a b", "cmp a b", "tree",
];

describe("对抗式探针（t14-r3）", () => {
  test("会写的一条都不判成只读", () => {
    expect(WRITES.filter((c) => isReadOnlyBash(c))).toEqual([]);
  });
  test("只读的一条都不判成写（git -C、引号里的 |、timeout 前缀、sed -n、awk、$((…))、[[ ]]…）", () => {
    expect(READS.filter((c) => !isReadOnlyBash(c))).toEqual([]);
  });
  test("工具名：server 名带下划线的 reply 是通信；ask_codex / mem0 查询只读；探索类子 agent 只读、干活的算写；Codex / Pi 的 shell 按命令判", () => {
    expect(countsAsTool("mcp__plugin_claudestra_claudestra__reply")).toBe(false);
    expect(isMutatingTool("mcp__claudestra__ask_codex")).toBe(false);
    expect(isMutatingTool("mcp__mem0__memory_search")).toBe(false);
    expect(isMutatingTool("Agent", '{"subagent_type":"Explore","prompt":"x"}')).toBe(false);
    expect(isMutatingTool("Agent", '{"subagent_type":"Plan","prompt":"x"}')).toBe(false);
    expect(isMutatingTool("Agent", '{"subagent_type":"claude-code-guide","prompt":"x"}')).toBe(true); // 带 Bash：只有 Explore / Plan 算只读
    expect(isMutatingTool("Agent", '{"subagent_type":"general-purpose","prompt":"x"}')).toBe(true);
    // 只看最外层字段：嵌在别处的 subagent_type、不是完整 JSON 的 detail 都按在干活算
    expect(isMutatingTool("Agent", '{"subagent_type":"general-purpose","x":{"subagent_type":"Explore"}}')).toBe(true);
    expect(isMutatingTool("Agent", JSON.stringify({ subagent_type: "Plan", prompt: "p" }, null, 2))).toBe(false);
    expect(isMutatingTool("Agent", '{"subagent_type":"Explore"')).toBe(true);
    expect(isMutatingTool("exec_command", '{"cmd":"git status"}')).toBe(false);
    expect(isMutatingTool("shell", '{"command":["git","push"]}')).toBe(true);
    expect(isMutatingTool("apply_patch")).toBe(true);
    expect(isMutatingTool("bash", "x\n───\nls")).toBe(false);
  });
});

