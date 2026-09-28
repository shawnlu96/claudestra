/**
 * 网页按版本发布（src/lib/web-releases.ts）：发布 = 复制进版本目录 + current 一步切换；失败不动线上；只留 current + 2 个旧版本；
 * 回滚退到上一个；并发发布串行；请求开始时钉住版本（CSP 与正文不跨版本）；旧 chunk 兜底；
 * 发布失败记「待发布」下次补；install-cli 的迁移只改「直接指着 web/out」的 .env。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStaticSite } from "../src/bridge/web-gateway.js";
import { inlineScriptHashes } from "../src/lib/static-site.js";
import { publishWebOut, rollbackWebOut } from "../src/lib/web-build.js";
import { STATE_DIR } from "../src/lib/paths.js";
import {
  currentLink, currentRelease, fallbackStaticRoots, hasPendingPublish, listReleases, markPendingPublish, migrateStaticDirToReleases, pinnedStaticRoot,
  publishWebRelease, RELEASES_DIR, releasesManaged, rollbackWebRelease,
} from "../src/lib/web-releases.js";

let tmp: string;
let dir: string;
let out: string;
const at = (min: number) => new Date(Date.UTC(2026, 8, 28, 6, min, 0));

/** 造一份导出：index.html（带一段内联脚本，CSP 哈希随版本变）+ 一个带版本标记的 chunk + build-info */
function build(tag: string, commit = "abc1234"): void {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "_next", "static", "chunks"), { recursive: true });
  writeFileSync(join(out, "index.html"), `<html><script>boot("${tag}")</script></html>`);
  writeFileSync(join(out, "_next", "static", "chunks", `${tag}.js`), `/*${tag}*/`);
  writeFileSync(join(out, "build-info.json"), JSON.stringify({ webCommit: commit }));
}
const html = (tag: string) => `<html><script>boot("${tag}")</script></html>`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "web-releases-"));
  dir = join(tmp, "web-releases");
  out = join(tmp, "repo", "web", "out");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(RELEASES_DIR, { recursive: true, force: true }); // 默认目录在 preload 换成的临时状态目录里
});

describe("publishWebRelease", () => {
  test("复制进版本目录、current 是指向它的相对符号链接；再发布一次就切到新版本", async () => {
    build("v1");
    const a = await publishWebRelease(out, { dir, now: at(0) });
    expect(a.ok).toBe(true);
    expect(a.id).toBe("2026-09-28T06-00-00-000Z_abc1234");
    expect(lstatSync(currentLink(dir)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(currentLink(dir))).toBe(a.id!);
    expect(readFileSync(join(currentLink(dir), "index.html"), "utf8")).toBe(html("v1"));
    build("v2", "def5678");
    const b = await publishWebRelease(out, { dir, now: at(1) });
    expect(currentRelease(dir)).toBe(b.id!);
    expect(readFileSync(join(currentLink(dir), "index.html"), "utf8")).toBe(html("v2"));
    expect(listReleases(dir)).toEqual([b.id!, a.id!]);
  });
  test("没有 index.html 不发布，current 原样不动", async () => {
    build("v1");
    const a = await publishWebRelease(out, { dir, now: at(0) });
    rmSync(join(out, "index.html"));
    const b = await publishWebRelease(out, { dir, now: at(1) });
    expect(b.ok).toBe(false);
    expect(currentRelease(dir)).toBe(a.id!);
    expect(listReleases(dir)).toEqual([a.id!]);
  });
  test("current 被人换成了真目录：拒绝覆盖，也不留半成品", async () => {
    build("v1");
    mkdirSync(currentLink(dir), { recursive: true });
    const r = await publishWebRelease(out, { dir, now: at(0) });
    expect(r.ok).toBe(false);
    expect(lstatSync(currentLink(dir)).isDirectory()).toBe(true);
    expect(readdirSync(dir).filter((n) => n.startsWith(".staging-"))).toEqual([]);
  });
  test("只留 current + 2 个旧版本，更早的删掉", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      build(`v${i}`);
      ids.push((await publishWebRelease(out, { dir, now: at(i) })).id!);
    }
    expect(listReleases(dir)).toEqual([ids[4], ids[3], ids[2]]);
  });
});

