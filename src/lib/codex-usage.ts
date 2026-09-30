/**
 * Codex 用量：会话 token（今日 / 本周）与「最近一次 Codex 会话看到的额度」，只读本地 rollout 的
 * `token_usage_record` 与 `event_msg/token_count`，零网络、零凭据。单测 tests/codex-usage.test.ts。
 *   token_usage_record.usage 每次请求一条，是准数；较新的 Codex 才有，紧跟其后的 token_count 是同一次请求
 *   info.total_token_usage 累计计数器（新进程 / 新回合会重开，同一值会重复落盘）；last_token_usage ≈ 当前上下文
 *   rate_limits primary / secondary {used_percent, window_minutes, resets_at(秒)}、plan_type、credits
 * rollout 里没有账号身份（limit_id 是额度种类、plan_type 是套餐）：不拼账户键，额度只代表那个会话在那一刻
 * 看到的，前端写明来自哪个会话、多久之前。
 */

import { existsSync, statSync } from "node:fs";
import type { FileStats, StatsWindowScanner, UsageWindow } from "./agent-stats.js";
import {
  codexSessionIdFromFilename,
  codexStateRecord,
  codexUsageTotal,
  listCodexSessionFiles,
  readCodexMeta,
} from "./codex-session.js";
import { codexRolloutRoot } from "./codex-home.js";
import { formatResetTs, resetPassed, resetTsMs } from "./usage-cache.js";
import { windowsFor } from "./usage-window.js";

type AnyRecord = Record<string, any>;

// ── 会话 token：累计计数器做差 ─────────────────────────────────────────────

/**
 * 累计计数器 → 这一条的增量。null = 窗口从半截开始、手里没有上一条，只能当基线。
 * 三种形态实测都有：同一累计值重复落盘（算 0）；计数器重开（total 等于 last，这一条就是全部）；
 * 重开的那一条丢了（total 变小，只能取当前值）。
 */
export function codexTokenDelta(prev: number | null, total: number, last: number | null): number | null {
  if (prev !== null && total === prev) return 0;
  if (last !== null && total === last) return total;
  if (prev === null) return null;
  return total < prev ? total : total - prev;
}

const emptyWindow = (): UsageWindow => ({ tokens: 0, requests: 0, costUsd: 0, reportedCostUsd: 0 });

/** 只有这几种行对统计有用；先按子串筛，免得每条几 KB 的对话行都 JSON.parse */
const STATS_LINE_RE = /"(token_count|turn_context|token_usage_record)"/;

/**
 * Codex 的统计扫描器（按文件顺序）。有 token_usage_record 的请求按它计；老 rollout 没有，退回累计值做差——
 * 做差在计数器重开那条丢了时会少算（codex 自己的长会话实测少 1.5%）。`oldestTs` 取窗口里第一条 token_count 的时间：
 * 它早于周界，周内每一条就都有上一条可做差；否则 readFileStats 会继续扩窗。
 * 没有牌价（B2 未做），costUsd 恒 0；前端对「有 token 没有钱」显示「—」而不是 $0。
 */
export const scanCodexStatsWindow: StatsWindowScanner = (lines, dayTs, weekTs, fromFileStart) => {
  const today = emptyWindow();
  const week = emptyWindow();
  const stats: FileStats = { contextTokens: 0, contextEstimated: false, today, week, model: "", contextWindow: null };
  let prev: number | null = fromFileStart ? 0 : null;
  let oldestTs = Infinity;
  let recorded = false; // 上一条是 token_usage_record：紧跟着的 token_count 是同一次请求，只推进计数器、不再计
  const add = (ts: number, n: number) => {
    if (!n || !Number.isFinite(ts)) return;
    for (const w of windowsFor(ts, dayTs, weekTs, today, week)) {
      w.tokens += n;
      w.requests += 1;
    }
  };
  for (const line of lines) {
    if (!line || !STATS_LINE_RE.test(line)) continue;
    let e: AnyRecord;
    try { e = JSON.parse(line); } catch { continue; } // 尾读窗口的半截首行 / 写到一半的末行，丢掉这一条
    const p: AnyRecord = e?.payload && typeof e.payload === "object" ? e.payload : {};
    if (e?.type === "token_usage_record") {
      const n = codexUsageTotal(p.usage);
      if (n === null) continue;
      add(Date.parse(e.timestamp), n);
      recorded = true;
      continue;
    }
    if (e?.type === "turn_context") {
      const m = codexStateRecord("turn_context", p, undefined)?.model;
      if (typeof m === "string") stats.model = m;
      continue;
    }
    if (e?.type !== "event_msg" || p.type !== "token_count") continue;
    const total = codexUsageTotal(p.info?.total_token_usage);
    if (total === null) continue; // 只有限流信息、info 为 null 的那种
    const ts = Date.parse(e.timestamp);
    if (Number.isFinite(ts) && ts < oldestTs) oldestTs = ts;
    const last = codexUsageTotal(p.info.last_token_usage);
    if (last !== null && last > 0) stats.contextTokens = last;
    const win = p.info.model_context_window;
    if (typeof win === "number" && win > 0) stats.contextWindow = win;
    const d = codexTokenDelta(prev, total, last);
    prev = total;
    if (recorded) recorded = false;
    else if (d) add(ts, d);
  }
  return { stats, oldestTs };
};

