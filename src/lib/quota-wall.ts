/**
 * 额度闸（T24）的状态机——纯函数，时间与 IO 由调用方给；运行时接线在 bridge/quota-wall.ts，单测 tests/quota-wall.test.ts。
 *
 * 本机所有 Claude Code agent 共用一个订阅账号：一个撞墙 = 全部撞墙。闸开着时 bridge 不再唤醒注定失败的回合
 * （agent / bridge 合成的消息押后，人类消息照投），只通知 owner 一次；出闸后关菜单 → 按序补投 → 续跑。
 * Codex / Pi 各用各的额度，不进闸。状态落盘（statePath quota-wall.json），bridge 重启不丢；恢复分步记账，重启后接着做。
 */
import { statePath } from "./paths.js";
import type { WallHit, WallKind } from "./quota-wall-text.js";

export const QUOTA_WALL_PATH = statePath("quota-wall.json");
/** `manager quota-wall clear` 留下的请求（文件信箱：不加路由、bridge 不在线时请求也留着），bridge 下一拍取走 */
export const QUOTA_WALL_CLEAR_PATH = statePath("quota-wall-clear.req");

type WallSource = "api_error" | "usage_cache";
export type WallExitVia = "resets_at" | "limits_reset" | "probe" | "usage_cache" | "cli";

/** 撞墙（或闸内出别的 API 错误）的 agent：出闸时续跑它 */
interface WallAgentHit {
  agent: string;
  at: number;
  /** jsonl 条目的 error 字段（rate_limit / server_error …） */
  error: string;
}

type RecoveryStep = "menus" | "flush" | "resume" | "done";

export interface WallRecovery {
  step: RecoveryStep;
  /** 已发过 Esc 的频道（重启后不再发第二次）/ 画面对不上、要人处理的 agent 名 / 发了 Esc 菜单还在的 agent 名 */
  escSent: string[];
  manual: string[];
  escFailed?: string[];
  /** 出闸时转回普通押后的「额度闸」消息条数、涉及的频道（这些频道补投的消息自会叫醒它，不再另发续跑） */
  flushed: number;
  flushedTo?: string[];
  /** flushedTo 里补投了自己人（agent / bridge / owner）消息的频道；只补投了外人消息的照样续跑（没有 = 老状态，按 flushedTo） */
  wakers?: string[];
  resumed: string[];
  /** 出闸时已经在跑、不续跑的 agent 名 */
  running: string[];
  /** 续跑消息被押住了（窗口还停在 CC 的自动续跑倒计时 / 菜单上，没发键）：要人去窗口里处理的 agent 名 */
  held?: string[];
}

export interface Wall {
  id: string;
  enteredAt: number;
  source: WallSource;
  kind: WallKind;
  resetsAt: number | null;
  /** 原文里 "resets" 后那段（带时区），通知照写 */
  resetsText: string | null;
  /** channelId → 续跑名单 */
  hits: Record<string, WallAgentHit>;
  notifiedAt?: number;
  lastProbeAt?: number;
  /** 上一次到点探用量没探成（关着 / 凭据失败 / 退避中）：闸只能等回显、到点或人点「已恢复」，横幅和通知据此提醒 */
  probeDown?: boolean;
  exit?: { at: number; via: WallExitVia };
  recovery?: WallRecovery;
  recoveredNotifiedAt?: number;
  /** 闸里看到的用量缓存：见没见过 ≥100、第一次和最近一次看到的重置时刻（observeCache） */
  cache?: WallCacheSeen;
}

interface WallCacheSeen {
  /** 闸里见过这个窗口 ≥100 */
  fullWeek: boolean;
  fullSession: boolean;
  /** 这个窗口的重置时刻前进过（严格晚于之前见过的最晚那个）：窗口滚过去了。按窗口分：周墙里 5h 滚动不算 */
  rolledWeek: boolean;
  rolledSession: boolean;
  /** 见过的最晚重置时刻：写入脚本会把空闲会话里上一周期的旧值写回来，只认前进、不认「不相等」 */
  maxWeek: number | null;
  maxSession: number | null;
}

