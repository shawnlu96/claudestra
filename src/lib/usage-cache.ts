/**
 * statusline 落盘的用量缓存读取(v2.20.1+,peer HedeMacBook-Pro-3 方案 2026-08-27):
 * Claude Code 每次渲染状态栏都把 rate_limits JSON 喂给 statusLine 命令——
 * scripts/statusline-usage.sh 把它原子落盘到 ~/.claude-orchestrator/usage-cache.json,
 * bridge 优先读它,免掉 /status TUI 抓取(敲键进 TUI 那条路已攒了 9 条不变量的
 * 补丁,statusline 是被动推送,零打断)。缓存缺失/过期 → 调用方回退抓取,
 * 没配 statusline 的安装零感知。
 *
 * 字段类型(peer 实测补正):sessionResets/weekResets 是 **Unix 秒**(数字),
 * scrapedAt 是**毫秒**;两者别搞混。resets 也兼容 ISO 字符串(防脚本变体)。
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const USAGE_CACHE_PATH = join(homedir(), ".claude-orchestrator", "usage-cache.json");
/** 缓存多新才算数:statusline 每次渲染都写,10min 没写过 = 全机没有活跃会话,
 *  此时回退抓取(抓取自己也有 idle 判定,不会打谁)。 */
export const USAGE_CACHE_MAX_AGE_MS = 10 * 60 * 1000;

export interface CachedUsage {
  sessionPct: number | null;
  weekPct: number | null;
  /** 人类可读本地时间(与 /status 面板解析出的字符串同角色)。 */
  sessionResets: string;
  weekResets: string;
  scrapedAt: number;
}

/** Unix 秒 / ISO 字符串 → 本地可读;识别不了返回空串。 */
export function formatResetTs(v: unknown): string {
  let d: Date | null = null;
  if (typeof v === "number" && Number.isFinite(v) && v > 1e9) d = new Date(v * 1000);
  else if (typeof v === "string" && v) {
    const p = new Date(v);
    if (!Number.isNaN(p.getTime())) d = p;
  }
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const pct = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : null;

/** 解析 + 新鲜度校验(纯函数,单测)。不新鲜/形态不对返回 null。 */
export function parseUsageCache(
  json: string,
  nowMs: number,
  maxAgeMs = USAGE_CACHE_MAX_AGE_MS
): CachedUsage | null {
  let d: any;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  const scrapedAt = typeof d?.scrapedAt === "number" ? d.scrapedAt : 0;
  if (!scrapedAt || nowMs - scrapedAt > maxAgeMs) return null;
  const sessionPct = pct(d.sessionPct);
  const weekPct = pct(d.weekPct);
  if (sessionPct === null && weekPct === null) return null; // 空壳不如回退抓取
  return {
    sessionPct,
    weekPct,
    sessionResets: formatResetTs(d.sessionResets),
    weekResets: formatResetTs(d.weekResets),
    scrapedAt,
  };
}

/** 读文件 + 解析;任何失败返回 null(调用方回退抓取)。 */
export function readUsageCache(nowMs = Date.now(), path = USAGE_CACHE_PATH): CachedUsage | null {
  try {
    return parseUsageCache(readFileSync(path, "utf8"), nowMs);
  } catch {
    return null;
  }
}
