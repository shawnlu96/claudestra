/**
 * Agent 统计数据层（纯本地，无 LLM）
 *
 * 每个 agent 的「上下文大小 / 今日 token / 本周 token」全部从
 * ~/.claude/projects/<slug>/<sessionId>.jsonl 里算出来 —— Claude Code 自己的
 * /status Usage 面板也是 "based on local sessions on this machine"，同一数据源。
 *
 * 账号级的 5h / 周 limit **占比** 不在本地文件里（见 bridge/stats-dashboard.ts 抓
 * /status），所以那部分不在这里，这里只管 per-agent，保持可单测。
 *
 * 性能：每个 JSONL 单遍扫描同时算出 上下文 + 今日 + 本周；并按 (mtime, 日界, 周界)
 * 缓存，只有文件真变了（= 那个刚收尾的 agent）才重读，避免每次 hook 重读 13 个大文件。
 */

import { existsSync, statSync } from "fs";
import { projectJsonlPath, findJsonlBySessionId } from "./jsonl-cost.js";
import { readSessionCtx } from "./usage-cache.js";

export interface UsageWindow {
  tokens: number;
  requests: number;
  /** 按 API 牌价折算的成本（USD）。订阅制不按此扣费，仅供参考。 */
  costUsd: number;
}

/**
 * API 牌价（USD / Mtok），2026-09 官网口径：[input, output, cacheWrite(5m), cacheRead]。
 * 顺序敏感：先匹配更具体的（fable-5-1 在 fable 之前、opus-4-8 在 opus 之前）。
 * 未知模型不计价（0），宁可少报不虚报。
 * Fable 5.1 相对 Fable 5 只有 cache read 变了（$1 → $0.25），其余同价；
 * Mythos 5.1 的 cache read 官方未定，暂沿用泛 fable 口径。
 */
const MODEL_PRICES: Array<{ match: RegExp; in_: number; out: number; cw: number; cr: number }> = [
  { match: /fable-5-1/i, in_: 10, out: 50, cw: 12.5, cr: 0.25 },
  { match: /fable|mythos/i, in_: 10, out: 50, cw: 12.5, cr: 1 },
  { match: /opus-5/i, in_: 5, out: 25, cw: 6.25, cr: 0.5 },
  { match: /opus-4-8/i, in_: 5, out: 25, cw: 6.25, cr: 0.5 },
  { match: /opus/i, in_: 15, out: 75, cw: 18.75, cr: 1.5 },
  { match: /sonnet/i, in_: 3, out: 15, cw: 3.75, cr: 0.3 },
  { match: /haiku/i, in_: 1, out: 5, cw: 1.25, cr: 0.1 },
];

/** 一条 assistant usage 记录的折算成本（USD）。model 用记录自己的（中途换过模型的历史按各自计价）。 */
export function costOfUsage(model: string, u: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  const p = MODEL_PRICES.find((x) => x.match.test(model));
  if (!p) return 0;
  return (
    (Number(u.input_tokens || 0) * p.in_ +
      Number(u.output_tokens || 0) * p.out +
      Number(u.cache_creation_input_tokens || 0) * p.cw +
      Number(u.cache_read_input_tokens || 0) * p.cr) /
    1_000_000
  );
}

export interface AgentStat {
  name: string;
  channelId: string;
  model: string;
  status: string;
  /** 当前会话上下文占用 ≈ 最后一条 assistant 的 input + cacheRead + cacheCreation */
  contextTokens: number;
  contextPct: number; // 相对 CONTEXT_CEILING
  /** compact 后还没有新对话：contextTokens 是估算值（底座 + 摘要/4），非 usage 实测 */
  contextEstimated: boolean;
  today: UsageWindow;
  week: UsageWindow;
  jsonl: string | null;
}

export interface AgentLike {
  name: string;
  channelId?: string;
  status?: string;
  cwd?: string;
  dir?: string;
  sessionId?: string;
  model?: string;
}

/** 上下文窗口天花板（用于算占比）。会话实测能涨到 ~1M。 */
export const CONTEXT_CEILING = 1_000_000;

/**
 * compact 后新上下文的固定底座估算（system prompt + 工具 + CLAUDE.md + MCP 说明）。
 * 2026-07-09 用 claudestra 自己的 session 实测：压后首条真实 ctx 58K ≈ 55K 底座 +
 * 3K 摘要（摘要 12.4K chars / 4）。claudestra 是重配置 agent，取 45K 做通用估值 ——
 * 反正带「~」展示，下一轮真实对话到来就会被 usage 实测覆盖。
 */
export const POST_COMPACT_BASE_TOKENS = 45_000;

/** 今天本地 00:00 的 ms 时间戳 */
export function dayStartTs(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周一本地 00:00 的 ms 时间戳（ISO 周，周一为一周开始） */
export function weekStartTs(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - day);
  return d.getTime();
}

