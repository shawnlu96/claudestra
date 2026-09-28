/**
 * 网页按版本发布（src/lib/web-releases.ts）：发布 = 复制进版本目录 + current 一步切换；失败不动线上；只留 current + 2 个旧版本；
 * 回滚退到上一个；旧 chunk 兜底只对 current 生效；install-cli 的迁移只改「直接指着 web/out」的 .env。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticSite } from "../src/bridge/web-gateway.js";
import {
  currentLink, currentRelease, fallbackStaticRoots, listReleases, migrateStaticDirToReleases, publishWebRelease, RELEASES_DIR, releasesManaged, rollbackWebRelease,
} from "../src/lib/web-releases.js";

let tmp: string;
let dir: string;
let out: string;
const at = (min: number) => new Date(Date.UTC(2026, 8, 28, 6, min, 0));

/** 造一份导出：index.html + 一个带版本标记的 chunk + build-info */
function build(tag: string, commit = "abc1234"): void {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "_next", "static", "chunks"), { recursive: true });
  writeFileSync(join(out, "index.html"), `<html>${tag}</html>`);
  writeFileSync(join(out, "_next", "static", "chunks", `${tag}.js`), `/*${tag}*/`);
  writeFileSync(join(out, "build-info.json"), JSON.stringify({ webCommit: commit }));
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "web-releases-"));
  dir = join(tmp, "web-releases");
  out = join(tmp, "repo", "web", "out");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("publishWebRelease", () => {
  test("复制进版本目录、current 是指向它的相对符号链接；再发布一次就切到新版本", () => {
    build("v1");
    const a = publishWebRelease(out, { dir, now: at(0) });
    expect(a.ok).toBe(true);
    expect(a.id).toMatch(/^2026-09-28T06-00-00-000Z_abc1234$/);
    expect(lstatSync(currentLink(dir)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(currentLink(dir))).toBe(a.id!);
    expect(readFileSync(join(currentLink(dir), "index.html"), "utf8")).toBe("<html>v1</html>");
    build("v2", "def5678");
    const b = publishWebRelease(out, { dir, now: at(1) });
    expect(currentRelease(dir)).toBe(b.id!);
    expect(readFileSync(join(currentLink(dir), "index.html"), "utf8")).toBe("<html>v2</html>");
    expect(listReleases(dir)).toEqual([b.id!, a.id!]);
  });
  test("没有 index.html 不发布，current 原样不动", () => {
    build("v1");
    const a = publishWebRelease(out, { dir, now: at(0) });
    rmSync(join(out, "index.html"));
    const b = publishWebRelease(out, { dir, now: at(1) });
    expect(b.ok).toBe(false);
    expect(currentRelease(dir)).toBe(a.id!);
    expect(listReleases(dir)).toEqual([a.id!]);
  });
  test("current 被人换成了真目录：拒绝覆盖，也不留半成品", () => {
    build("v1");
    mkdirSync(currentLink(dir), { recursive: true });
    const r = publishWebRelease(out, { dir, now: at(0) });
    expect(r.ok).toBe(false);
    expect(lstatSync(currentLink(dir)).isDirectory()).toBe(true);
    expect(existsSync(join(dir, ".staging-2026-09-28T06-00-00-000Z_abc1234"))).toBe(false);
  });
  test("只留 current + 2 个旧版本，更早的删掉", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      build(`v${i}`);
      ids.push(publishWebRelease(out, { dir, now: at(i) }).id!);
    }
    expect(listReleases(dir)).toEqual([ids[4], ids[3], ids[2]]);
  });
});

