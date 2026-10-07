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

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "fs";
import { firstSeen, usageDedupKey } from "./jsonl-cost.js";
import {
  findSessionJsonlBySessionId,
  runtimeForSessionPath,
  sessionJsonlPath,
  statsFoldFor,
  translateSessionLine,
} from "./session-source.js";
import { readSessionCtx } from "./usage-cache.js";
import { currentUsageWindow, windowFloor, windowsFor, type UsageWindowBounds } from "./usage-window.js";

export interface UsageWindow {
  tokens: number;
  requests: number;
  /** 按 API 牌价折算的成本（USD）。订阅制不按此扣费，仅供参考。 */
  costUsd: number;
  /**
   * 运行时报告的费用（USD，目前只有 Pi 在会话记录里写 usage.cost）。带了它的记录不再按
   * 牌价折算进 costUsd——两种钱互不重叠，前端分开显示；老前端只读 costUsd，不受影响。
   */
  reportedCostUsd: number;
}

function emptyUsageWindow(): UsageWindow {
  return { tokens: 0, requests: 0, costUsd: 0, reportedCostUsd: 0 };
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
  /** 运行时（claude-code | codex | pi）：用量看板按它分行——各家窗口/计费口径不同 */
  runtime: string;
  /** registry 的 projectId：看板按它找上下文边界策略（bridge/ctx-boundary.ts） */
  projectId?: string;
}

export interface AgentLike {
  name: string;
  channelId?: string;
  status?: string;
  cwd?: string;
  dir?: string;
  sessionId?: string;
  model?: string;
  /** v2.23+ 运行时（registry 字段）：决定会话文件怎么定位 */
  runtime?: string;
  projectId?: string;
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

export interface FileStats {
  contextTokens: number;
  contextEstimated: boolean;
  today: UsageWindow;
  week: UsageWindow;
  /** 最后一条 assistant 实际用的 model（真相），可能跟 registry 钉的不一样 */
  model: string;
  /** 会话记录自带的上下文窗口（Codex 的 model_context_window）；没有 = 用 statusline 缓存或 1M */
  contextWindow?: number | null;
}

function emptyFileStats(): FileStats {
  return { contextTokens: 0, contextEstimated: false, today: emptyUsageWindow(), week: emptyUsageWindow(), model: "" };
}

/**
 * 一个尾读窗口 → 统计。`fromFileStart` = 窗口从文件第一字节开始（累计计数器可从 0 起算）；
 * `oldestTs` 由扫描器自己定义「窗口已回溯到哪」，readFileStats 据此决定要不要扩窗。
 */
export type StatsWindowScanner = (
  lines: string[],
  dayTs: number,
  weekTs: number,
  fromFileStart: boolean,
) => { stats: FileStats; oldestTs: number };

/**
 * 可续读的统计折叠：按文件顺序喂行（可分多次，从上次停下的整行接着喂），随时按某个今日 / 本周界出结果。
 * readFileStats 靠它做到「文件追加只读新增字节」。`oldestTs` 的含义同 StatsWindowScanner。
 * `floor` = 回溯下界：早于它的用量不留（结果的窗口只会往后挪，往前挪由 readFileStats 整窗重读）。
 */
interface StatsFold {
  feed(lines: string[]): void;
  oldestTs(): number;
  result(dayTs: number, weekTs: number): FileStats;
}
export type StatsFoldFactory = (opts: { runtime: string | undefined; floor: number; fromFileStart: boolean }) => StatsFold;

/** 统计尾读的起始窗口。实测本机最大会话（513MB）只需尾部 4MB 就回溯过周界，8MB 留一倍余量。 */
const STATS_TAIL_START_BYTES = 8 * 1024 * 1024;
/**
 * 尾读窗口上限。真有 agent 一周写超过这个量，用量数字会少算一截——但那是个**显示值**，
 * 而无上限扩窗是会把 bridge 拖进 OOM 的（session-history 的 `win *= 8` 就是现成教训）。
 */
const STATS_TAIL_MAX_BYTES = 128 * 1024 * 1024;

const isCompactSummary = (rec: any): boolean => rec.type === "user" && rec.isCompactSummary === true;

/** compact 摘要 → 新上下文估算（底座 + 摘要文本/4） */
function compactEstimate(rec: any): number {
  const c = rec?.message?.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
        : "";
  return POST_COMPACT_BASE_TOKENS + Math.round(text.length / 4);
}

const usageContext = (u: any): number =>
  Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);

