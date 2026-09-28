/**
 * 媒体缩略图 / 显示版：用 macOS 自带的 sips 转 JPEG 并按媒体 id 缓存（附件文件名带时间戳前缀，内容不可变，缓存不用失效）。
 * 为什么在服务端做：原图多是 3~5MB 的手机照片，走中继的手机端拉一屏网格就是上百 MB；HEIC 在 Chrome 里根本显示不了，sips 顺手转掉。
 * 非 macOS 或 sips 失败 → 返回 null，调用方退回原图（前端照样懒加载）。同时最多跑 MAX_JOBS 个 sips，免得翻网格时把 CPU 打满。
 */
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export type Variant = "thumb" | "display";
const EDGE: Record<Variant, number> = { thumb: 360, display: 2560 };
const MAX_JOBS = 2;
const SIPS = "/usr/bin/sips";
/** sips 认不了 / 转了没意义的：SVG 原样出（带 CSP），GIF 动图缩略图会丢动画但网格里可以接受 */
const SKIP_EXT = new Set(["svg"]);

let running = 0;
const waiters: (() => void)[] = [];
const inflight = new Map<string, Promise<string | null>>();

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

async function runSips(src: string, out: string, edge: number): Promise<boolean> {
  const tmp = `${out}.${process.pid}.tmp.jpg`;
  const p = Bun.spawn([SIPS, "-Z", String(edge), "-s", "format", "jpeg", "-s", "formatOptions", "72", src, "--out", tmp], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code === 0 && existsSync(tmp)) {
    renameSync(tmp, out); // 先写临时名再改名：并发读者永远看不到半截文件
    return true;
  }
  console.warn(`[media-thumb] sips 转换失败 code=${code}: ${(await new Response(p.stderr).text()).trim().slice(0, 200)}`);
  try {
    unlinkSync(tmp);
  } catch {
    /* sips 失败时通常根本没写出临时文件，删不到正常 */
  }
  return false;
}

/** id 的缩略图 / 显示版路径（没有就现转）；转不了返回 null */
export async function convertedImage(cacheDir: string, id: string, variant: Variant, src: string, name: string): Promise<string | null> {
  if (!/^[0-9a-f]{24}$/.test(id) || !canConvert(name)) return null;
  const out = join(cacheDir, `${id}.${variant}.jpg`);
  if (existsSync(out)) return out;
  const key = `${id}.${variant}`;
  let job = inflight.get(key);
  if (!job) {
    job = slot(async () => {
      mkdirSync(cacheDir, { recursive: true });
      return (await runSips(src, out, EDGE[variant])) ? out : null;
    }).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}
