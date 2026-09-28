/** lib/agent-skills.ts：某个 agent 能看到哪些技能、各是什么档位（会话详情的技能栏、manager skill-toggle 的 Pi 分支） */
import { describe, expect, test } from "bun:test";
import { agentSkillView, piCandidates, piSkillEntryMatches } from "../src/lib/agent-skills.js";
import type { LibrarySkill } from "../src/lib/skill-library.js";

const sk = (name: string, over: Partial<LibrarySkill> = {}): LibrarySkill => ({
  runtime: "claude-code", scope: "personal", name, description: "", dir: `/h/.claude/skills/${name}`, linkTarget: null,
  managedBy: null, userInvocable: true, modelInvocable: true, sameNameElsewhere: 0, ...over,
});

describe("Claude Code", () => {
  const lib = [
    sk("pdf", { scope: "synced", name: "anthropic-skills:pdf" }),
    sk("save"),
    sk("deploy", { scope: "project", project: "/w/a", dir: "/w/a/.claude/skills/deploy" }),
    sk("other", { scope: "project", project: "/w/b", dir: "/w/b/.claude/skills/other" }),
    sk("save", { scope: "project", project: "/w/a", dir: "/w/a/.claude/skills/save", shadowedBy: "personal" }),
    sk("x", { runtime: "codex", dir: "/h/.codex/skills/x" }),
  ];
  test("只列本 agent 项目的项目技能；被同名盖过的不列；别的 runtime 不列；档位取 overrides", () => {
    const v = agentSkillView("claude-code", lib, { cwd: "/w/a", overrides: { save: "off" }, piEnv: {} });
    expect(v.supported).toBe(true);
    expect(v.rows.map((r) => [r.name, r.scope, r.state])).toEqual([
      ["anthropic-skills:pdf", "synced", "on"],
      ["deploy", "project", "on"],
      ["save", "personal", "off"],
    ]);
  });
  test("大总管（cwd 空）不看项目技能；设置里有、技能库没了的补一行 missing 好开回来", () => {
    const v = agentSkillView("claude-code", lib, { cwd: null, overrides: { gone: "off" }, piEnv: {} });
    expect(v.rows.map((r) => r.name)).toEqual(["anthropic-skills:pdf", "gone", "save"]);
    expect(v.rows.find((r) => r.name === "gone")).toMatchObject({ scope: "missing", dir: null, state: "off" });
  });
});

describe("Pi / Codex", () => {
  const lib = [
    sk("a", { runtime: "pi", dir: "/h/.pi/agent/skills/a" }),
    sk("a", { runtime: "pi", scope: "shared", dir: "/h/.agents/skills/a" }),
    sk("b", { runtime: "pi", scope: "shared", dir: "/h/.agents/skills/b" }),
    sk("c", { runtime: "pi", scope: "project", project: "/w/p", dir: "/w/p/.pi/skills/c" }),
  ];
  test("同名多处取一个：项目 > 个人 > 共享目录", () => {
    expect(piCandidates(lib, "/w/p").map((s) => s.dir)).toEqual(["/w/p/.pi/skills/c", "/h/.pi/agent/skills/a", "/h/.agents/skills/b"]);
  });
  test("minimal 档：档案里列了的才算开（路径或目录名都认）", () => {
    const v = agentSkillView("pi", lib, { cwd: "/w/p", overrides: {}, piEnv: { base: "minimal", skills: ["/h/.pi/agent/skills/a", "/elsewhere/c"] } });
    expect(v.supported).toBe(true);
    expect(v.rows.map((r) => [r.name, r.state])).toEqual([["a", "on"], ["b", "off"], ["c", "on"]]);
  });
  test("inherit 档：全部开着、不给开关", () => {
    const v = agentSkillView("pi", lib, { cwd: null, overrides: {}, piEnv: {} });
    expect(v).toMatchObject({ supported: false, reason: "inherit" });
    expect(v.rows.every((r) => r.state === "on")).toBe(true);
  });
  test("Codex 本期不支持", () => {
    expect(agentSkillView("codex", lib, { cwd: null, overrides: {}, piEnv: {} })).toEqual({ runtime: "codex", supported: false, reason: "codex", rows: [] });
  });
  test("piSkillEntryMatches", () => {
    expect(piSkillEntryMatches("/h/.pi/agent/skills/a/", { name: "a", dir: "/h/.pi/agent/skills/a" })).toBe(true);
    expect(piSkillEntryMatches("/x/b", { name: "a", dir: "/h/a" })).toBe(false);
  });
});