interface FileStats {
  contextTokens: number;
  contextEstimated: boolean;
  today: UsageWindow;
  week: UsageWindow;
  /** 最后一条 assistant 实际用的 model（真相），可能跟 registry 钉的不一样 */
  model: string;
}

const fileCache = new Map<string, { key: string; stats: FileStats }>();

/** 统计尾读的起始窗口。实测本机最大会话（513MB）只需尾部 4MB 就回溯过周界，8MB 留一倍余量。 */
const STATS_TAIL_START_BYTES = 8 * 1024 * 1024;
/**
 * 尾读窗口上限。真有 agent 一周写超过这个量，用量数字会少算一截——但那是个**显示值**，
 * 而无上限扩窗是会把 bridge 拖进 OOM 的（session-history 的 `win *= 8` 就是现成教训）。
 */
const STATS_TAIL_MAX_BYTES = 128 * 1024 * 1024;

/**
 * 扫描一段 jsonl 行，算出上下文 + 今日 + 本周。纯函数，不碰文件系统（可单测）。
 *
 * 返回的 `oldestTs` 是本段里最早的一条时间戳，调用方据此判断窗口是否已经回溯过周界。
 * 取 Infinity 表示整段没有一条可解析的时间戳。
 */
export function scanStatsWindow(
  lines: string[],
  dayTs: number,
  weekTs: number,
): { stats: FileStats; oldestTs: number } {
  const today: UsageWindow = { tokens: 0, requests: 0, costUsd: 0 };
  const week: UsageWindow = { tokens: 0, requests: 0, costUsd: 0 };
  let contextTokens = 0;
  let contextEstimated = false;
  let model = "";
  let ctxFound = false;
  let oldestTs = Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }
    // 窗口是否已回溯过周界，由「整窗最早的时间戳」判定（见 readFileStats 的注释）
    {
      const t = Date.parse(rec?.timestamp);
      if (Number.isFinite(t) && t < oldestTs) oldestTs = t;
    }
    // compact 后还没新对话：尾扫会先遇到 compact 摘要而不是带 usage 的 assistant。
    // 这时最后一条 usage 是**压缩前**的旧值（owner 2026-07-09 报告：compact 完很久
    // 不聊天，看板一直显示压缩前的红色大数）。真实值要等下一轮对话才有，先按
    // 底座 + 摘要文本/4 估算，标记 estimated 让展示层加「~」。
    if (!ctxFound && rec.type === "user" && rec.isCompactSummary === true) {
      const c = rec?.message?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
            : "";
      contextTokens = POST_COMPACT_BASE_TOKENS + Math.round(text.length / 4);
      contextEstimated = true;
      ctxFound = true;
      continue;
    }
    if (rec.type !== "assistant") continue;
    const u = rec?.message?.usage;
    if (!u) continue;
    // model 独立于 ctx 追踪：compact 估算分支拿不到 model，继续往前找最近的真实值
    if (!model) model = String(rec?.message?.model || "");
    if (!ctxFound) {
      // 从尾往前第一条带 usage 的 assistant = 当前上下文快照
      contextTokens =
        Number(u.input_tokens || 0) +
        Number(u.cache_read_input_tokens || 0) +
        Number(u.cache_creation_input_tokens || 0);
      ctxFound = true;
    }
    const ts = new Date(rec.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < weekTs) continue;
    const tok =
      Number(u.input_tokens || 0) +
      Number(u.cache_creation_input_tokens || 0) +
      Number(u.cache_read_input_tokens || 0) +
      Number(u.output_tokens || 0);
    // 折算成本按**该条记录自己的 model** 计价——会话中途换过模型的历史各按各价
    const cost = costOfUsage(String(rec?.message?.model || ""), u);
    week.tokens += tok;
    week.requests += 1;
    week.costUsd += cost;
    if (ts >= dayTs) {
      today.tokens += tok;
      today.requests += 1;
      today.costUsd += cost;
    }
  }
  return { stats: { contextTokens, contextEstimated, today, week, model }, oldestTs };
}