const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
const advanced = (seen: number | null, now: number | null): boolean => seen !== null && now !== null && now > seen;

export interface WallState {
  v: 1;
  wall: Wall | null;
}

export const WALL_TIMING = {
  /** 到了 resetsAt 再等这么久才出闸（CC 的重置时刻是整点，服务端可能慢几十秒） */
  exitSlackMs: 60_000,
  probeEveryMs: 5 * 60_000,
  /** 进闸后等这么久再通知 owner：同一波撞墙的 agent 先并进来，通知里的数字才准 */
  notifyDelayMs: 20_000,
  tickMs: 15_000,
} as const;

/** 人发的消息（Discord 用户 / 非 peer 的 API 用户）闸内照投：owner 可能正要去那个窗口 /limit-reset。按钮点击也算人 */
export const isHumanSender = (from: { kind: string; peer?: unknown }): boolean => from.kind === "user" || (from.kind === "api" && !from.peer);

/**
 * 过闸时这一封算不算人发的：人发的、且没打 meta.quotaGated。只有 fleet 群发文字打它：owner 直发给一个 agent 是明知它的状态，群发一次发一批、
 * 不清楚里面谁撞了墙，穿闸投进去只会白触发一轮报错（和批量压缩「撞墙没开 LP 的不发」同一口径）。ask 答复同样来自 owner、带 waitForIdle，不打它，照旧穿闸
 */
export const gatesAsHuman = (env: { from: { kind: string; peer?: unknown }; meta: { quotaGated?: boolean } }): boolean =>
  isHumanSender(env.from) && !env.meta.quotaGated;

export const emptyWallState = (): WallState => ({ v: 1, wall: null });

export function isWallState(x: unknown): boolean {
  const s = x as WallState | null;
  return !!s && typeof s === "object" && s.v === 1 && (s.wall === null || (typeof s.wall === "object" && typeof s.wall.enteredAt === "number"));
}

/** 闸开着（还没出闸）；出闸后恢复做完之前 wall 还留着，但不再押消息 */
export const wallActive = (s: WallState): boolean => !!s.wall && !s.wall.exit;

const KIND_RANK: Record<WallKind, number> = { unknown: 0, session: 1, weekly: 2 };

/** 并入一次撞墙的种类与重置时刻：种类取更重的；重置时刻取更晚的（周额度墙里再撞 session 墙，出闸以周为准） */
function mergeReset(w: Wall, kind: WallKind, resetsAt: number | null, resetsText: string | null): void {
  if (KIND_RANK[kind] > KIND_RANK[w.kind]) w.kind = kind;
  if (resetsAt !== null && (w.resetsAt === null || resetsAt > w.resetsAt)) {
    w.resetsAt = resetsAt;
    w.resetsText = resetsText;
  }
}

/** 上一道闸的恢复还没做完就又撞墙：它名单里还没续跑的 agent 带进新闸，出新闸时一起续（否则它们就没人管了） */
function freshWall(prev: Wall | null, id: string, at: number, source: WallSource, kind: WallKind, resetsAt: number | null, resetsText: string | null): Wall {
  const hits: Record<string, WallAgentHit> = {};
  if (prev?.recovery && prev.recovery.step !== "done") {
    const done = new Set([...prev.recovery.resumed, ...prev.recovery.running]);
    for (const [cid, h] of Object.entries(prev.hits)) if (!done.has(h.agent)) hits[cid] = h;
  }
  return { id, enteredAt: at, source, kind, resetsAt, resetsText, hits, lastProbeAt: at };
}

export interface HitInput {
  channelId: string;
  agent: string;
  at: number;
  error: string;
  parsed: WallHit;
}

/**
 * 一个 CC agent 的回合以撞墙结束：没闸（或上一道已出闸）就开一道新闸，有闸就并进去（同一次撞墙只算一次）。
 * 返回新状态；entered = 这次新开了闸。
 */