interface UsageAmount { ts: number; tok: number; cost: number; reported: number }

/**
 * 一条 assistant usage 计多少。折算成本按**该条记录自己的 model** 计价——会话中途换过模型的历史各按各价；
 * 运行时自己报了费用（Pi）就记那一笔，不再按牌价估一遍（两种钱不重叠）
 */
function usageAmount(ts: number, rec: any, u: any): UsageAmount {
  const reported = typeof u.runtime_reported_cost_usd === "number" ? u.runtime_reported_cost_usd : null;
  return {
    ts,
    tok: usageContext(u) + Number(u.output_tokens || 0),
    cost: reported === null ? costOfUsage(String(rec?.message?.model || ""), u) : 0,
    reported: reported ?? 0,
  };
}

function addAmount(w: UsageWindow, a: UsageAmount): void {
  w.tokens += a.tok;
  w.requests += 1;
  w.costUsd += a.cost;
  w.reportedCostUsd += a.reported;
}

/**
 * 扫描一段 jsonl 行，算出上下文 + 今日 + 本周。纯函数，不碰文件系统（可单测）。
 *
 * 返回的 `oldestTs` 是本段里最早的一条时间戳，调用方据此判断窗口是否已经回溯过周界。
 * 取 Infinity 表示整段没有一条可解析的时间戳。
 * `seen` 是跨调用共享的去重集合（全机扫描跨文件共用一份）；不传 = 本段内去重。
 */
export function scanStatsWindow(
  lines: string[],
  dayTs: number,
  weekTs: number,
  /** v2.23+ 会话 runtime；由 readFileStats 按路径判定**一次**传入，别在每行里重算 */
  runtime?: string,
  seen: Set<string> = new Set(),
  /** 额外的分组累加器（全机扫描按 Pi 接入商拆）：返回 null = 这条只进总账 */
  bucket?: (rec: any) => { today: UsageWindow; week: UsageWindow } | null,
): { stats: FileStats; oldestTs: number } {
  const today = emptyUsageWindow();
  const week = emptyUsageWindow();
  let contextTokens = 0;
  let contextEstimated = false;
  let model = "";
  let ctxFound = false;
  let oldestTs = Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let rec: any;
    // v2.23+ Pi 行归一（usage 键名 input/output/cacheRead/cacheWrite → CC 口径）；
    // Claude Code 行原样 JSON.parse。坏行返回 null → 跳过。
    rec = translateSessionLine(runtime, line);
    if (!rec) continue;
    // 窗口是否已回溯过周界，由「整窗最早的时间戳」判定（见 readFileStats 的注释）
    {
      const t = Date.parse(rec?.timestamp);
      if (Number.isFinite(t) && t < oldestTs) oldestTs = t;
    }
    // compact 后还没新对话：尾扫会先遇到 compact 摘要而不是带 usage 的 assistant。
    // 这时最后一条 usage 是**压缩前**的旧值（owner 2026-07-09 报告：compact 完很久
    // 不聊天，看板一直显示压缩前的红色大数）。真实值要等下一轮对话才有，先按
    // 底座 + 摘要文本/4 估算，标记 estimated 让展示层加「~」。
    if (!ctxFound && isCompactSummary(rec)) {
      contextTokens = compactEstimate(rec);
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
      contextTokens = usageContext(u);
      ctxFound = true;
    }
    const ts = new Date(rec.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < windowFloor(dayTs, weekTs)) continue;
    if (!firstSeen(seen, rec)) continue; // 从尾往前扫：同一响应先遇到的是最后写的那行（usage 最完整）
    const amt = usageAmount(ts, rec, u);
    const extra = bucket?.(rec);
    const targets = windowsFor(ts, dayTs, weekTs, today, week);
    if (extra) targets.push(...windowsFor(ts, dayTs, weekTs, extra.today, extra.week));
    for (const w of targets) addAmount(w, amt);
  }
  return { stats: { contextTokens, contextEstimated, today, week, model }, oldestTs };
}