describe("回滚、钉版本与旧 chunk 兜底", () => {
  test("rollback 退到上一个版本；没有更旧的就报错不动", async () => {
    build("v1");
    const a = (await publishWebRelease(out, { dir, now: at(0) })).id!;
    expect((await rollbackWebRelease(dir)).ok).toBe(false);
    build("v2");
    const b = (await publishWebRelease(out, { dir, now: at(1) })).id!;
    expect(await rollbackWebRelease(dir)).toEqual({ ok: true, from: b, to: a });
    expect(currentRelease(dir)).toBe(a);
  });
  test("pinnedStaticRoot：current → 具体版本目录；别的目录原样；fallback 只列除自己以外的版本", async () => {
    build("v1");
    const a = (await publishWebRelease(out, { dir, now: at(0) })).id!;
    build("v2");
    const b = (await publishWebRelease(out, { dir, now: at(1) })).id!;
    expect(pinnedStaticRoot(currentLink(dir), dir)).toBe(join(dir, b));
    expect(pinnedStaticRoot(out, dir)).toBe(out);
    expect(fallbackStaticRoots(join(dir, b), dir)).toEqual([join(dir, a)]);
    expect(fallbackStaticRoots(out, dir)).toEqual([]);
  });
  test("响应生成后切换版本：正文与 CSP 仍来自同一版本（codex 复核的复现）", async () => {
    build("old");
    await publishWebRelease(out, { now: at(0) });
    const res = serveStaticSite(currentLink(), "/")!;
    build("new");
    await publishWebRelease(out, { now: at(1) });
    const body = await res.text();
    expect(body).toBe(html("old"));
    const csp = res.headers.get("content-security-policy")!;
    for (const h of inlineScriptHashes(body)) expect(csp).toContain(h); // 正文里的内联脚本都被这份 CSP 放行
    const hash = inlineScriptHashes(body)[0]!;
    const fresh = serveStaticSite(currentLink(), "/")!;
    expect(await fresh.text()).toBe(html("new"));
    expect(fresh.headers.get("content-security-policy")).not.toContain(hash); // 新页面的哈希不同，旧响应带的是旧哈希
  });
  test("serveStaticSite 端到端：旧 chunk 200、没有的仍 null、兜底只限 /_next/static/", async () => {
    build("v1");
    writeFileSync(join(out, "old-only.txt"), "v1 only");
    await publishWebRelease(out, { now: at(0) });
    build("v2");
    await publishWebRelease(out, { now: at(1) });
    const cur = currentLink();
    expect(serveStaticSite(cur, "/_next/static/chunks/v1.js")?.status).toBe(200);
    expect(serveStaticSite(cur, "/_next/static/chunks/v2.js")?.status).toBe(200);
    expect(serveStaticSite(cur, "/_next/static/chunks/never.js")).toBeNull();
    expect(serveStaticSite(cur, "/v1.js")).toBeNull();
    expect(serveStaticSite(cur, "/_next/static/../../../../etc/passwd")).toBeNull();
    // 编码的 ../ 在旧版本根内绕出 _next/static（想拿只有旧版本才有的文件）：兜底不给
    expect(serveStaticSite(cur, "/_next/static/%2e%2e/%2e%2e/old-only.txt")).toBeNull();
    // 同样的绕法落到当前版本的 HTML：照旧能取到（站点根内），但不再拿永久缓存
    expect(serveStaticSite(cur, "/_next/static/%2e%2e/%2e%2e/index.html")?.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });
  test("不是版本目录时行为不变（缺的 chunk 仍是 null）", () => {
    build("v1");
    expect(serveStaticSite(out, "/_next/static/chunks/v1.js")?.status).toBe(200);
    expect(serveStaticSite(out, "/_next/static/chunks/gone.js")).toBeNull();
  });
});

describe("待发布与迁移", () => {
  const repo = () => join(tmp, "repo");
  test("publishWebOut：已按版本托管时发布失败记待发布，下次成功清掉", async () => {
    mkdirSync(join(repo(), "web"), { recursive: true });
    writeFileSync(join(repo(), ".env"), `BRIDGE_STATIC_DIR=${currentLink()}\n`);
    const bad = await publishWebOut(repo()); // out 还没构建
    expect(bad.ok).toBe(false);
    expect(hasPendingPublish()).toBe(true);
    build("v1");
    expect((await publishWebOut(repo())).ok).toBe(true);
    expect(hasPendingPublish()).toBe(false);
  });
  test("发布失败 → 回滚 → 下一次补发布不会把失败的候选顶上去（回滚在同一把锁下取消待发布）", async () => {
    mkdirSync(join(repo(), "web"), { recursive: true });
    writeFileSync(join(repo(), ".env"), `BRIDGE_STATIC_DIR=${currentLink()}\n`);
    build("v1");
    await publishWebOut(repo());
    build("v2");
    const good = (await publishWebOut(repo())).id!;
    build("v3-candidate");
    markPendingPublish("磁盘满（模拟 v3 构建成功但发布失败）");
    const r = await rollbackWebOut();
    expect(r.ok).toBe(true);
    expect(hasPendingPublish()).toBe(false);
    const retry = await publishWebOut(repo(), { onlyIfPending: true });
    expect(retry.skipped).toBeTruthy();
    expect(currentRelease()).not.toBe(good); // 仍停在回滚到的 v1
    expect(readFileSync(join(currentLink(), "index.html"), "utf8")).toBe(html("v1"));
  });
  test("构建锁被别的构建进程持有时：发布与回滚都直接失败，current 不动", async () => {
    mkdirSync(join(repo(), "web"), { recursive: true });
    build("v1");
    const lock = join(STATE_DIR, "web-build.lock");
    writeFileSync(lock, String(process.pid)); // 本进程就是 bun：按「持有者还在构建」对待
    try {
      expect((await publishWebOut(repo())).ok).toBe(false);
      expect((await rollbackWebOut()).ok).toBe(false);
      expect(existsSync(currentLink())).toBe(false);
    } finally {
      rmSync(lock, { force: true });
    }
  });
  test(".env 直接指着 web/out → 发布第一个版本、改指 current，其它行原样；再跑不动", async () => {
    build("v1");
    const env = join(repo(), ".env");
    writeFileSync(env, `# keep\nFOO=1\nBRIDGE_STATIC_DIR=${out}\n`);
    const publish = async () => publishWebRelease(out, { dir, now: at(0) });
    expect(await migrateStaticDirToReleases(repo(), publish, { envFile: env, dir })).toHaveLength(1);
    expect(readFileSync(env, "utf8")).toBe(`# keep\nFOO=1\nBRIDGE_STATIC_DIR=${currentLink(dir)}\n`);
    expect(releasesManaged(env, dir)).toBe(true);
    expect(readFileSync(join(currentLink(dir), "index.html"), "utf8")).toBe(html("v1"));
    expect(await migrateStaticDirToReleases(repo(), publish, { envFile: env, dir })).toEqual([]);
  });
  test("相对路径按 .env 所在目录解释（不看当前 cwd）；.env 权限保留", async () => {
    build("v1");
    const env = join(repo(), ".env");
    writeFileSync(env, "BRIDGE_STATIC_DIR=web/out\n", { mode: 0o600 });
    const publish = async () => publishWebRelease(out, { dir, now: at(0) });
    expect(await migrateStaticDirToReleases(repo(), publish, { envFile: env, dir })).toHaveLength(1);
    expect(readFileSync(env, "utf8")).toBe(`BRIDGE_STATIC_DIR=${currentLink(dir)}\n`);
    expect(lstatSync(env).mode & 0o777).toBe(0o600);
  });
  test("没托管 / 指向自定义目录 → 不动；发布失败 → .env 不改", async () => {
    const env = join(repo(), ".env");
    mkdirSync(repo(), { recursive: true });
    const publish = async () => publishWebRelease(out, { dir, now: at(0) });
    writeFileSync(env, "FOO=1\n");
    expect(await migrateStaticDirToReleases(repo(), publish, { envFile: env, dir })).toEqual([]);
    writeFileSync(env, "BRIDGE_STATIC_DIR=/srv/custom\n");
    expect(await migrateStaticDirToReleases(repo(), publish, { envFile: env, dir })).toEqual([]);
    writeFileSync(env, `BRIDGE_STATIC_DIR=${out}\n`); // out 还没构建
    expect((await migrateStaticDirToReleases(repo(), publish, { envFile: env, dir }))[0]).toContain("没改成");
    expect(readFileSync(env, "utf8")).toBe(`BRIDGE_STATIC_DIR=${out}\n`);
    expect(existsSync(currentLink(dir))).toBe(false);
  });
});