// ── 额度：最近一次会话看到的 rate_limits ───────────────────────────────────

interface QuotaWindow {
  /** 按窗口长度命名："5h" / "7d" / "30d"；长度缺失时退回槽位名 primary / secondary */
  id: string;
  windowMinutes: number | null;
  /** 观测时的已用百分比（0–100）；resetPassed 时这是上一个窗口的旧值，前端不当现值显示 */
  pct: number | null;
  /** 重置时刻：bridge 本机时区的可读串 + epoch ms */
  resets: string;
  resetsAtMs: number | null;
  /** 已过重置时刻：新窗口的用量要等下一次 Codex 请求才知道（不推算成 0%） */
  resetPassed: boolean;
}

export interface CodexQuotaObservation {
  source: "codex-rollout";
  plan: string | null;
  windows: QuotaWindow[];
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  /** rate_limit_reached_type 原样透传（撞限时非 null） */
  limitReached: string | null;
  /** 那条 token_count 的时间（ms） */
  observedAt: number;
  sessionId: string;
  cwd: string | null;
  /** 这个会话属于哪个 registry agent；野生会话为 null */
  agent: string | null;
}

/** 300 → "5h"，10080 → "7d"，43200 → "30d"，其它 → "<n>m" */
export function windowIdOf(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function parseWindow(slot: string, w: unknown, nowMs: number): QuotaWindow | null {
  if (!w || typeof w !== "object") return null;
  const r = w as AnyRecord;
  const pct = typeof r.used_percent === "number" && Number.isFinite(r.used_percent)
    ? Math.min(100, Math.max(0, Math.round(r.used_percent)))
    : null;
  const minutes = typeof r.window_minutes === "number" && r.window_minutes > 0 ? r.window_minutes : null;
  const resetsAtMs = resetTsMs(r.resets_at);
  if (pct === null && resetsAtMs === null) return null;
  return {
    id: minutes ? windowIdOf(minutes) : slot,
    windowMinutes: minutes,
    pct,
    resets: formatResetTs(r.resets_at),
    resetsAtMs,
    resetPassed: resetPassed(resetsAtMs, nowMs),
  };
}

type ParsedLimits = Pick<CodexQuotaObservation, "plan" | "windows" | "credits" | "limitReached">;

/** rate_limits 对象 → 额度窗口（字段缺了就少一样，一个窗口都拿不到才返回 null） */
export function parseCodexRateLimits(rl: unknown, nowMs: number): ParsedLimits | null {
  if (!rl || typeof rl !== "object") return null;
  const r = rl as AnyRecord;
  const windows = ["primary", "secondary"]
    .map((slot) => parseWindow(slot, r[slot], nowMs))
    .filter((w): w is QuotaWindow => w !== null);
  if (!windows.length) return null;
  const c: AnyRecord | null = r.credits && typeof r.credits === "object" ? r.credits : null;
  return {
    plan: typeof r.plan_type === "string" && r.plan_type ? r.plan_type : null,
    windows,
    credits: c
      ? { hasCredits: c.has_credits === true, unlimited: c.unlimited === true, balance: c.balance == null ? null : String(c.balance) }
      : null,
    limitReached: typeof r.rate_limit_reached_type === "string" ? r.rate_limit_reached_type : null,
  };
}

/** 一段 rollout 行里最后一条带 rate_limits 的 token_count（倒着找） */
export function lastRateLimitEvent(lines: string[]): { rateLimits: AnyRecord; observedAt: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"rate_limits"')) continue;
    let e: AnyRecord;
    try { e = JSON.parse(line); } catch { continue; } // 尾读窗口的半截首行 / 写到一半的末行，往前找
    const p = e?.payload;
    if (e?.type !== "event_msg" || p?.type !== "token_count" || !p.rate_limits || typeof p.rate_limits !== "object") continue;
    const at = Date.parse(e.timestamp);
    if (Number.isFinite(at)) return { rateLimits: p.rate_limits, observedAt: at };
  }
  return null;
}