describe("回滚与旧 chunk 兜底", () => {
  test("rollback 退到上一个版本；没有更旧的就报错不动", () => {
    build("v1");
    const a = publishWebRelease(out, { dir, now: at(0) }).id!;
    expect(rollbackWebRelease(dir).ok).toBe(false);
    build("v2");
    const b = publishWebRelease(out, { dir, now: at(1) }).id!;
    expect(rollbackWebRelease(dir)).toEqual({ ok: true, from: b, to: a });
    expect(currentRelease(dir)).toBe(a);
  });
  test("旧页面要旧 chunk：current 里没有就从旧版本里给；HTML 和别的路径不兜底；不是 current 的目录不兜底", () => {
    build("v1");
    publishWebRelease(out, { dir, now: at(0) });
    build("v2");
    publishWebRelease(out, { dir, now: at(1) });
    const cur = currentLink(dir);
    expect(fallbackStaticRoots(cur, dir)).toHaveLength(1);
    expect(fallbackStaticRoots(out, dir)).toEqual([]);
    // serveStaticSite 用的是默认目录，这里直接验兜底目录里确实有旧 chunk、当前目录没有
    expect(existsSync(join(fallbackStaticRoots(cur, dir)[0]!, "_next/static/chunks/v1.js"))).toBe(true);
    expect(existsSync(join(cur, "_next/static/chunks/v1.js"))).toBe(false);
  });
  test("serveStaticSite 端到端（默认版本目录，测试 preload 已把状态目录换成临时的）：旧 chunk 200、当前页是新版、没有的仍 null", () => {
    try {
      build("v1");
      publishWebRelease(out, { now: at(0) });
      build("v2");
      publishWebRelease(out, { now: at(1) });
      const cur = currentLink();
      expect(serveStaticSite(cur, "/_next/static/chunks/v1.js")?.status).toBe(200);
      expect(serveStaticSite(cur, "/_next/static/chunks/v2.js")?.status).toBe(200);
      expect(serveStaticSite(cur, "/_next/static/chunks/never.js")).toBeNull();
      expect(serveStaticSite(cur, "/v1.js")).toBeNull(); // 兜底只限 /_next/static/
    } finally {
      rmSync(RELEASES_DIR, { recursive: true, force: true });
    }
  });
  test("serveStaticSite：不是版本目录时行为不变（缺的 chunk 仍是 null）", () => {
    build("v1");
    expect(serveStaticSite(out, "/_next/static/chunks/v1.js")?.status).toBe(200);
    expect(serveStaticSite(out, "/_next/static/chunks/gone.js")).toBeNull();
  });
});

describe("migrateStaticDirToReleases / releasesManaged", () => {
  const repo = () => join(tmp, "repo");
  test(".env 直接指着 web/out → 发布第一个版本、改指 current，其它行原样", () => {
    build("v1");
    const env = join(repo(), ".env");
    writeFileSync(env, `# keep\nFOO=1\nBRIDGE_STATIC_DIR=${out}\n`);
    const notes = migrateStaticDirToReleases(repo(), { envFile: env, dir });
    expect(notes).toHaveLength(1);
    expect(readFileSync(env, "utf8")).toBe(`# keep\nFOO=1\nBRIDGE_STATIC_DIR=${currentLink(dir)}\n`);
    expect(releasesManaged(env, dir)).toBe(true);
    expect(readFileSync(join(currentLink(dir), "index.html"), "utf8")).toBe("<html>v1</html>");
    expect(migrateStaticDirToReleases(repo(), { envFile: env, dir })).toEqual([]); // 再跑一次什么都不做
  });
  test("没托管 / 指向自定义目录 → 不动；发布失败 → .env 不改", () => {
    const env = join(repo(), ".env");
    mkdirSync(repo(), { recursive: true });
    writeFileSync(env, "FOO=1\n");
    expect(migrateStaticDirToReleases(repo(), { envFile: env, dir })).toEqual([]);
    writeFileSync(env, "BRIDGE_STATIC_DIR=/srv/custom\n");
    expect(migrateStaticDirToReleases(repo(), { envFile: env, dir })).toEqual([]);
    writeFileSync(env, `BRIDGE_STATIC_DIR=${out}\n`); // out 还没构建
    expect(migrateStaticDirToReleases(repo(), { envFile: env, dir })[0]).toContain("没改成");
    expect(readFileSync(env, "utf8")).toBe(`BRIDGE_STATIC_DIR=${out}\n`);
    expect(releasesManaged(env, dir)).toBe(false);
  });
});