/**
 * Claude Code / Pi 的续读折叠：与 scanStatsWindow 同口径，只是按文件顺序走——
 * 「从尾往前第一个」= 「顺着走最后一个」；同一响应（usageDedupKey）后写的行覆盖先写的（usage 最完整）。
 * 早于 floor 的那行不覆盖：与倒扫「先判时间、再判去重」一致。单测 tests/agent-stats-incremental.test.ts 对拍两者。
 */
export const ccStatsFold: StatsFoldFactory = ({ runtime, floor }) => {
  let contextTokens = 0;
  let contextEstimated = false;
  let model = "";
  let oldestTs = Infinity;
  let keyed = new Map<string, UsageAmount>();
  let unkeyed: UsageAmount[] = [];
  const feed = (lines: string[]) => {
    for (const line of lines) {
      if (!line) continue;
      const rec = translateSessionLine(runtime, line);
      if (!rec) continue;
      const t = Date.parse(rec?.timestamp);
      if (Number.isFinite(t) && t < oldestTs) oldestTs = t;
      if (isCompactSummary(rec)) {
        contextTokens = compactEstimate(rec);
        contextEstimated = true;
        continue;
      }
      const u = rec.type === "assistant" ? rec?.message?.usage : null;
      if (!u) continue;
      model = String(rec?.message?.model || "") || model;
      contextTokens = usageContext(u);
      contextEstimated = false;
      if (!Number.isFinite(t) || t < floor) continue;
      const amt = usageAmount(t, rec, u);
      const k = usageDedupKey(rec);
      if (k === null) unkeyed.push(amt);
      else keyed.set(k, amt);
    }
  };
  const result = (dayTs: number, weekTs: number): FileStats => {
    const today = emptyUsageWindow();
    const week = emptyUsageWindow();
    const lo = windowFloor(dayTs, weekTs);
    // 掉出窗口的不再留：窗口只会往后挪（往前挪 readFileStats 会整窗重读），常驻内存封顶在一周的用量条数
    keyed = new Map([...keyed].filter(([, a]) => a.ts >= lo));
    unkeyed = unkeyed.filter((a) => a.ts >= lo);
    for (const a of [...unkeyed, ...keyed.values()]) {
      for (const w of windowsFor(a.ts, dayTs, weekTs, today, week)) addAmount(w, a);
    }
    return { contextTokens, contextEstimated, today, week, model };
  };
  return { feed, oldestTs: () => oldestTs, result };
};

const READ_CHUNK_BYTES = 2 * 1024 * 1024;
/**
 * 续读前核对的「上次读到处之前」的字节数：同一 inode 被原地截断再写长，大小对得上也能认出来。
 * 要跨过整行：jsonl 行尾长得都一样（usage 字段收尾），只比几十字节会把不同内容认成同一份（单测踩过）。
 */
const FINGERPRINT_BYTES = 4096;
/** 多久没被问到的文件扔掉续读状态（/clear 换会话、agent 被 kill 后旧文件不再有人问） */
const TAIL_IDLE_MS = 60 * 60_000;

