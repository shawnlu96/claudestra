/**
 * Next 静态导出布局（src/lib/static-site.ts）：路径解析（页面 → .html、目录 → index.html、资源缺失 404、未知页面 404.html、穿越拒）、
 * HTML 的 CSP 带内联脚本哈希、托管方读 bundle 的 build-info.json。
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_ASSET, CACHE_HTML, CACHE_IMMUTABLE, cachePolicy, htmlCsp, inlineScriptHashes, readBuildInfo, resolveExportedPath, staticResponse, staticSiteCsp,
} from "../src/lib/static-site.js";

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

const ROOT = "/srv/out";
const files = new Set([
  `${ROOT}/index.html`, `${ROOT}/chat.html`, `${ROOT}/pair.html`, `${ROOT}/404.html`, `${ROOT}/docs/index.html`,
  `${ROOT}/_next/static/chunks/app.js`, `${ROOT}/manifest.webmanifest`, `${ROOT}/sw.js`,
]);
const exists = (p: string) => files.has(p);
const at = (p: string) => resolveExportedPath(ROOT, p, exists);

describe("resolveExportedPath", () => {
  test("/ → index.html；/chat → chat.html；/docs/ 与 /docs → docs/index.html；都不长缓存", () => {
    expect(at("/")).toEqual({ path: `${ROOT}/index.html`, status: 200, cacheControl: CACHE_HTML });
    expect(at("/chat")).toMatchObject({ path: `${ROOT}/chat.html`, status: 200, cacheControl: CACHE_HTML });
    expect(at("/docs/")).toMatchObject({ path: `${ROOT}/docs/index.html` });
    expect(at("/docs")).toMatchObject({ path: `${ROOT}/docs/index.html` });
  });
  test("资源：_next/static 永久缓存；别的资源短缓存；缺失的资源是 null（不回 HTML）", () => {
    expect(at("/_next/static/chunks/app.js")).toMatchObject({ status: 200, cacheControl: CACHE_IMMUTABLE });
    expect(at("/sw.js")).toMatchObject({ cacheControl: CACHE_ASSET });
    expect(at("/_next/static/chunks/missing.js")).toBeNull();
    expect(at("/favicon.ico")).toBeNull();
  });
  test("未知页面 → 404.html 且状态 404；没有 404.html 就 null", () => {
    expect(at("/nope")).toEqual({ path: `${ROOT}/404.html`, status: 404, cacheControl: CACHE_HTML });
    expect(resolveExportedPath(ROOT, "/nope", (p) => p === `${ROOT}/index.html`)).toBeNull();
  });
  test("穿越、非法编码、空根目录", () => {
    expect(at("/../etc/passwd")).toBeNull();
    expect(at("/%2e%2e/etc/passwd")).toBeNull();
    expect(at("/%zz")).toBeNull();
    expect(resolveExportedPath("", "/")).toBeNull();
  });
  test("cachePolicy", () => {
    expect(cachePolicy("/_next/static/x.js")).toBe(CACHE_IMMUTABLE);
    expect(cachePolicy("/chat.html")).toBe(CACHE_HTML);
    expect(cachePolicy("/icon.png")).toBe(CACHE_ASSET);
    expect(cachePolicy("/build-info.json")).toBe(CACHE_HTML);
  });
});

describe("CSP：内联脚本哈希", () => {
  test("无 src 的 <script> 逐个 sha256、去重；带 src 的、大小写 / 属性 / 多行都认；哈希盖原文不 trim", () => {
    const html = [
      `<script src="/_next/static/a.js" async=""></script>`, `<script>(self.__next_f=self.__next_f||[]).push([0])</script>`,
      `<SCRIPT type="module">\n  boot()\n</SCRIPT>`, `<script>(self.__next_f=self.__next_f||[]).push([0])</script>`, `<script src=/boot.js></script>`,
    ].join("\n");
    expect(inlineScriptHashes(html)).toEqual([sha("(self.__next_f=self.__next_f||[]).push([0])"), sha("\n  boot()\n")]);
    expect(inlineScriptHashes("<html>no scripts</html>")).toEqual([]);
  });
  test("staticSiteCsp：哈希追加在 script-src 'self' 后；其余指令不变", () => {
    expect(staticSiteCsp()).toContain("script-src 'self'; style-src");
    expect(staticSiteCsp([sha("x")])).toContain(`script-src 'self' ${sha("x")}; style-src`);
    for (const d of ["default-src 'self'", "connect-src 'self' blob: http://127.0.0.1:*", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      expect(staticSiteCsp()).toContain(d);
    }
  });
  test("htmlCsp / staticResponse 读真文件：HTML 带哈希，改文件后重算；资源不带 CSP、一律 nosniff", async () => {
    const root = mkdtempSync(join(tmpdir(), "static-csp-"));
    const page = join(root, "chat.html");
    writeFileSync(page, `<html><script>alert(1)</script></html>`);
    expect(htmlCsp(page)).toBe(staticSiteCsp([sha("alert(1)")]));
    const res = staticResponse({ path: page, status: 200, cacheControl: CACHE_HTML }, "GET");
    expect(res.headers.get("content-security-policy")).toBe(staticSiteCsp([sha("alert(1)")]));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain("alert(1)");
    writeFileSync(page, `<html><script>alert(2)</script>${" ".repeat(8)}</html>`); // 长度变了 → 缓存键变 → 重算
    expect(htmlCsp(page)).toBe(staticSiteCsp([sha("alert(2)")]));
    expect(htmlCsp(join(root, "missing.html"))).toBe(staticSiteCsp());
    const js = join(root, "a.js");
    writeFileSync(js, "1");
    const head = staticResponse({ path: js, status: 200, cacheControl: CACHE_IMMUTABLE }, "HEAD");
    expect(head.headers.get("content-security-policy")).toBeNull();
    expect(head.headers.get("cache-control")).toBe(CACHE_IMMUTABLE);
    expect(head.body).toBeNull();
  });
});

describe("readBuildInfo", () => {
  test("读 <root>/build-info.json 的字符串字段；空串、非字符串丢掉；没文件 / 坏 JSON / 空根 → null", () => {
    const root = mkdtempSync(join(tmpdir(), "static-bi-"));
    expect(readBuildInfo(root)).toBeNull();
    expect(readBuildInfo("")).toBeNull();
    writeFileSync(join(root, "build-info.json"), JSON.stringify({ commit: "abc1234", webCommit: "", version: 7 }));
    expect(readBuildInfo(root)).toEqual({ commit: "abc1234" });
    writeFileSync(join(root, "build-info.json"), JSON.stringify({ commit: "abc1234", webCommit: "def5678", version: "2.29.0" }) + "\n");
    expect(readBuildInfo(root)).toEqual({ commit: "abc1234", webCommit: "def5678", version: "2.29.0" });
    writeFileSync(join(root, "build-info.json"), "{not json");
    expect(readBuildInfo(root)).toBeNull();
  });
});
