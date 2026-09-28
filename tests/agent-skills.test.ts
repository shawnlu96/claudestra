/** lib/agent-skills.ts：某个 agent 能看到哪些技能、各是什么档位（会话详情的技能栏、manager skill-toggle 的 Pi 分支） */
import { describe, expect, test } from "bun:test";
import { agentSkillView, piCandidates, piParentEntryFor, piSkillEntryMatches, skillWrites } from "../src/lib/agent-skills.js";
import { applySkillChanges, skillTableOf, type SkillState } from "../src/lib/agent-settings.js";

type Step = [string, SkillState];
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

describe("同名的同步技能与个人 / 项目技能（按 CC 的查键规则：先全名、查到值就停，再裸名）", () => {
  const lib = [
    sk("docx", { scope: "synced", name: "anthropic-skills:docx" }),
    sk("pdf", { scope: "synced", name: "anthropic-skills:pdf" }),
    sk("pdf"), // 个人技能同名：裸键 pdf 是它的，但 CC 也会拿它去查同步 pdf
  ];
  const view = (overrides: Record<string, SkillState>) =>
    agentSkillView("claude-code", lib, { cwd: null, overrides, piEnv: {} }).rows.map((r) => [r.name, r.state]);
  /** 按 skillWrites 连续改几次，返回最后的表 */
  const run = (...steps: Step[]): Record<string, SkillState> =>
    steps.reduce((t, [k, st]) => skillTableOf(applySkillChanges({ skillOverrides: t }, skillWrites(k, st, lib, null, t))), {} as Record<string, SkillState>);

  test("视图：裸键 pdf=off 两个都关（与真 CC 一致）；钉了 anthropic-skills:pdf=on 的只关个人那个；手写裸名 docx 落在同步那一行", () => {
    expect(view({ pdf: "off" })).toEqual([["anthropic-skills:docx", "on"], ["anthropic-skills:pdf", "off"], ["pdf", "off"]]);
    expect(view({ pdf: "off", "anthropic-skills:pdf": "on" })).toEqual([["anthropic-skills:docx", "on"], ["anthropic-skills:pdf", "on"], ["pdf", "off"]]);
    expect(view({ docx: "off" })).toEqual([["anthropic-skills:docx", "off"], ["anthropic-skills:pdf", "on"], ["pdf", "on"]]);
    expect(view({ gone: "on" }).map(([n]) => n)).not.toContain("gone"); // 钉住用的 on 不成「已不存在」行
  });
  test("写入：关个人 pdf 时把同步 pdf 钉在 on；开回来就拿掉钉子", () => {
    expect(run(["pdf", "off"])).toEqual({ pdf: "off", "anthropic-skills:pdf": "on" });
    expect(run(["pdf", "off"], ["pdf", "on"])).toEqual({});
  });
  test("写入：同步 pdf 只写全名键；个人 pdf 关着时把同步 pdf 开回来要显式 on（不删个人的裸键）", () => {
    expect(run(["anthropic-skills:pdf", "off"])).toEqual({ "anthropic-skills:pdf": "off" });
    expect(run(["anthropic-skills:pdf", "off"], ["pdf", "off"])).toEqual({ "anthropic-skills:pdf": "off", pdf: "off" });
    expect(run(["anthropic-skills:pdf", "off"], ["pdf", "off"], ["anthropic-skills:pdf", "on"])).toEqual({ "anthropic-skills:pdf": "on", pdf: "off" });
    expect(run(["pdf", "off"], ["anthropic-skills:pdf", "off"], ["pdf", "on"])).toEqual({ "anthropic-skills:pdf": "off" });
  });
  test("每一步之后视图都和界面上点的一致", () => {
    const cases: Step[][] = [[["pdf", "off"]], [["anthropic-skills:pdf", "name-only"], ["pdf", "off"]], [["pdf", "off"], ["anthropic-skills:pdf", "off"], ["anthropic-skills:pdf", "on"]]];
    for (const steps of cases) {
      const want = new Map<string, string>([["anthropic-skills:docx", "on"], ["anthropic-skills:pdf", "on"], ["pdf", "on"]]);
      for (const [k, st] of steps) want.set(k, st);
      expect(view(run(...steps))).toEqual([...want.entries()].sort(([a], [b]) => a.localeCompare(b)));
    }
  });
  test("没有同名技能的同步技能：写全名键时把裸名旧写法一并删；CLI 手敲裸名也按同步技能写，不钉", () => {
    expect(skillWrites("anthropic-skills:docx", "off", lib, null, { docx: "off" })).toEqual({ docx: null, "anthropic-skills:docx": "off" });
    expect(skillWrites("docx", "off", lib, null, {})).toEqual({ docx: null, "anthropic-skills:docx": "off" });
    expect(skillWrites("gone", "off", lib, null, {})).toEqual({ gone: "off" }); // 技能库里没有的照原样写（界面上的 missing 行）
  });
  test("全局 / 项目设置里的开关标在对应行上；裸键也标在同步那一行（CC 会连带用它）", () => {
    const v = agentSkillView("claude-code", lib, {
      cwd: null, overrides: {}, piEnv: {},
      outside: [{ source: "user", overrides: { docx: "off" } }, { source: "local", overrides: { pdf: "name-only" } }],
    });
    expect(v.rows.find((r) => r.name === "anthropic-skills:docx")?.outside).toEqual([{ source: "user", key: "docx", state: "off" }]);
    expect(v.rows.find((r) => r.name === "pdf")?.outside).toEqual([{ source: "local", key: "pdf", state: "name-only" }]);
    expect(v.rows.find((r) => r.name === "anthropic-skills:pdf")?.outside).toEqual([{ source: "local", key: "pdf", state: "name-only" }]);
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
  test("档案里写的是 SKILL.md 文件也认；装着多个技能的父目录：显示开、单独关不掉", () => {
    expect(piSkillEntryMatches("/h/.pi/agent/skills/a/SKILL.md", { name: "a", dir: "/h/.pi/agent/skills/a" })).toBe(true);
    expect(piParentEntryFor(["/h/.agents/skills/"], { dir: "/h/.agents/skills/b" })).toBe("/h/.agents/skills/");
    const v = agentSkillView("pi", lib, { cwd: null, overrides: {}, piEnv: { base: "minimal", skills: ["/h/.agents/skills"] } });
    expect(v.rows.find((r) => r.name === "b")).toMatchObject({ state: "on", lockedBy: "/h/.agents/skills" });
    expect(v.rows.find((r) => r.name === "a")).toMatchObject({ state: "off" });
  });
  test("piSkillEntryMatches", () => {
    expect(piSkillEntryMatches("/h/.pi/agent/skills/a/", { name: "a", dir: "/h/.pi/agent/skills/a" })).toBe(true);
    expect(piSkillEntryMatches("/x/b", { name: "a", dir: "/h/a" })).toBe(false);
  });
});
