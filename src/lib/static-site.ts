/**
 * 静态导出站点（Next `output: "export"` 的产物布局）的路径解析——中继托管前端、bridge 直托管都用它
 * （tests/static-site.test.ts）。导出布局不是「什么都回 index.html」：`/chat` 对应 `chat.html`，`/x/` 对应 `x/index.html`，
 * 资源文件缺了就是 404，未知页面回导出的 404.html（状态码也是 404）。缓存策略跟着路径走：`/_next/static/` 是内容哈希，
 * 永久缓存；HTML 永不长缓存（旧 HTML 指向旧 chunk 是「怎么刷都是旧版」的根因，见 web/next.config.ts）。
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

export interface StaticHit {
  /** 磁盘绝对路径 */
  path: string;
  status: 200 | 404;
  cacheControl: string;
}

export const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
export const CACHE_HTML = "no-cache, must-revalidate";
export const CACHE_ASSET = "public, max-age=600";

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false; // 读不到就当没有：调用方 404
  }
}

/** 解码一次并钉在根目录内；非法编码、../ 穿越 → null。bridge 的静态托管（web-gateway.ts）与这里共用 */
export function safePathUnderRoot(rootDir: string, pathname: string): { root: string; rel: string } | null {
  if (!rootDir) return null;
  const root = resolve(rootDir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // 非法 %-编码
  }
  const abs = normalize(join(root, rel));
  return abs === root || abs.startsWith(`${root}/`) ? { root, rel } : null;
}

/** 路径 → 导出布局里的文件（页面 → .html、目录 → index.html、未知页面 → 404.html）；穿越、非法编码 → null */
export function resolveExportedPath(rootDir: string, pathname: string, fileExists: (p: string) => boolean = isFile): StaticHit | null {
  const safe = safePathUnderRoot(rootDir, pathname);
  if (!safe) return null; // 穿越：直接拒，连 404 页都不给
  const { root, rel } = safe;
  const hit = (p: string, status: 200 | 404 = 200): StaticHit | null => {
    const abs = normalize(join(root, p)); // rel 已钉在根内，追加 .html / index.html / 404.html 不会再出去
    return fileExists(abs) ? { path: abs, status, cacheControl: cachePolicy(p) } : null;
  };
  if (rel.endsWith("/")) return hit(`${rel}index.html`) ?? notFound(hit);
  const last = rel.split("/").pop() ?? "";
  if (last.includes(".")) return hit(rel); // 资源文件：缺了就是 404，不能回 HTML 造成 MIME 错误
  return hit(rel) ?? hit(`${rel}.html`) ?? hit(`${rel}/index.html`) ?? notFound(hit);
}

function notFound(hit: (p: string, status?: 200 | 404) => StaticHit | null): StaticHit | null {
  return hit("/404.html", 404);
}

export function cachePolicy(pathname: string): string {
  if (pathname.startsWith("/_next/static/")) return CACHE_IMMUTABLE;
  if (pathname.endsWith(".html") || pathname === "/") return CACHE_HTML;
  return CACHE_ASSET;
}
