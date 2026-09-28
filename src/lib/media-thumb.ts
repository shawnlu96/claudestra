/**
 * 媒体缩略图 / 显示版：用 macOS 自带的 sips 转 JPEG 并缓存。
 * 为什么在服务端做：原图多是 3~5MB 的手机照片，走中继的手机端拉一屏网格就是上百 MB；HEIC 在 Chrome 里根本显示不了，sips 顺手转掉。
 * 非 macOS 或 sips 失败 → 返回 null，调用方退回原图。同时最多跑 MAX_JOBS 个 sips、最多排 MAX_QUEUE 个，
 * 排满返回 "busy"（调用方回 503），免得有人批量请求把 CPU 和内存打满。
 * 缓存文件名 = 媒体 id + 定位串哈希：同一个 id 以后解析到别的文件（索引重建）不会拿到旧图；总大小超过上限按最久未访问清理。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";

export type Variant = "thumb" | "display";
const EDGE: Record<Variant, number> = { thumb: 360, display: 2560 };
const MAX_JOBS = 2;
const MAX_QUEUE = 24;
const SIPS = "/usr/bin/sips";
/** 缓存总量上限；每转出 PRUNE_EVERY 张检查一次 */
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const PRUNE_EVERY = 40;
/** sips 认不了 / 转了没意义的：SVG 原样出（带 CSP），GIF 动图缩略图会丢动画但网格里可以接受 */
const SKIP_EXT = new Set(["svg"]);

let running = 0;
const waiters: (() => void)[] = [];
const inflight = new Map<string, Promise<string | null>>();
let converted = 0;

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_JOBS) await new Promise<void>((r) => waiters.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

function canConvert(name: string): boolean {
  return process.platform === "darwin" && existsSync(SIPS) && !SKIP_EXT.has(name.split(".").pop()?.toLowerCase() || "");
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* 已经不在了（并发清理 / sips 没写出临时文件）：目的就是让它不在 */
  }
}

async function runSips(src: string, out: string, edge: number): Promise<boolean> {
  const tmp = `${out}.${process.pid}.tmp.jpg`;
  const p = Bun.spawn([SIPS, "-Z", String(edge), "-s", "format", "jpeg", "-s", "formatOptions", "72", src, "--out", tmp], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code === 0 && existsSync(tmp)) {
    renameSync(tmp, out); // 先写临时名再改名：并发读者永远看不到半截文件
    return true;
  }
  console.warn(`[media-thumb] sips 转换失败 code=${code}: ${(await new Response(p.stderr).text()).trim().slice(0, 200)}`);
  tryUnlink(tmp);
  return false;
}

/** 缓存超过上限就按访问时间从旧到新删，删到上限的八成 */
export function pruneThumbs(dir: string, maxBytes = MAX_CACHE_BYTES): void {
  let files: { path: string; size: number; at: number }[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jpg")).map((f) => {
      const st = statSync(join(dir, f));
      return { path: join(dir, f), size: st.size, at: st.atimeMs };
    });
  } catch {
    return; // 目录还没建 = 没有缓存
  }
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= maxBytes) return;
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= maxBytes * 0.8) break;
    tryUnlink(f.path);
    total -= f.size;
  }
}

/** 清空缓存（索引版本升级 / 库重建时：id 对应的内容可能变了） */
export function clearThumbs(dir: string): void {
  pruneThumbs(dir, 0);
}

/** id 的缩略图 / 显示版路径（没有就现转）；转不了返回 null，排队满了返回 "busy" */
export async function convertedImage(cacheDir: string, id: string, loc: string, variant: Variant, src: string, name: string): Promise<string | null | "busy"> {
  if (!/^[0-9a-f]{24}$/.test(id) || !canConvert(name)) return null;
  const out = join(cacheDir, `${id}-${createHash("sha256").update(loc).digest("hex").slice(0, 12)}.${variant}.jpg`);
  if (existsSync(out)) {
    const now = new Date();
    utimesSync(out, now, statSync(out).mtime); // 记访问时间，清理按它挑最久没用的
    return out;
  }
  const key = out;
  let job = inflight.get(key);
  if (!job) {
    if (waiters.length >= MAX_QUEUE) return "busy";
    job = slot(async () => {
      mkdirSync(cacheDir, { recursive: true });
      const ok = await runSips(src, out, EDGE[variant]);
      if (ok && ++converted % PRUNE_EVERY === 0) pruneThumbs(cacheDir);
      return ok ? out : null;
    }).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}
