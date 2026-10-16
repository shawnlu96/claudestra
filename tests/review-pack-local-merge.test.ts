/** ONB-1 验收 4（审查包）：localMerge 项目 diff 用 main...HEAD、跑本项目的 requiredChecks；其余项目（含不带 project 的）逐字不变 */
import { describe, expect, test } from "bun:test";
import { buildReviewPack, type ReviewPackInput } from "../src/lib/review-pack.js";

const input = (over: Partial<ReviewPackInput> = {}): ReviewPackInput => ({
  task: { id: "T9", title: "示例", branch: "feat/t9", pr: null, headSHA: "abcdef1234567", project: "dn" }, round: 1, adversarial: false, worktree: "/w/t9",
  specPath: "/docs/tasks/T9.md", specText: "## 验收\n- 一条\n", deliver: null, prev: null, reviewPath: "/r/T9-r1.md", workDir: "/r/T9-r1-work",
  prod: { stateDir: "/state", tmuxSocket: "/run/master.sock", bridgePort: 4000 }, ...over,
});

describe("buildReviewPack：localMerge 项目", () => {
  test("diff 对本机 main，检查列本项目的命令，不提 bun run check", () => {
    const p = buildReviewPack(input({ local: { repoDir: "/tmp/dn", checks: ["cargo test", "make lint"] } })).prompt;
    expect(p).toContain("- 改动：git -C /w/t9 diff main...HEAD");
    expect(p).not.toContain("origin/main");
    expect(p).toContain("- 逐条跑本项目的必过检查（按空白切参数，不经 shell）：`cargo test`；`make lint`。");
    expect(p).not.toContain("bun run check");
  });

  test("非本地项目：local=null 与不带 project（老调用方）同一份，仍是 origin/main + bun run check", () => {
    const a = buildReviewPack(input({ local: null })).prompt;
    const { project: _p, ...task } = input().task;
    expect(buildReviewPack(input({ task })).prompt).toBe(a);
    expect(a).toContain("- 改动：git -C /w/t9 diff origin/main...HEAD");
    expect(a).toContain("全量 bun run check");
  });
});
