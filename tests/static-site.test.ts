/** Next 静态导出布局的路径解析（src/lib/static-site.ts）：页面 → .html、目录 → index.html、资源缺失 404、未知页面 404.html、穿越拒 */
import { describe, expect, test } from "bun:test";
import { CACHE_ASSET, CACHE_HTML, CACHE_IMMUTABLE, cachePolicy, resolveExportedPath } from "../src/lib/static-site.js";

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
  });
});