interface TailState {
  ino: number;
  /** 已喂进折叠的字节（停在整行末尾；写了一半的末行留到下次） */
  offset: number;
  mtimeMs: number;
  /** 出过结果的最高回溯下界：比它更早的用量已被折叠丢掉，窗口往前挪就得整窗重读 */
  floor: number;
  fingerprint: Buffer;
  fold: StatsFold;
  usedAt: number;
}
const tails = new Map<string, TailState>();

/** [from, to) 按块顺读，整行喂给折叠；返回最后一个整行之后的偏移。块大小封顶，单次读取的临时内存与文件大小无关 */
function feedRange(fd: number, fold: StatsFold, from: number, to: number): number {
  let pos = from;
  let consumed = from;
  let carry = Buffer.alloc(0);
  while (pos < to) {
    const buf = Buffer.alloc(Math.min(READ_CHUNK_BYTES, to - pos));
    const n = readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break; // 读的同时被截断：剩下的按没写过算，下次 stat 会发现变小、整窗重读
    pos += n;
    const joined = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
    const nl = joined.lastIndexOf(10);
    if (nl < 0) { carry = joined; continue; } // 一整块都在同一行中间
    fold.feed(joined.toString("utf8", 0, nl).split("\n"));
    carry = joined.subarray(nl + 1);
    consumed = pos - carry.length;
  }
  return consumed;
}

function fingerprintAt(fd: number, offset: number): Buffer {
  const len = Math.min(FINGERPRINT_BYTES, offset);
  const buf = Buffer.alloc(len);
  return buf.subarray(0, readSync(fd, buf, 0, len, offset - len));
}

/**
 * 整窗加载：尾读 8MB 起步，窗口里最早的记录没越过回溯下界就 ×4 扩窗（封顶 128MB）。
 * ⚠ 终止条件刻意绑「整窗最早记录是否越过周界」这个**语义**，而不是按当时文件大小拍常数——文件会长大，常数会悄悄作废。
 * ⚠ 不在遇到早于周界的记录时提前停：sidechain / tool_result 可能轻微乱序，提前停会少算。
 * 每次扩窗换一个新折叠从新起点顺读；读是分块的，峰值内存只有一块，不随窗口变大。
 */
function loadTail(fd: number, path: string, size: number, floor: number, tailStartBytes: number): Omit<TailState, "ino" | "mtimeMs" | "usedAt"> {
  const runtime = runtimeForSessionPath(path);
  const factory = statsFoldFor(runtime) ?? ccStatsFold;
  for (let win = Math.max(1, tailStartBytes); ; win *= 4) {
    const cut = Math.max(0, size - win);
    // 从半行中间起头：截断的首行解析失败被丢掉，天然安全，不需要对齐到行首
    const fold = factory({ runtime, floor, fromFileStart: cut === 0 });
    const offset = feedRange(fd, fold, cut, size);
    if (fold.oldestTs() < floor || cut === 0 || win >= STATS_TAIL_MAX_BYTES) {
      return { offset, floor, fingerprint: fingerprintAt(fd, offset), fold };
    }
  }
}

/**
 * 一个会话文件的上下文 + 今日 + 本周。按 (inode, 已读偏移, 尾部指纹) 续读：
 *   没变 → 不读；追加 → 只读新增字节；截断 / 轮转 / 原地重写 / 窗口往前挪 → 整窗重读。
 * 原先每次调用都把每个文件的尾窗重读一遍（只有 5 秒桶缓存）：每个 Stop hook 的看板刷新要读全部 active agent，
 * 29 个 agent 一次 276MB，bridge 的分配器区每次冲高 300MB 再回落（BML-2，证据 ledger/reviews/BML-2-evidence.md）。
 */