export function noteWallHit(s: WallState, h: HitInput, newId: () => string): { state: WallState; entered: boolean } {
  const cur = wallActive(s) ? structuredClone(s.wall!) : null;
  const w = cur ?? freshWall(s.wall, newId(), h.at, "api_error", h.parsed.kind, h.parsed.resetsAt, h.parsed.resetsText);
  if (cur) mergeReset(w, h.parsed.kind, h.parsed.resetsAt, h.parsed.resetsText);
  w.hits[h.channelId] = { agent: h.agent, at: h.at, error: h.error };
  return { state: { v: 1, wall: w }, entered: !cur };
}

/** 闸内别的 API 错误（非额度，PM 09-28）：也记进续跑名单、出闸再续——闸内续跑只会再撞一次墙。闸外返回 null，走原来的 60 秒续跑 */
export function noteOtherError(s: WallState, h: Omit<HitInput, "parsed">): WallState | null {
  if (!wallActive(s)) return null;
  const w = structuredClone(s.wall!);
  w.hits[h.channelId] = { agent: h.agent, at: h.at, error: h.error };
  return { v: 1, wall: w };
}

/** 撞墙之后它又真的动了（人类发消息后跑起来了）：不用再续跑，从名单里拿掉。错误条目自己带出的活动在 graceMs 内不算 */
export function noteWallActivity(s: WallState, channelId: string, ts: number, graceMs: number): WallState | null {
  const hit = s.wall?.hits[channelId];
  if (!hit || ts <= hit.at + graceMs || s.wall?.recovery?.step === "done") return null;
  const w = structuredClone(s.wall!);
  delete w.hits[channelId];
  return { v: 1, wall: w };
}

/**
 * 哪些事件说明它撞墙之后真的又跑起来了（从续跑名单拿掉）：jsonl 里出了新东西（工具调用 / 正文 / 新 assistant 条目）、
 * 它往外发了消息。投递时的 agent_status thinking、送进来的 chat_message 不算——菜单还开着的会话收到消息并不会动。
 */
export function countsAsWallActivity(type: string, data: Record<string, unknown>): boolean {
  if (type === "tool_start") return true;
  if (type === "chat_message") return data.direction === "out";
  if (type === "agent_status") return data.status === "thinking" && data.trigger === "jsonl_activity";
  if (type === "assistant_text") return data.rateLimited !== true && data.apiError !== true && !String(data.text ?? "").startsWith("API Error");
  return false;
}

/** statusline 落盘的用量（lib/usage-cache.ts 的 CachedUsage 的子集） */
export interface UsageSignal {
  sessionPct: number | null;
  weekPct: number | null;
  sessionResetsAtMs: number | null;
  weekResetsAtMs: number | null;
  scrapedAt: number;
}

const notPassed = (at: number | null, now: number) => at === null || at > now;

const full = (p: number | null): boolean => p !== null && p >= 100;

/**
 * 闸里每一拍记下缓存的样子。缓存的 scrapedAt 每次渲染都刷新、同一窗口的百分比只升不降，「比进闸新」不代表数据新：
 * 出闸只认「闸里见过满、后来降下来」或重置时刻变了（exitVia），撞墙那一刻停在 99% 的旧值不会把闸放开。
 */
