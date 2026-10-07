/**
 * BML-1：findJsonlBySessionId 的负缓存。没找到的 sessionId 60 秒内不再 readdir 全库。
 */
import { describe, test, expect, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findJsonlBySessionId, jsonlMissCacheSizeForTest } from "../src/lib/jsonl-cost.js";

const savedHome = process.env.HOME;
let dir = "";

function fakeHome(): string {
  dir = mkdtempSync(join(tmpdir(), "jsonl-miss-"));
  mkdirSync(join(dir, ".claude", "projects", "slug-a"), { recursive: true });
  process.env.HOME = dir;
  return join(dir, ".claude", "projects", "slug-a");
}

afterEach(() => {
  process.env.HOME = savedHome;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("findJsonlBySessionId 负缓存", () => {
  test("连调两次没找到：只 readdir 一次", () => {
    fakeHome();
    const spy = spyOn(fs, "readdirSync");
    try {
      const sid = `miss-${crypto.randomUUID()}`;
      expect(findJsonlBySessionId(sid, 1_000)).toBeNull();
      expect(findJsonlBySessionId(sid, 2_000)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("60 秒内文件出现也不重扫；过期后重扫找到", () => {
    const slugDir = fakeHome();
    const sid = `late-${crypto.randomUUID()}`;
    expect(findJsonlBySessionId(sid, 10_000)).toBeNull();
    writeFileSync(join(slugDir, `${sid}.jsonl`), "{}\n");
    expect(findJsonlBySessionId(sid, 69_999)).toBeNull();
    expect(findJsonlBySessionId(sid, 70_000)).toBe(join(slugDir, `${sid}.jsonl`));
  });

  test("60 秒内新建了项目目录（会话搬进新 worktree）：立刻重扫找到", () => {
    fakeHome();
    const sid = `moved-${crypto.randomUUID()}`;
    expect(findJsonlBySessionId(sid, 10_000)).toBeNull();
    const fresh = join(dir, ".claude", "projects", "slug-new");
    mkdirSync(fresh);
    utimesSync(join(dir, ".claude", "projects"), 1_900_000_000, 1_900_000_000); // mtime 精度兜底：确保与缓存时不同
    writeFileSync(join(fresh, `${sid}.jsonl`), "{}\n");
    expect(findJsonlBySessionId(sid, 10_001)).toBe(join(fresh, `${sid}.jsonl`));
  });

  test("找到的不进缓存", () => {
    const slugDir = fakeHome();
    const sid = `hit-${crypto.randomUUID()}`;
    writeFileSync(join(slugDir, `${sid}.jsonl`), "{}\n");
    expect(findJsonlBySessionId(sid, 1)).toBe(join(slugDir, `${sid}.jsonl`));
    rmSync(join(slugDir, `${sid}.jsonl`));
    expect(findJsonlBySessionId(sid, 2)).toBeNull();
  });

  test("条目按 TTL 清理，不随 sessionId 个数无界增长", () => {
    fakeHome();
    const t0 = Date.now() + 365 * 86_400_000; // 晚于同进程其他测试文件留下的条目，让它们一起过期
    for (let i = 0; i < 50; i++) findJsonlBySessionId(`bound-${i}-${crypto.randomUUID()}`, t0);
    expect(jsonlMissCacheSizeForTest()).toBeGreaterThanOrEqual(50);
    findJsonlBySessionId(`bound-late-${crypto.randomUUID()}`, t0 + 60_000);
    expect(jsonlMissCacheSizeForTest()).toBe(1);
  });

  test("readdir 抛错不进缓存：修好后立刻能找到", () => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-miss-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "projects"), "not a dir"); // readdirSync → ENOTDIR
    process.env.HOME = dir;
    const sid = `err-${crypto.randomUUID()}`;
    const before = jsonlMissCacheSizeForTest();
    expect(findJsonlBySessionId(sid, 5)).toBeNull();
    expect(jsonlMissCacheSizeForTest()).toBe(before);
    rmSync(join(dir, ".claude", "projects"));
    mkdirSync(join(dir, ".claude", "projects", "slug-b"), { recursive: true });
    writeFileSync(join(dir, ".claude", "projects", "slug-b", `${sid}.jsonl`), "{}\n");
    expect(findJsonlBySessionId(sid, 6)).toBe(join(dir, ".claude", "projects", "slug-b", `${sid}.jsonl`));
  });
});