/** 单遍扫描一个 JSONL 的**尾部**，同时算上下文 + 今日 + 本周；带 (5 秒桶,日界,周界) 缓存 */
export async function readFileStats(
  path: string,
  /** 尾读起始窗口；单测可调小来在小 fixture 上验扩窗路径（与 readSessionHistory 的 maxFullReadBytes 同约定） */
  opts: { tailStartBytes?: number } = {},
): Promise<FileStats> {
  const empty: FileStats = {
    contextTokens: 0,
    contextEstimated: false,
    today: { tokens: 0, requests: 0, costUsd: 0 },
    week: { tokens: 0, requests: 0, costUsd: 0 },
    model: "",
  };
  if (!existsSync(path)) return empty;
  const dayTs = dayStartTs();
  const weekTs = weekStartTs();
  let size = 0;
  try { size = statSync(path).size; } catch { return empty; }
  // 缓存键刻意**不含** mtime：session jsonl 每次工具调用都在追加，mtime 一直在变，
  // 把它放进 key 等于缓存永不命中。改用 5 秒时间桶：同一个 5 秒窗口内复用结果，
  // 统计数字最多滞后 5 秒，对用量面板完全够用。
  const bucket = Math.floor(Date.now() / 5000);
  const key = `${bucket}:${dayTs}:${weekTs}`;
  const cached = fileCache.get(path);
  if (cached && cached.key === key) return cached.stats;

  // 尾读，不是全文读。这里要的三样东西——最后一条 usage（当前上下文）、最后的 model、
  // 今日/本周聚合——全都在文件尾部，没有一样需要文件开头。
  //
  // 原先是无条件 `Bun.file(path).text()`：513MB 的会话一次就是 ~1.5GB JS 堆（实测放大
  // 3x，中文正文被 JSC 提升成 UTF-16），而 Stop hook 每回合触发、5 秒桶挡不住 3 秒防抖
  // → bridge RSS 棘轮涨到 3.4GB（2026-09-15 owner 报 OOM，全机 swap 3.9G）。
  //
  // ⚠ 终止条件刻意绑「整窗最早记录是否越过周界」这个**语义**，而不是按当时文件大小
  // 拍一个常数——上面那条 5 秒桶缓存的注释写着「本机最大 96MB」，正是被文件涨到 513MB
  // 悄悄作废的前车之鉴。语义判据不会随文件长大而失效。
  //
  // ⚠ 为什么不在反向扫描里遇到 `ts < weekTs` 就 break：sidechain / tool_result 这类记录
  // 可能轻微乱序，提前 break 会少算用量。判断「整窗最早」对乱序免疫，而窗口本来就小。
  let win = Math.max(1, opts.tailStartBytes ?? STATS_TAIL_START_BYTES);
  for (;;) {
    const cut = Math.max(0, size - win);
    // slice 从半行中间起头：截断的首行 JSON.parse 会失败 → 被 catch 丢掉，天然安全，
    // 不需要额外对齐到行首。
    const lines = (await Bun.file(path).slice(cut).text()).split("\n");
    const { stats, oldestTs } = scanStatsWindow(lines, dayTs, weekTs);
    if (oldestTs < weekTs || cut === 0 || win >= STATS_TAIL_MAX_BYTES) {
      fileCache.set(path, { key, stats });
      return stats;
    }
    win *= 4;
  }
}

function resolveJsonl(agent: AgentLike): string | null {
  const cwd = agent.cwd || agent.dir;
  if (cwd && agent.sessionId) {
    const p = projectJsonlPath(cwd, agent.sessionId);
    if (existsSync(p)) return p;
  }
  if (agent.sessionId) return findJsonlBySessionId(agent.sessionId);
  return null;
}

/** 对一批 agent（通常来自 registry.json）算 per-agent 统计。跳过非 active 的。 */
export async function computeAgentStats(agents: AgentLike[]): Promise<AgentStat[]> {
  const out: AgentStat[] = [];
  for (const a of agents) {
    if (a.status && a.status !== "active") continue;
    const jsonl = resolveJsonl(a);
    const fs = jsonl
      ? await readFileStats(jsonl)
      : { contextTokens: 0, contextEstimated: false, today: { tokens: 0, requests: 0, costUsd: 0 }, week: { tokens: 0, requests: 0, costUsd: 0 }, model: "" };
    out.push({
      name: a.name,
      channelId: a.channelId || "",
      // 实际在跑的模型（jsonl 真相）优先；不是正常 claude- 模型（如 <synthetic>）时退回 registry
      model: fs.model.startsWith("claude-") ? fs.model : (a.model || fs.model || "?"),
      status: a.status || "active",
      contextTokens: fs.contextTokens,
      // v2.21.1+ 百分比优先按 statusline 落盘的真实窗口算(peer 2026-08-30:
      // 窗口因模型/1M beta 差 10 倍不止,硬按 1M 算的 pct 对 175K 窗口的 agent
      // 假到没法看)。缓存没有该 session → 退回 1M 天花板,行为如旧。
      contextPct: (() => {
        const ctx = a.sessionId ? readSessionCtx(a.sessionId) : null;
        const ceiling = ctx && ctx.window > 0 ? ctx.window : CONTEXT_CEILING;
        return Math.min(100, Math.round((fs.contextTokens / ceiling) * 100));
      })(),
      contextEstimated: fs.contextEstimated,
      today: fs.today,
      week: fs.week,
      jsonl,
    });
  }
  return out;
}

/** 1234567 → "1.2M" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(Math.round(n));
}