export function observeCache(s: WallState, u: UsageSignal | null): WallState | null {
  const w = s.wall;
  if (!u || !w || w.exit || u.scrapedAt <= w.enteredAt) return null;
  const p = w.cache && "fullWeek" in w.cache ? w.cache : undefined; // 老形状（不分窗口）：丢掉重新看，只会出闸更晚
  // 重置时刻已经过了的是旧周期的写者：不计满、不计入 max——闸里第一眼看到它的话，拿它打底，当前周期的正常写入就成了「滚动」
  // （adv3 P2-3）。不拿报错原文的重置时刻打底：原文只到分钟，缓存是精确时刻，差几秒就会被当成滚过去
  const live = (ms: number | null): number | null => (ms !== null && ms > u.scrapedAt ? ms : null);
  const [weekAt, sessionAt] = [live(u.weekResetsAtMs), live(u.sessionResetsAtMs)];
  const next: WallCacheSeen = {
    fullWeek: !!p?.fullWeek || (weekAt !== null && full(u.weekPct)), fullSession: !!p?.fullSession || (sessionAt !== null && full(u.sessionPct)),
    rolledWeek: !!p && (p.rolledWeek || advanced(p.maxWeek, weekAt)),
    rolledSession: !!p && (p.rolledSession || advanced(p.maxSession, sessionAt)),
    maxWeek: later(p?.maxWeek ?? null, weekAt), maxSession: later(p?.maxSession ?? null, sessionAt),
  };
  if (p && JSON.stringify(p) === JSON.stringify(next)) return null;
  return { v: 1, wall: { ...structuredClone(w), cache: next } };
}

/**
 * 用量缓存说某个窗口 ≥100% 且重置时刻未过 → 进闸（没闸时）。周优先。
 * 上一道闸出闸之前抓的缓存不算；上一道不是「到点」出的（用卡 / clear / 探测）时，同一窗口的重置时刻没变就不从缓存进：
 * 用卡不改周重置日，还没发新请求的窗口一渲染就把撞墙时的 100% 写回去，拿它进闸就会刚出又进。真撞了自有 api_error_turn。
 */
export function enterFromUsage(s: WallState, u: UsageSignal, now: number, newId: () => string): { state: WallState; entered: boolean } {
  const no = { state: s, entered: false };
  if (wallActive(s) || (s.wall?.exit && u.scrapedAt <= s.wall.exit.at)) return no;
  const week = u.weekPct !== null && u.weekPct >= 100 && notPassed(u.weekResetsAtMs, now);
  const session = u.sessionPct !== null && u.sessionPct >= 100 && notPassed(u.sessionResetsAtMs, now);
  if (!week && !session) return no;
  const resetsAt = week ? u.weekResetsAtMs : u.sessionResetsAtMs;
  const prev = s.wall;
  // 上一道闸没观察过缓存（api_error 进的）就拿原文的重置时刻比；两样都没有才不从缓存进
  const seen = prev && (week ? prev.cache?.maxWeek : prev.cache?.maxSession) || (prev?.kind === (week ? "weekly" : "session") ? prev.resetsAt : null);
  if (prev?.exit && prev.exit.via !== "resets_at" && !advanced(seen ?? null, resetsAt)) return no;
  const w = freshWall(s.wall, newId(), now, "usage_cache", week ? "weekly" : "session", resetsAt, null);
  w.cache = { fullWeek: full(u.weekPct), fullSession: full(u.sessionPct), rolledWeek: false, rolledSession: false, maxWeek: u.weekResetsAtMs, maxSession: u.sessionResetsAtMs };
  return { state: { v: 1, wall: w }, entered: true };
}

export interface ExitSignals {
  now: number;
  cli?: boolean;
  /** 某个窗口新出现了「Limits reset」回显（owner 用了卡） */
  limitsReset?: boolean;
  /** T2b-2 只读用量接口：两个窗口里较高的那个百分比 + 观测时刻 */
  probe?: { pct: number | null; observedAt: number } | null;
  cache?: UsageSignal | null;
}

/** 原文没写重置时间 / 认不出时的兜底上限：session 墙最长 5 小时、周墙 7 天；过了就当到点出闸（再撞会再进，好过永远等人） */
const FALLBACK_SPAN_MS = { weekly: 7 * 86_400_000, session: 5 * 3_600_000, unknown: 5 * 3_600_000 } as const;

