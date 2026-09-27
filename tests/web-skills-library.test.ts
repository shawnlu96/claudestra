/** web/features/chat/skills-library-logic.ts：设置 ·「技能」页的筛选、排序、路径缩写 */
import { describe, expect, test } from "bun:test";
import { homeOf, runtimeCounts, shortPath, visibleSkills, type LibrarySkill, type SkillRoot } from "@/features/chat/skills-library-logic";

const sk = (name: string, over: Partial<LibrarySkill> = {}): LibrarySkill => ({
  runtime: "claude-code", scope: "personal", name, description: "", dir: `/h/.claude/skills/${name}`, linkTarget: null,
  managedBy: null, userInvocable: true, modelInvocable: true, sameNameElsewhere: 0, ...over,
});

describe("skills-library-logic", () => {
  test("runtime 计数：没有技能的 runtime 不出按钮", () => {
    expect(runtimeCounts([sk("a"), sk("b", { runtime: "codex" })])).toEqual([
      { id: "all", n: 2 }, { id: "claude-code", n: 1 }, { id: "codex", n: 1 },
    ]);
  });
  test("被盖过的沉底；再按作用域（个人 → 项目 → … → 同步）、名字；搜索看名字和说明", () => {
    const list = [sk("zeta"), sk("deploy", { scope: "project", shadowedBy: "personal" }), sk("pdf", { scope: "synced" }), sk("alpha", { description: "部署到线上" })];
    expect(visibleSkills(list, "all", "").map((s) => s.name)).toEqual(["alpha", "zeta", "pdf", "deploy"]);
    expect(visibleSkills(list, "all", "部署").map((s) => s.name)).toEqual(["alpha"]);
    expect(visibleSkills(list, "codex", "")).toEqual([]);
  });
  test("家目录从个人技能根反推，路径缩成 ~", () => {
    const roots: SkillRoot[] = [{ runtime: "claude-code", scope: "personal", dir: "/Users/x/.claude/skills", exists: true }];
    const home = homeOf(roots);
    expect(home).toBe("/Users/x");
    expect(shortPath("/Users/x/.codex/skills/a", home)).toBe("~/.codex/skills/a");
    expect(shortPath("/Users/xy/a", home)).toBe("/Users/xy/a");
    expect(shortPath("/opt/a", null)).toBe("/opt/a");
  });
});
