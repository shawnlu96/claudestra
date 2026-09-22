/**
 * 运行时注册表 —— **加一种运行时只改这个文件**（加一个适配器 + 往下面数组里塞一条）。
 *
 * 调用方一律经这里拿适配器，不要再写 `if (runtime === "xxx")`：
 *   - 按 id 拿：`sourceFor(runtime)`
 *   - 按路径认：`sourceForPath(path)`（先按根目录，再按首行嗅探）
 *   - 全部：`allSources()`（会话列表就是把它们的 scanSessions 并起来）
 */
import { closeSync, openSync, readSync } from "node:fs";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { piAdapter } from "./pi.js";
import type { SessionSourceAdapter } from "./types.js";

export * from "./types.js";
export { claudeCodeAdapter, codexAdapter, piAdapter };

/** 顺序有意义：sourceForPath 按这个顺序问「这条路径是不是你的」 */
const SOURCES: SessionSourceAdapter[] = [piAdapter, codexAdapter, claudeCodeAdapter];

export const DEFAULT_RUNTIME = "claude-code";

export function allSources(): SessionSourceAdapter[] {
  return SOURCES;
}

/** 未知 / 缺省一律回 Claude Code —— 历史数据没有 runtime 字段，那时只有它 */
export function sourceFor(runtime: string | undefined | null): SessionSourceAdapter {
  return SOURCES.find((s) => s.id === runtime) ?? claudeCodeAdapter;
}

export function isKnownRuntime(runtime: string | undefined | null): boolean {
  return !!runtime && SOURCES.some((s) => s.id === runtime);
}

/** 这个 id 的会话能不能被收编成可对话的 agent */
export function isManageableRuntime(runtime: string | undefined | null): boolean {
  return sourceFor(runtime).manageable;
}

const headSniffCache = new Map<string, string | undefined>();

/**
 * 路径 → runtime id。
 *
 * 先按根目录判（零 I/O）；**归档副本**的路径两头都不沾（它躺在
 * ~/.claude-orchestrator/archive/ 下），只能读首行让各家自己认。结果按路径缓存。
 * 认不出返回 undefined —— 调用方按 Claude Code 处理（历史行为）。
 */
export function sourceIdForPath(path: string | undefined | null): string | undefined {
  if (!path) return undefined;
  for (const s of SOURCES) if (s.ownsPath(path)) return s.id === DEFAULT_RUNTIME ? undefined : s.id;
  if (headSniffCache.has(path)) return headSniffCache.get(path);
  let hit: string | undefined;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(512);
    let n = 0;
    try { n = readSync(fd, buf, 0, 512, 0); } finally { closeSync(fd); }
    const rec = JSON.parse(buf.toString("utf8", 0, n).split("\n")[0]);
    hit = SOURCES.find((s) => s.sniffFirstLine?.(rec))?.id;
  } catch {
    hit = undefined;
  }
  headSniffCache.set(path, hit);
  return hit;
}
