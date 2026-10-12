/**
 * Codex 用量：会话 token（今日 / 本周）与「最近一次 Codex 会话看到的额度」，只读本地 rollout 的
 * `token_usage_record` 与 `event_msg/token_count`，零网络、零凭据。单测 tests/codex-usage.test.ts。
 *   token_usage_record.usage 每次请求一条，是准数；较新的 Codex 才有，紧跟其后的 token_count 是同一次请求
 *   info.total_token_usage 累计计数器（新进程 / 新回合会重开，同一值会重复落盘）；last_token_usage ≈ 当前上下文
 *   rate_limits primary / secondary {used_percent, window_minutes, resets_at(秒)}、plan_type、credits
 * rollout 里没有账号身份（limit_id 是额度种类、plan_type 是套餐）：不拼账户键，额度只代表那个会话在那一刻
 * 看到的，前端写明来自哪个会话、多久之前。
 */

import type { FileStats, StatsFoldFactory, StatsWindowScanner, UsageWindow } from "./agent-stats.js";
import {
  codexStateRecord,
  codexUsageTotal,
} from "./codex-session.js";
import { newestRateLimitEvent, scanRolloutQuota, type RolloutQuota, type RolloutScanOptions } from "./quota-observation-rollout.js";
import { observationTime } from "./quota-observation.js";
import { heldLimit, limitResetsOf, rolloutCleared, rolloutReached, roundPctBelowFull, type HeldLimit } from "./quota-limit-facts.js";
import { codexRolloutRoot } from "./codex-home.js";
import { formatResetTs, resetPassed, resetTsMs } from "./usage-cache.js";
import { windowFloor, windowsFor } from "./usage-window.js";

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
 * Codex 的统计折叠（按文件顺序，可分批续喂）。有 token_usage_record 的请求按它计；老 rollout 没有，退回累计值做差——
 * 做差在计数器重开那条丢了时会少算（codex 自己的长会话实测少 1.5%）。`oldestTs` 取窗口里第一条 token_count 的时间：
 * 它早于周界，周内每一条就都有上一条可做差；否则 readFileStats 会继续扩窗。
 * 没有牌价（B2 未做），costUsd 恒 0；前端对「有 token 没有钱」显示「—」而不是 $0。
 * 逐条增量按时间戳留着（早于 floor 的不留），出结果时再按当时的今日 / 本周界分桶：续读跨过日界不用重读。
 */
export const codexStatsFold: StatsFoldFactory = ({ floor, fromFileStart }) => {
  let contextTokens = 0;
  let model = "";
  let contextWindow: number | null = null;
  let prev: number | null = fromFileStart ? 0 : null;
  let oldestTs = Infinity;
  let recorded = false; // 上一条是 token_usage_record：紧跟着的 token_count 是同一次请求，只推进计数器、不再计
  let amounts: { ts: number; n: number }[] = [];
  const add = (ts: number, n: number) => {
    if (n && Number.isFinite(ts) && ts >= floor) amounts.push({ ts, n });
  };
  const feed = (lines: string[]) => {
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
        if (typeof m === "string") model = m;
        continue;
      }
      if (e?.type !== "event_msg" || p.type !== "token_count") continue;
      const total = codexUsageTotal(p.info?.total_token_usage);
      if (total === null) continue; // 只有限流信息、info 为 null 的那种
      const ts = Date.parse(e.timestamp);
      if (Number.isFinite(ts) && ts < oldestTs) oldestTs = ts;
      const last = codexUsageTotal(p.info.last_token_usage);
      if (last !== null && last > 0) contextTokens = last;
      const win = p.info.model_context_window;
      if (typeof win === "number" && win > 0) contextWindow = win;
      const d = codexTokenDelta(prev, total, last);
      prev = total;
      if (recorded) recorded = false;
      else if (d) add(ts, d);
    }
  };
  const result = (dayTs: number, weekTs: number): FileStats => {
    const today = emptyWindow();
    const week = emptyWindow();
    amounts = amounts.filter((a) => a.ts >= windowFloor(dayTs, weekTs)); // 窗口只会往后挪（往前挪 readFileStats 会整窗重读）
    for (const a of amounts) {
      for (const w of windowsFor(a.ts, dayTs, weekTs, today, week)) {
        w.tokens += a.n;
        w.requests += 1;
      }
    }
    return { contextTokens, contextEstimated: false, today, week, model, contextWindow };
  };
  return { feed, oldestTs: () => oldestTs, result };
};