export async function readFileStats(
  path: string,
  /** 尾读起始窗口；单测可调小来在小 fixture 上验扩窗路径（与 readSessionHistory 的 maxFullReadBytes 同约定） */
  opts: { tailStartBytes?: number; window?: UsageWindowBounds } = {},
): Promise<FileStats> {
  const { dayStart: dayTs, weekStart: weekTs } = opts.window ?? currentUsageWindow();
  const floor = windowFloor(dayTs, weekTs);
  const now = Date.now();
  for (const [p, t] of tails) if (now - t.usedAt > TAIL_IDLE_MS) tails.delete(p);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { tails.delete(path); return emptyFileStats(); } // 不存在 / 刚被挪走
  try {
    const st = fstatSync(fd); // 与读的是同一个打开的文件：open 与 stat 之间被轮转也对得上
    let s = tails.get(path);
    // 大小、mtime 都没动才免读指纹：mtime 精度有限，同一毫秒内的原地重写只能靠指纹认
    const untouched = s && st.size === s.offset && st.mtimeMs === s.mtimeMs;
    const reusable = s && s.ino === st.ino && st.size >= s.offset && floor >= s.floor
      && (untouched || fingerprintAt(fd, s.offset).equals(s.fingerprint));
    if (!s || !reusable) {
      s = { ...loadTail(fd, path, st.size, floor, opts.tailStartBytes ?? STATS_TAIL_START_BYTES), ino: st.ino, mtimeMs: st.mtimeMs, usedAt: now };
      tails.set(path, s);
    } else if (st.size > s.offset) {
      s.offset = feedRange(fd, s.fold, s.offset, st.size);
      s.fingerprint = fingerprintAt(fd, s.offset);
    }
    s.mtimeMs = st.mtimeMs;
    s.usedAt = now;
    s.floor = Math.max(s.floor, floor);
    return s.fold.result(dayTs, weekTs);
  } finally {
    closeSync(fd);
  }
}

function resolveJsonl(agent: AgentLike): string | null {
  const cwd = agent.cwd || agent.dir;
  if (cwd && agent.sessionId) {
    // v2.23+ runtime 感知：Pi 的会话文件在 ~/.pi/agent/sessions/ 下（文件名带时间戳）
    const p = sessionJsonlPath(agent.runtime, cwd, agent.sessionId);
    if (p && existsSync(p)) return p;
  }
  if (agent.sessionId) return findSessionJsonlBySessionId(agent.runtime, agent.sessionId);
  return null;
}

/** 对一批 agent（通常来自 registry.json）算 per-agent 统计（各自**当前会话**文件）。跳过非 active 的。 */
export async function computeAgentStats(agents: AgentLike[], window = currentUsageWindow()): Promise<AgentStat[]> {
  const out: AgentStat[] = [];
  for (const a of agents) {
    if (a.status && a.status !== "active") continue;
    const jsonl = resolveJsonl(a);
    const fs = jsonl ? await readFileStats(jsonl, { window }) : emptyFileStats();
    out.push({
      name: a.name,
      channelId: a.channelId || "",
      runtime: a.runtime || "claude-code",
      ...(a.projectId ? { projectId: a.projectId } : {}),

      // 实际在跑的模型（jsonl 真相）优先；占位模型（<synthetic> 之类）才退回 registry。
      // ⚠ 原来判据是 startsWith("claude-")，Pi agent 的模型是 provider/model 形式
      // （cc-switch-open-code-go/glm-5.3-flash），会被整条丢掉 → 看板显示 "?"。
      model: fs.model && !fs.model.startsWith("<") ? fs.model : (a.model || fs.model || "?"),
      status: a.status || "active",
      contextTokens: fs.contextTokens,
      // v2.21.1+ 百分比优先按 statusline 落盘的真实窗口算(peer 2026-08-30:
      // 窗口因模型/1M beta 差 10 倍不止,硬按 1M 算的 pct 对 175K 窗口的 agent
      // 假到没法看)。缓存没有该 session → 退回 1M 天花板,行为如旧。
      contextPct: (() => {
        const ctx = a.sessionId ? readSessionCtx(a.sessionId) : null;
        const ceiling = ctx && ctx.window > 0 ? ctx.window : fs.contextWindow || CONTEXT_CEILING;
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
