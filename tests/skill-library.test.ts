/**
 * lib/skill-library.ts：本机有效技能清单——搜索根、来源（软链进本仓库 / CC Switch）、同步技能多一层账号目录、
 * Claude Code 的同名规则（个人 > 项目、不同项目互不遮挡；同步的一律带 anthropic-skills: 前缀）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillLibrary, markShadowing, onlyProjects, skillRoots, type LibrarySkill } from "../src/lib/skill-library.js";

const home = mkdtempSync(join(tmpdir(), "skill-lib-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const skill = (dir: string, fm: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n\n正文\n`);
};

describe("skillRoots", () => {
  test("三家 runtime 的根；项目根按 agent 的 runtime 给；家目录不算项目；同目录不重复", () => {
    const roots = skillRoots({
      home: "/h",
      agents: [
        { cwd: "/w/a", runtime: "claude-code" },
        { cwd: "/w/a", runtime: "claude-code" },
        { cwd: "/w/b", runtime: "pi" },
        { cwd: "/h", runtime: "claude-code" },
      ],
      plugins: [{ name: "discord", installPath: "/p/discord/1.0" }],
      piSkillPaths: ["/extra/pi-skills"],
    });
    const brief = roots.map((r) => `${r.runtime}:${r.scope}:${r.dir}`);
    expect(brief).toContain("claude-code:personal:/h/.claude/skills");
    expect(brief).toContain("claude-code:plugin:/p/discord/1.0/skills");
    expect(brief).toContain("codex:system:/h/.codex/skills/.system");
    expect(brief).toContain("pi:personal:/extra/pi-skills");
    expect(brief.filter((b) => b === "claude-code:project:/w/a/.claude/skills")).toHaveLength(1);
    expect(brief).toContain("pi:project:/w/b/.agents/skills");
    expect(brief.some((b) => b.startsWith("claude-code:project:/h/"))).toBe(false);
  });
});

describe("onlyProjects（按凭据 scope 裁剪技能库）", () => {
  test("scope 外 agent 的项目技能 / 项目搜索根不报；个人、插件、同步原样保留", () => {
    const items = [
      { scope: "personal", dir: "/h/.claude/skills/a" },
      { scope: "project", project: "/w/mine", dir: "/w/mine/.claude/skills/b" },
      { scope: "project", project: "/w/other", dir: "/w/other/.claude/skills/c" },
      { scope: "project", dir: "/w/?/.claude/skills/d" },
      { scope: "plugin", dir: "/p/skills" },
    ];
    expect(onlyProjects(items, new Set(["/w/mine"])).map((x) => x.dir)).toEqual(["/h/.claude/skills/a", "/w/mine/.claude/skills/b", "/p/skills"]);
  });
});

describe("markShadowing（Claude Code 官方同名规则）", () => {
  const s = (scope: LibrarySkill["scope"], project?: string, runtime: LibrarySkill["runtime"] = "claude-code"): LibrarySkill => ({
    runtime, scope, name: "deploy", description: "", dir: `/${scope}/${project ?? ""}`, linkTarget: null, managedBy: null,
    userInvocable: true, modelInvocable: true, sameNameElsewhere: 0, ...(project ? { project } : {}),
  });
  test("个人 > 项目；不同项目互不遮挡", () => {
    const [personal, projA, projB] = markShadowing([s("personal"), s("project", "/a"), s("project", "/b")]);
    expect(personal.shadowedBy).toBeUndefined();
    expect(projA.shadowedBy).toBe("personal");
    expect(projB.shadowedBy).toBe("personal");
    expect(personal.sameNameElsewhere).toBe(2);
    const [a, b] = markShadowing([s("project", "/a"), s("project", "/b")]);
    expect(a.shadowedBy).toBeUndefined();
    expect(b.shadowedBy).toBeUndefined();
  });
  test("Codex / Pi 的优先级没有文档：不判谁盖谁，只报同名几处", () => {
    const [x, y] = markShadowing([s("personal", undefined, "codex"), s("system", undefined, "codex")]);
    expect(x.shadowedBy).toBeUndefined();
    expect(y.shadowedBy).toBeUndefined();
    expect(x.sameNameElsewhere).toBe(1);
  });
});

describe("buildSkillLibrary（真扫盘）", () => {
  test("软链进本仓库 = claudestra 管；同步技能多一层账号目录；引号名字去引号；隐藏 / 只手动标出来", async () => {
    const repoSkills = join(home, "repo", "skills");
    skill(join(repoSkills, "save"), "name: save\ndescription: 存档");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(repoSkills, "save"), join(home, ".claude", "skills", "save"));
    skill(join(home, ".claude", "skills", "bg-only"), "name: bg-only\nuser-invocable: false\ndisable-model-invocation: false");
    skill(join(home, ".claude", "skills", "synced", "acct-1", "pdf"), "name: pdf\ndescription: PDF");
    skill(join(home, ".codex", "skills", ".system", "imagegen"), 'name: "imagegen"\ndescription: "画图"');
    const lib = await buildSkillLibrary({ home, agents: [], plugins: [], piSkillPaths: [] }, repoSkills);
    const by = (n: string) => lib.skills.find((x) => x.name === n)!;
    expect(by("save").managedBy).toBe("claudestra");
    expect(by("save").linkTarget).toContain("/repo/skills/save");
    expect(by("bg-only").userInvocable).toBe(false);
    expect(by("anthropic-skills:pdf").scope).toBe("synced");
    expect(by("imagegen").description).toBe("画图");
    expect(by("imagegen").scope).toBe("system");
    expect(lib.skills.some((x) => x.name === "synced")).toBe(false);
    expect(lib.roots.find((r) => r.scope === "personal" && r.runtime === "pi")!.exists).toBe(false);
  });
});