/** 一次性扫一个窗口（单测与旧调用口径）：等同于新折叠喂一遍 */
export const scanCodexStatsWindow: StatsWindowScanner = (lines, dayTs, weekTs, fromFileStart) => {
  const fold = codexStatsFold({ runtime: "codex", floor: windowFloor(dayTs, weekTs), fromFileStart });
  fold.feed(lines);
  return { stats: fold.result(dayTs, weekTs), oldestTs: fold.oldestTs() };
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
  /** 撞限那次观测里全部窗口的重置时刻（没有百分比的窗口也在内）；只在 limitReached 非 null 时带 */
  limitResets?: (number | null)[];
  /** 这条没带 reached-type、而更早的观测明确说过已撞限：那次的时刻与截止（quota-limit-facts） */
  limitHeld?: HeldLimit;
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
    ? Math.min(100, Math.max(0, roundPctBelowFull(r.used_percent, 0)))
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

type ParsedLimits = Pick<CodexQuotaObservation, "plan" | "windows" | "credits" | "limitReached" | "limitResets">;

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
    ...(rolloutReached(r.rate_limit_reached_type) ? { limitResets: limitResetsOf([r.primary, r.secondary], (w) => resetTsMs(w.resets_at)) } : {}),
  };
}

/** Newest valid observation in these lines; file order alone does not establish observation time. */
export function lastRateLimitEvent(lines: string[]): { rateLimits: AnyRecord; observedAt: number } | null {
  return newestRateLimitEvent(lines, Date.now(), (reason) => console.warn("[codex-quota] " + reason));
}

/** limitHeld = 最新观测没带 reached-type 时，同一批 rollout 里最近一条明确已撞限、且之后没有被显式 null 纠正的观测 */
type RawQuota = RolloutQuota & { limitHeld?: Pick<RolloutQuota, "rateLimits" | "observedAt"> };

/**
 * Scan every candidate within the explicit budget; incomplete scans return unknown with a diagnostic.
 * 最新一条没带 reached-type 时再按同样的资格找最近一条明确已撞限的（内容索引没变的文件不重读）。
 * 时间严格晚于它的显式 null（键在、值为 null）是明确没撞限，留存就此清掉；同一时刻或更早的 null、缺键都不清。
 * 这两遍有一遍扫不全同样按 unknown。
 */
export async function findLatestCodexQuota(root: string = codexRolloutRoot(), options: RolloutScanOptions = {}): Promise<RawQuota | null> {
  const parse = (rl: unknown) => parseCodexRateLimits(rl, options.now ?? Date.now());
  const latest = (await scanRolloutQuota(root, options, (rl) => parse(rl) !== null)).value;
  if (!latest || rolloutReached(parse(latest.rateLimits)?.limitReached)) return latest;
  const reached = await scanRolloutQuota(root, options, (rl) => rolloutReached(parse(rl)?.limitReached));
  if (!reached.complete) return null;
  const held = reached.value;
  if (!held) return latest;
  const cleared = await scanRolloutQuota(root, options, (rl) => rolloutCleared(rl) && parse(rl) !== null);
  if (!cleared.complete) return null;
  if (cleared.value && cleared.value.observedAt > held.observedAt) return latest;
  return { ...latest, limitHeld: { rateLimits: held.rateLimits, observedAt: held.observedAt } };
}

/** stats 每个 Stop hook 都会重建；全树 stat 一遍的结果 20 秒内复用（额度本来就是观测值） */
const QUOTA_CACHE_MS = 20_000;
let quotaCache: { at: number; value: Promise<RawQuota | null> } | null = null;

function latestQuotaCached(nowMs: number): Promise<RawQuota | null> {
  if (quotaCache && nowMs >= quotaCache.at && nowMs - quotaCache.at < QUOTA_CACHE_MS) return quotaCache.value;
  const value = findLatestCodexQuota(undefined, { now: nowMs }).catch((e) => {
    console.error("📊 Codex 额度读取失败（本轮不显示 Codex 卡）:", (e as Error).message);
    return null;
  });
  quotaCache = { at: nowMs, value };
  return value;
}

/** Raw historical observation → card data. Current-reading callers must qualify its time before using the value. */
export function toCodexQuota(
  raw: RawQuota,
  agents: Array<{ name: string; jsonl: string | null }>,
  nowMs: number,
): CodexQuotaObservation | null {
  const parsed = parseCodexRateLimits(raw.rateLimits, nowMs);
  if (!parsed) return null;
  const agent = agents.find((a) => a.jsonl === raw.path)?.name ?? null;
  const prior = !rolloutReached(parsed.limitReached) && raw.limitHeld ? raw.limitHeld : null;
  const limitHeld = prior ? { limitHeld: heldLimit(prior.observedAt, parseCodexRateLimits(prior.rateLimits, nowMs)?.limitResets) } : {};
  return { source: "codex-rollout", ...parsed, ...limitHeld, observedAt: raw.observedAt, sessionId: raw.sessionId, cwd: raw.cwd, agent };
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
  const q = raw && observationTime(raw.observedAt, nowMs).eligible ? toCodexQuota(raw, snap.agents, nowMs) : null;
  return { ...snap, quotas: q ? [q] : [] };
}
