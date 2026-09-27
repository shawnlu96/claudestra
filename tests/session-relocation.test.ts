/**
 * Claude Code 的 EnterWorktree 会把会话文件整个挪进 worktree 的项目目录（记录里一条 relocated，2026-09-28 用
 * CC 2.1.281 实测），registry 的 cwd 还是原目录。projectJsonlPath 推算落空时要按 sessionId 找到新家，
 * 否则用量 / 历史 / 卡死判定 / 后台子 agent 全跟丢。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectJsonlPath, projectsSlug } from "../src/lib/jsonl-cost.js";
import { sessionFileMtime } from "../src/lib/session-source.js";

const home = mkdtempSync(join(tmpdir(), "reloc-home-"));
const realHome = process.env.HOME;
const SID = "372ff446-f6c4-4114-8f2c-334acc8be6ed";
const cwd = join(home, "repo");
const worktree = join(cwd, ".claude", "worktrees", "probe");
beforeAll(() => {
  mkdirSync(worktree, { recursive: true });
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("会话文件搬进 worktree 之后", () => {
  test("还没生成：返回原目录的推算路径（pending 等待照旧）", () => {
    expect(projectJsonlPath(cwd, SID)).toBe(join(home, ".claude", "projects", projectsSlug(cwd), `${SID}.jsonl`));
  });

  test("原目录没有、worktree 的项目目录里有：找到新家；mtime 也读新家的", async () => {
    const dir = join(home, ".claude", "projects", projectsSlug(worktree));
    mkdirSync(dir, { recursive: true });
    const moved = join(dir, `${SID}.jsonl`);
    writeFileSync(moved, '{"type":"relocated"}\n');
    utimesSync(moved, 1_790_000_000, 1_790_000_000);
    expect(projectJsonlPath(cwd, SID)).toBe(moved);
    expect(await sessionFileMtime(cwd, SID)).toBe(1_790_000_000_000);
  });

  test("原目录里有：优先原目录（没搬家的常态不多扫一遍）", () => {
    const dir = join(home, ".claude", "projects", projectsSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}.jsonl`), "{}\n");
    expect(projectJsonlPath(cwd, SID)).toBe(join(dir, `${SID}.jsonl`));
  });
});
