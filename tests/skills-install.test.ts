/**
 * v2.21.3+ 仓库 skill → ~/.claude/skills 安装/体检:缺失建软链、悬空重指、
 * 指向本仓库保留、指向别处不动、真目录按内容比对不覆盖。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, lstatSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installRepoSkill, installRepoSkills, listRepoSkills } from "../src/lib/skills-install.js";

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "skrepo-"));
  mkdirSync(join(repo, "skills", "save-compact"), { recursive: true });
  writeFileSync(join(repo, "skills", "save-compact", "SKILL.md"), "# save-compact v2\n");
  mkdirSync(join(repo, "skills", ".hidden"), { recursive: true }); // 无 SKILL.md,忽略
  return repo;
}
function mkHome(): string {
  return mkdtempSync(join(tmpdir(), "skhome-"));
}

describe("skills-install", () => {
  test("listRepoSkills 只认带 SKILL.md 的子目录", () => {
    expect(listRepoSkills(mkRepo())).toEqual(["save-compact"]);
    expect(listRepoSkills(mkdtempSync(join(tmpdir(), "empty-")))).toEqual([]);
  });

  test("缺失 → 建软链;再跑一次 → ok(幂等)", () => {
    const repo = mkRepo(), home = mkHome();
    const r1 = installRepoSkill(repo, "save-compact", { home });
    expect(r1.action).toBe("linked");
    const dst = join(home, ".claude", "skills", "save-compact");
    expect(lstatSync(dst).isSymbolicLink()).toBe(true);
    expect(installRepoSkill(repo, "save-compact", { home }).action).toBe("ok");
  });

  test("apply=false 只体检不动文件", () => {
    const repo = mkRepo(), home = mkHome();
    const r = installRepoSkill(repo, "save-compact", { home, apply: false });
    expect(r.action).toBe("warn");
    expect(() => lstatSync(join(home, ".claude", "skills", "save-compact"))).toThrow();
  });

  test("悬空软链(MacBook 案例:仓库还没有 skills/)→ 重指向本仓库", () => {
    const repo = mkRepo(), home = mkHome();
    const skillsDir = join(home, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const dst = join(skillsDir, "save-compact");
    symlinkSync("/nonexistent/repo/skills/save-compact", dst);
    expect(installRepoSkill(repo, "save-compact", { home, apply: false }).action).toBe("warn");
    const r = installRepoSkill(repo, "save-compact", { home });
    expect(r.action).toBe("relinked");
    expect(readlinkSync(dst)).toBe(join(repo, "skills", "save-compact"));
  });

  test("软链指向另一份存在的目录 → 不动,warn", () => {
    const repo = mkRepo(), home = mkHome();
    const other = mkRepo();
    const skillsDir = join(home, ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    const dst = join(skillsDir, "save-compact");
    symlinkSync(join(other, "skills", "save-compact"), dst);
    const r = installRepoSkill(repo, "save-compact", { home });
    expect(r.action).toBe("warn");
    expect(readlinkSync(dst)).toBe(join(other, "skills", "save-compact"));
  });

  test("真目录:内容一致 → ok;不一致 → warn 且不覆盖", () => {
    const repo = mkRepo(), home = mkHome();
    const dst = join(home, ".claude", "skills", "save-compact");
    mkdirSync(dst, { recursive: true });
    writeFileSync(join(dst, "SKILL.md"), "# save-compact v2\n");
    expect(installRepoSkill(repo, "save-compact", { home }).action).toBe("ok");
    writeFileSync(join(dst, "SKILL.md"), "# save-compact v1 (stale copy)\n");
    const r = installRepoSkill(repo, "save-compact", { home });
    expect(r.action).toBe("warn");
    expect(lstatSync(dst).isDirectory()).toBe(true);
  });

  test("installRepoSkills 覆盖全部仓库 skill", () => {
    const repo = mkRepo(), home = mkHome();
    expect(installRepoSkills(repo, { home }).map((r) => [r.name, r.action])).toEqual([["save-compact", "linked"]]);
  });
});
