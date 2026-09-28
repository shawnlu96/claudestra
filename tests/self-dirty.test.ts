/**
 * lib/self-dirty.ts：自动更新前，只把「我们自己的安装改写的锁文件」当成可还原的改动（He 的机器 2026-09-28 因
 * web/package-lock.json 被 npm install 改写而永久卡在中间版本、App 白屏）；别的改动照旧阻塞。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { healSelfDirty, selfInflictedOnly } from "../src/lib/self-dirty";

describe("selfInflictedOnly", () => {
  test("只有 web/package-lock.json 被修改（含第一行被 trim 的情况）→ 可还原", () => {
    expect(selfInflictedOnly(" M web/package-lock.json\n")).toEqual(["web/package-lock.json"]);
    expect(selfInflictedOnly("M web/package-lock.json")).toEqual(["web/package-lock.json"]);
    expect(selfInflictedOnly("MM web/package-lock.json")).toEqual(["web/package-lock.json"]);
  });
  test("还有别的改动 / 是新增或删除 / 未跟踪 / 干净 → null（照旧阻塞）", () => {
    expect(selfInflictedOnly(" M web/package-lock.json\n M src/bridge.ts")).toBeNull();
    expect(selfInflictedOnly(" D web/package-lock.json")).toBeNull();
    expect(selfInflictedOnly("?? web/package-lock.json")).toBeNull();
    expect(selfInflictedOnly(" M package-lock.json")).toBeNull();
    expect(selfInflictedOnly("")).toBeNull();
  });
});

describe("healSelfDirty（真 git 仓库）", () => {
  const dir = mkdtempSync(join(tmpdir(), "self-dirty-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(dir, "web"));
  writeFileSync(join(dir, "web/package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  test("只有锁文件被改写：还原成提交版本，返回空（可以继续更新）", () => {
    writeFileSync(join(dir, "web/package-lock.json"), '{"lockfileVersion":3,"peer":true}\n');
    const out = healSelfDirty(dir, git("status", "--porcelain").stdout);
    expect(out).toBe("");
    expect(readFileSync(join(dir, "web/package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}\n');
    expect(git("status", "--porcelain").stdout).toBe("");
  });

  test("同时有别的改动：什么都不动，原样返回（照旧阻塞上报）", () => {
    writeFileSync(join(dir, "web/package-lock.json"), '{"changed":1}\n');
    writeFileSync(join(dir, "README.md"), "user edit\n");
    const porcelain = git("status", "--porcelain").stdout;
    expect(healSelfDirty(dir, porcelain)).toBe(porcelain);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("user edit\n");
    expect(readFileSync(join(dir, "web/package-lock.json"), "utf8")).toBe('{"changed":1}\n');
  });
});
