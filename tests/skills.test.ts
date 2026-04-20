/**
 * Skill 发现 + slash-registry 单测
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { toDiscordName, discoverProjectSkills, NATIVE_SKILLS } from "../src/lib/skills.js";

describe("toDiscordName", () => {
  test("普通 skill 名保持不变", () => {
    expect(toDiscordName("find-alipan")).toBe("find-alipan");
  });

  test("`:` 映射成 `-`", () => {
    expect(toDiscordName("discord:access")).toBe("discord-access");
  });

  test("大写变小写", () => {
    expect(toDiscordName("MySkill")).toBe("myskill");
  });

  test("超 32 字符截断", () => {
    const long = "a-very-long-skill-name-that-exceeds-thirty-two-chars";
    const res = toDiscordName(long);
    expect(res.length).toBeLessThanOrEqual(32);
  });

  test("非法字符被移除", () => {
    expect(toDiscordName("foo.bar@baz")).toBe("foobarbaz");
  });
});

describe("NATIVE_SKILLS", () => {
  test("含 7 个 CC bundled skill", () => {
    const names = NATIVE_SKILLS.map((s) => s.invokeName).sort();
    expect(names).toContain("batch");
    expect(names).toContain("simplify");
    expect(names).toContain("loop");
    expect(names).toContain("claude-api");
    expect(names.length).toBe(7);
  });

  test("每个 native skill 的 discordName 合法", () => {
    for (const s of NATIVE_SKILLS) {
      expect(s.discordName).toMatch(/^[a-z0-9_-]{1,32}$/);
    }
  });
});

describe("discoverProjectSkills", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "skills-test-"));
    // 构造一个带 SKILL.md 的假项目
    const skillDir = join(tmpDir, ".claude", "skills", "my-project-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: my-project-skill",
        "description: A test skill for the project.",
        "user-invocable: true",
        "---",
        "",
        "# body",
      ].join("\n")
    );
    // 再加一个 user-invocable: false 的（不应被发现）
    const skillDir2 = join(tmpDir, ".claude", "skills", "auto-only");
    mkdirSync(skillDir2, { recursive: true });
    writeFileSync(
      join(skillDir2, "SKILL.md"),
      [
        "---",
        "name: auto-only",
        "description: Auto-triggered only.",
        "---",
        "body",
      ].join("\n")
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("扫 cwd/.claude/skills 拿到 user-invocable skill", async () => {
    const res = await discoverProjectSkills("test-agent", tmpDir);
    expect(res.length).toBe(1);
    expect(res[0].invokeName).toBe("my-project-skill");
    expect(res[0].scope).toBe("project");
    expect(res[0].agentName).toBe("test-agent");
  });

  test("跳过 user-invocable=false 的 skill", async () => {
    const res = await discoverProjectSkills("test-agent", tmpDir);
    expect(res.find((s) => s.invokeName === "auto-only")).toBeUndefined();
  });

  test("项目无 .claude/skills 返回空数组", async () => {
    const empty = mkdtempSync(join(tmpdir(), "skills-empty-"));
    try {
      const res = await discoverProjectSkills("foo", empty);
      expect(res).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
