/**
 * 静态导出站点（Next `output: "export"` 的产物布局）的路径解析——中继托管前端、bridge 直托管都用它
 * （tests/static-site.test.ts）。导出布局不是「什么都回 index.html」：`/chat` 对应 `chat.html`，`/x/` 对应 `x/index.html`，
 * 资源文件缺了就是 404，未知页面回导出的 404.html（状态码也是 404）。缓存策略跟着路径走：`/_next/static/` 是内容哈希，
 * 永久缓存；HTML 永不长缓存（旧 HTML 指向旧 chunk 是「怎么刷都是旧版」的根因，见 web/next.config.ts）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

export interface StaticHit {
  /** 磁盘绝对路径 */
  path: string;
  status: 200 | 404;
  cacheControl: string;
}

/**
 * 托管前端 HTML 的 CSP（docs/design-hosted-frontend.md §8.7）：脚本只许同源文件 + 这份 HTML 自己的内联脚本哈希——Next 导出的每一页
 * 都带几段 `self.__next_f.push(...)` 启动脚本，不放哈希页面起不来；我们自己的脚本已全是外链（web/public/boot.js）。样式允许内联
 * （Tailwind 运行时注入的 style 属性 / daisyUI 主题），图片允许 data: / blob:（头像、附件的 object URL），worker 同源（SW），
 * 不许被嵌 iframe。中继与 bridge 直托管都经 staticResponse 发同一份；改这里要两边一起验。
 */
export function staticSiteCsp(scriptHashes: readonly string[] = []): string {
  return [
    "default-src 'self'", `script-src ${["'self'", ...scriptHashes].join(" ")}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "font-src 'self' data:", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'",
    "frame-ancestors 'none'", "form-action 'self'",
  ].join("; ");
}

const SCRIPT_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi;

/** HTML 里每段无 src 的内联 <script> 的 CSP 哈希源（'sha256-…'，去重、按出现顺序）；哈希盖的是标签之间的原文，一个空格都不能动 */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(SCRIPT_RE)) {
    if (m[1] && /\ssrc\s*=/i.test(m[1])) continue;
    out.add(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
  return [...out];
}

/** 按文件 size + mtime 缓存的派生值（HTML 的 CSP、bundle 的 build-info）：导出目录只在部署时整体替换，不必每次请求重读 */
function fileDerived<T>(cache: Map<string, { key: string; value: T }>, path: string, derive: (text: string) => T, fallback: T): T {
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return fallback; // 文件不在：调用方按「没有」处理（HTML 的话 Bun.file 自己会 404）
  }
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.value;
  let value: T;
  try {
    value = derive(readFileSync(path, "utf8"));
  } catch {
    return fallback; // 读失败 / 内容解析不了：同上，不缓存，下次再试
  }
  cache.set(path, { key, value });
  return value;
}

const cspCache = new Map<string, { key: string; value: string }>();

/** 这份导出 HTML 该带的 CSP（含它自己内联脚本的哈希） */
export function htmlCsp(path: string): string {
  return fileDerived(cspCache, path, (html) => staticSiteCsp(inlineScriptHashes(html)), staticSiteCsp());
}

export interface BuildInfo {
  commit?: string;
  webCommit?: string;
  version?: string;
}

const buildInfoCache = new Map<string, { key: string; value: BuildInfo | null }>();

/**
 * 托管方正在发的 bundle 的 build-info.json（web/scripts/gen-build-info.mjs 写进 public/，随导出进 web/out）：
 * /app-config.json 与 /api/v1/version 的 webCommit 从这里来，才是「前端有没有新版」的真值——拿托管方自己的 git HEAD 比，
 * 只改后端的提交也会让浏览器亮「新版本已就绪」（2026-08-15 / 09-27 两次假警）。没有这个文件就不带 webCommit。
 */
export function readBuildInfo(rootDir: string): BuildInfo | null {
  if (!rootDir) return null;
  return fileDerived(buildInfoCache, join(rootDir, "build-info.json"), (text) => {
    const o = JSON.parse(text) as Record<string, unknown>;
    const s = (k: keyof BuildInfo) => (typeof o[k] === "string" && o[k] ? { [k]: o[k] as string } : {});
    return { ...s("commit"), ...s("webCommit"), ...s("version") };
  }, null);
}

/** 命中的静态文件 → 响应：HTML 带按内容算的 CSP；一律 nosniff；HEAD 不带体 */
export function staticResponse(hit: StaticHit, method: string): Response {
  const file = Bun.file(hit.path);
  const headers: Record<string, string> = { "content-type": file.type, "cache-control": hit.cacheControl, "x-content-type-options": "nosniff" };
  if (hit.path.endsWith(".html")) headers["content-security-policy"] = htmlCsp(hit.path);
  return new Response(method === "HEAD" ? null : file, { status: hit.status, headers });
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

/** 解码一次并钉在根目录内；非法编码、../ 穿越 → null（中继与 bridge 的静态托管都经 resolveExportedPath 走这里） */
function safePathUnderRoot(rootDir: string, pathname: string): { root: string; rel: string } | null {
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
  if (pathname.endsWith(".html") || pathname === "/" || pathname === "/build-info.json") return CACHE_HTML; // build-info：部署后立刻要能看到新值
  return CACHE_ASSET;
}