/** 这道闸按什么时刻到点：原文的重置时刻 → 闸里看到的缓存重置时刻 → 进闸时刻 + 兜底上限 */
export function wallUntil(w: Wall): number {
  if (w.resetsAt !== null) return w.resetsAt;
  const k = w.cache;
  const fromCache = w.kind === "weekly" ? k?.maxWeek : w.kind === "session" ? k?.maxSession : later(k?.maxWeek ?? null, k?.maxSession ?? null);
  return fromCache && fromCache > w.enteredAt ? fromCache : w.enteredAt + FALLBACK_SPAN_MS[w.kind];
}

/** 该不该出闸、因为什么；不该返回 null。只有进闸之后的观测才算（进闸前的 <100 是撞墙之前的旧值） */
export function exitVia(w: Wall, sig: ExitSignals): WallExitVia | null {
  if (w.exit) return null;
  if (sig.cli) return "cli";
  if (sig.limitsReset) return "limits_reset";
  if (sig.now >= wallUntil(w) + WALL_TIMING.exitSlackMs) return "resets_at";
  if (sig.probe && sig.probe.observedAt > w.enteredAt && sig.probe.pct !== null && sig.probe.pct < 100) return "probe";
  const k = w.cache; // observeCache 先记过这一拍
  const c = sig.cache;
  const probeFull = !!sig.probe && sig.probe.pct !== null && sig.probe.pct >= 100 && !!c && sig.probe.observedAt >= c.scrapedAt; // 比缓存新的探测说还满：不让缓存盖掉
  if (c && k && "fullWeek" in k && c.scrapedAt > w.enteredAt && !probeFull && cacheSaysBelow(w.kind, c, k)) return "usage_cache";
  return null;
}

/**
 * 缓存说撞墙的那个窗口下来了。按窗口看：周墙只看 7d、session 墙只看 5h，另一个窗口滚动不算；那个窗口读不到（null）= 不知道。
 * 两种墙都只认那个窗口的重置时刻前进、且百分比已经 <100：旧会话的写者会把上一周期的低百分比写回来，「见过满后来降了」不可信。
 * unknown 墙看闸里见过满的窗口。
 */
function cacheSaysBelow(kind: WallKind, c: UsageSignal, k: WallCacheSeen): boolean {
  const week = kind === "weekly" || k.fullWeek;
  const session = kind === "session" || k.fullSession;
  if (!week && !session) return false;
  if (week && !(c.weekPct !== null && c.weekPct < 100 && k.rolledWeek)) return false;
  return !session || (c.sessionPct !== null && c.sessionPct < 100 && k.rolledSession);
}

export function markExit(s: WallState, via: WallExitVia, now: number): WallState {
  if (!s.wall || s.wall.exit) return s;
  const w = structuredClone(s.wall);
  w.exit = { at: now, via };
  w.recovery = { step: "menus", escSent: [], manual: [], flushed: 0, resumed: [], running: [] };
  return { v: 1, wall: w };
}

export const probeDue = (w: Wall, now: number): boolean => !w.exit && now - (w.lastProbeAt ?? w.enteredAt) >= WALL_TIMING.probeEveryMs;

export const notifyDue = (w: Wall, now: number): boolean => !w.exit && w.notifiedAt === undefined && now - w.enteredAt >= WALL_TIMING.notifyDelayMs;

/** 出闸时要续跑谁：名单里、队里没有待投给它的消息（补投的消息自会叫醒它）、此刻主回合不在跑（菜单关掉后自己接着跑了的不打扰） */
export function resumeTargets(w: Wall, hasQueued: (channelId: string) => boolean): string[] {
  // 续跑过、押着续跑消息、出闸那一刻在跑的都算处理过：恢复做到一半重启后再走一遍，会给同一个 agent 再押一条续跑、多跑一轮
  const r = w.recovery;
  const done = new Set([...(r?.resumed ?? []), ...(r?.held ?? []), ...(r?.running ?? [])]);
  return Object.entries(w.hits)
    .filter(([cid, h]) => !done.has(h.agent) && !hasQueued(cid))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([cid]) => cid);
}
