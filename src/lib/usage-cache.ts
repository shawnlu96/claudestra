/**
 * statusline 落盘的用量缓存读取(v2.20.1+,peer HedeMacBook-Pro-3 方案 2026-08-27):
 * Claude Code 每次渲染状态栏都把 rate_limits JSON 喂给 statusLine 命令——
 * scripts/statusline-usage.sh 把它原子落盘到 ~/.claude-orchestrator/usage-cache.json,
 * bridge 只读它,免掉 /status TUI 抓取(敲键进 TUI 那条路已攒了 9 条不变量的
 * 补丁,statusline 是被动推送,零打断)。缓存缺失/过期一律不回退抓取(USCR1):
 * 后台显示未知或原读数 + 陈旧标记,TUI 探测只走网页手动刷新。
 *
 * 字段类型(peer 实测补正):sessionResets/weekResets 是 **Unix 秒**(数字),
 * scrapedAt 是**毫秒**;两者别搞混。resets 也兼容 ISO 字符串(防脚本变体)。
 */

import { statePath } from "./paths.js";
import { readFileSync } from "fs";
import { ACCOUNT_USAGE_REFRESH_PATH, lastManualReading } from "./account-usage-refresh.js";

export const USAGE_CACHE_PATH = statePath("usage-cache.json");
/** 「新鲜」阈值。⚠ 必须明显大于 stats-dashboard 的 TICK_MS(10min 兜底刷新)——
 *  两者同为 10min 时闲置期每个 tick 都撞上刚过期的缓存,周期锁相地回退 TUI
 *  抓取(peer 实测 2026-08-27:挂机一夜 ≈ 60 次敲键)。且过期≠抓取:见
 *  deriveStaleUsage——闲置期用量不会变,陈旧值可推算,只有缓存完全不存在才抓。 */
export const USAGE_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

export interface CachedUsage {
  sessionPct: number | null;
  weekPct: number | null;
  /** 人类可读本地时间(与 /status 面板解析出的字符串同角色)。 */
  sessionResets: string;
  weekResets: string;
  /** 数值形态(epoch ms;识别不了为 null)——陈旧推算(deriveStaleUsage)要用。 */
  sessionResetsAtMs: number | null;
  weekResetsAtMs: number | null;
  scrapedAt: number;
}

/** Unix 秒 / ISO 字符串 → epoch ms;识别不了返回 null。 */
export function resetTsMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 1e9) return v * 1000;
  if (typeof v === "string" && v) {
    const p = new Date(v);
    if (!Number.isNaN(p.getTime())) return p.getTime();
  }
  return null;
}