interface RawQuota {
  rateLimits: AnyRecord;
  observedAt: number;
  path: string;
  sessionId: string;
  cwd: string | null;
}

/** 尾部 2MB 足够：token_count 每次请求都落一条，最后一条离文件尾不会隔着几 MB */
const QUOTA_TAIL_BYTES = 2 * 1024 * 1024;
/** 最多读这么多个最新文件；再往后都是更早的会话，除非前面全是没请求过的空会话 */
const QUOTA_MAX_FILES = 6;

async function tailLines(path: string, bytes: number): Promise<string[]> {
  try {
    const size = statSync(path).size;
    return (await Bun.file(path).slice(Math.max(0, size - bytes)).text()).split("\n");
  } catch (e) {
    console.error(`📊 读 Codex rollout 失败（跳过这个文件）: ${path}: ${(e as Error).message}`);
    return [];
  }
}

const mtimeOf = (p: string) => {
  try { return statSync(p).mtimeMs; } catch { return 0; } // 扫描途中被删：当最旧，排到后面也不会被读
};

/**
 * 全机 rollout 里最新的一条额度观测。按 mtime 从新到旧读：某个文件的最后写入都早于已找到的
 * 观测时，它和更旧的文件里不可能有更新的观测，直接停。
 */
export async function findLatestCodexQuota(root: string = codexRolloutRoot()): Promise<RawQuota | null> {
  if (!existsSync(root)) return null;
  let best: RawQuota | null = null;
  let read = 0;
  for (const path of listCodexSessionFiles(root)) {
    if (best && mtimeOf(path) <= best.observedAt) break;
    if (++read > QUOTA_MAX_FILES) break;
    const hit = lastRateLimitEvent(await tailLines(path, QUOTA_TAIL_BYTES));
    if (!hit || (best && hit.observedAt <= best.observedAt)) continue;
    const meta = await readCodexMeta(path);
    const sessionId = meta?.sessionId || codexSessionIdFromFilename(path.split("/").pop() || "") || "";
    best = { ...hit, path, sessionId, cwd: meta?.cwd || null };
  }
  return best;
}

/** stats 每个 Stop hook 都会重建；全树 stat 一遍的结果 20 秒内复用（额度本来就是观测值） */
const QUOTA_CACHE_MS = 20_000;
let quotaCache: { at: number; value: Promise<RawQuota | null> } | null = null;

function latestQuotaCached(nowMs: number): Promise<RawQuota | null> {
  if (quotaCache && nowMs - quotaCache.at < QUOTA_CACHE_MS) return quotaCache.value;
  const value = findLatestCodexQuota().catch((e) => {
    console.error("📊 Codex 额度读取失败（本轮不显示 Codex 卡）:", (e as Error).message);
    return null;
  });
  quotaCache = { at: nowMs, value };
  return value;
}

/** 原始观测 + 当前时刻 → 给前端的卡片数据（重置是否已过按「现在」判，不进缓存） */
export function toCodexQuota(
  raw: RawQuota,
  agents: Array<{ name: string; jsonl: string | null }>,
  nowMs: number,
): CodexQuotaObservation | null {
  const parsed = parseCodexRateLimits(raw.rateLimits, nowMs);
  if (!parsed) return null;
  const agent = agents.find((a) => a.jsonl === raw.path)?.name ?? null;
  return { source: "codex-rollout", ...parsed, observedAt: raw.observedAt, sessionId: raw.sessionId, cwd: raw.cwd, agent };
}

/**
 * /stats 快照追加 `quotas`（额外的额度卡；目前只有 Codex 一张）。老字段一个不动；没有 Codex
 * rollout 的机器是空数组，前端据此不显示卡片。
 */
export async function withCodexQuota<T extends { agents: Array<{ name: string; jsonl: string | null }> }>(
  snap: T,
  nowMs = Date.now(),
): Promise<T & { quotas: CodexQuotaObservation[] }> {
  const raw = await latestQuotaCached(nowMs);
  const q = raw ? toCodexQuota(raw, snap.agents, nowMs) : null;
  return { ...snap, quotas: q ? [q] : [] };
}