/** Unix 秒 / ISO 字符串 → 本地可读;识别不了返回空串。 */
export function formatResetTs(v: unknown): string {
  const ms = resetTsMs(v);
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 四舍五入但不凑满：99.5% 显示成 100 会被额度闸当成撞墙（还剩 0.5% 就把全机的 agent 消息押住），只有真到 100 才是 100。
// 超过 100 是 CC 承认的正常值（撞墙那一下冲过线，状态栏报「5h 101%」）：截成 100，跟 quota-dto 的 pctOf 一致；丢成 null 闸就看不见满
const pct = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? (v < 100 ? Math.min(99, Math.round(v)) : 100) : null;

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
    sessionResetsAtMs: resetTsMs(d.sessionResets),
    weekResetsAtMs: resetTsMs(d.weekResets),
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

/**
 * 不限龄读取「最新的真实读数」:statusline 缓存与网页手动刷新(lib/account-usage-refresh.ts)成功的那次读数,按观测时刻取新。
 * 额度服务 / 额度闸 / 周期起点都走这里——手动刷新成功后它们和看板看到的是同一份读数(USCR1 审查 manual-quota-view)。
 * 原样返回观测值,不做推算;是否过期由调用方按 scrapedAt 判。refreshPath 默认只在读默认缓存时跟随(fixture 路径不串真状态)。
 */
export function readUsageCacheStale(
  nowMs = Date.now(),
  path = USAGE_CACHE_PATH,
  refreshPath: string | null = path === USAGE_CACHE_PATH ? ACCOUNT_USAGE_REFRESH_PATH : null,
): CachedUsage | null {
  let cache: CachedUsage | null = null;
  try {
    cache = parseUsageCache(readFileSync(path, "utf8"), nowMs, Number.POSITIVE_INFINITY);
  } catch {}
  const m = refreshPath ? lastManualReading(refreshPath) : null;
  if (!m || (m.sessionPct === null && m.weekPct === null) || (cache && cache.scrapedAt >= m.scrapedAt)) return cache;
  // 面板的重置时间是本地文字,换不成时刻:缓存记的重置时刻在手动读数之后 = 还是同一个窗口,沿用;否则未知
  const sameWindow = (at: number | null | undefined) => (at != null && at > m.scrapedAt ? at : null);
  return {
    sessionPct: m.sessionPct, weekPct: m.weekPct, sessionResets: m.sessionResets, weekResets: m.weekResets,
    sessionResetsAtMs: sameWindow(cache?.sessionResetsAtMs), weekResetsAtMs: sameWindow(cache?.weekResetsAtMs), scrapedAt: m.scrapedAt,
  };
}

/**
 * v2.21.1+ per-session 上下文窗口(peer 2026-08-30):statusline JSON 的
 * context_window.context_window_size 是各 agent **真实窗口**的权威值
 * (175K/240K/2M 因模型与 1M beta 而异),usage-cache-write.sh 按 session_id
 * 分键落在 sessions{} 里。auto save-compact 阈值和看板百分比都靠它——
 * 此前硬编码 CONTEXT_CEILING=1M,小窗口 agent 的绝对阈值成了永远够不到的
 * 天花板(CC 自家 auto-compact 先接管,「先存记忆再压」永远轮不到)。
 * 窗口大小基本不变,不设新鲜度门槛;usedPct 是渲染时刻快照,调用方自行
 * 决定要不要按 ts 过滤。
 */
export interface SessionCtx {
  window: number;
  usedPct: number | null;
  inputTokens: number | null;
  ts: number;
}

export function readSessionCtx(sessionId: string, path = USAGE_CACHE_PATH): SessionCtx | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const s = raw?.sessions?.[sessionId];
    if (!s || typeof s.window !== "number" || !Number.isFinite(s.window) || s.window <= 0) return null;
    return {
      window: s.window,
      usedPct: typeof s.usedPct === "number" && Number.isFinite(s.usedPct) ? s.usedPct : null,
      inputTokens: typeof s.inputTokens === "number" && Number.isFinite(s.inputTokens) ? s.inputTokens : null,
      ts: typeof s.ts === "number" ? s.ts : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 陈旧缓存推算(peer 方案 B,2026-08-27):statusline 停写 = 全机没有会话在
 * 渲染 = 没人在消耗——**闲置期用量不会变,旧值就是真值**。唯一会变的是窗口
 * 重置:reset 时刻已过 → 对应百分比归零、reset 时间清空(下一个窗口从首次
 * 使用起算,离线推不出来)。把这条事实写进代码,而不是靠敲 TUI 轮询去发现它。
 */
export function deriveStaleUsage(c: CachedUsage, nowMs: number): CachedUsage {
  const out = { ...c };
  if (resetPassed(out.sessionResetsAtMs, nowMs)) {
    out.sessionPct = out.sessionPct === null ? null : 0;
    out.sessionResets = "";
    out.sessionResetsAtMs = null;
  }
  if (resetPassed(out.weekResetsAtMs, nowMs)) {
    out.weekPct = out.weekPct === null ? null : 0;
    out.weekResets = "";
    out.weekResetsAtMs = null;
  }
  return out;
}

/**
 * 额度窗口的重置时刻是否已过——Claude 的陈旧推算与 Codex 额度卡共用这一条判据
 * （时刻未知 = 判不出来，按「没过」处理，调用方照常显示观测值）。
 */
export function resetPassed(resetsAtMs: number | null, nowMs: number): boolean {
  return resetsAtMs !== null && nowMs >= resetsAtMs;
}
