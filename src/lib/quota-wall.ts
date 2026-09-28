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
  resumed: string[];
  /** 出闸时已经在跑、不续跑的 agent 名 */
  running: string[];
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
  exit?: { at: number; via: WallExitVia };
  recovery?: WallRecovery;
  recoveredNotifiedAt?: number;
  /** 闸里看到的用量缓存：见没见过 ≥100、第一次和最近一次看到的重置时刻（observeCache） */
  cache?: WallCacheSeen;
}

interface WallCacheSeen {
  full: boolean;
  firstWeek: number | null;
  firstSession: number | null;
  lastWeek: number | null;
  lastSession: number | null;
}

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

const isFull = (u: UsageSignal): boolean => [u.sessionPct, u.weekPct].some((p) => p !== null && p >= 100);

/**
 * 闸里每一拍记下缓存的样子。缓存的 scrapedAt 每次渲染都刷新、同一窗口的百分比只升不降，「比进闸新」不代表数据新：
 * 出闸只认「闸里见过满、后来降下来」或重置时刻变了（exitVia），撞墙那一刻停在 99% 的旧值不会把闸放开。
 */
export function observeCache(s: WallState, u: UsageSignal | null): WallState | null {
  const w = s.wall;
  if (!u || !w || w.exit || u.scrapedAt <= w.enteredAt) return null;
  const p = w.cache;
  const next: WallCacheSeen = {
    full: !!p?.full || isFull(u), firstWeek: p ? p.firstWeek : u.weekResetsAtMs, firstSession: p ? p.firstSession : u.sessionResetsAtMs,
    lastWeek: u.weekResetsAtMs, lastSession: u.sessionResetsAtMs,
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
  if (prev?.exit && prev.exit.via !== "resets_at" && (!prev.cache || resetsAt === (week ? prev.cache.lastWeek : prev.cache.lastSession))) return no;
  const w = freshWall(s.wall, newId(), now, "usage_cache", week ? "weekly" : "session", resetsAt, null);
  w.cache = { full: true, firstWeek: u.weekResetsAtMs, firstSession: u.sessionResetsAtMs, lastWeek: u.weekResetsAtMs, lastSession: u.sessionResetsAtMs };
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
  const fromCache = w.kind === "weekly" ? k?.lastWeek : w.kind === "session" ? k?.lastSession : Math.max(k?.lastWeek ?? 0, k?.lastSession ?? 0) || null;
  return fromCache && fromCache > w.enteredAt ? fromCache : w.enteredAt + FALLBACK_SPAN_MS[w.kind];
}

/** 该不该出闸、因为什么；不该返回 null。只有进闸之后的观测才算（进闸前的 <100 是撞墙之前的旧值） */
export function exitVia(w: Wall, sig: ExitSignals): WallExitVia | null {
  if (w.exit) return null;
  if (sig.cli) return "cli";
  if (sig.limitsReset) return "limits_reset";
  if (sig.now >= wallUntil(w) + WALL_TIMING.exitSlackMs) return "resets_at";
  if (sig.probe && sig.probe.observedAt > w.enteredAt && sig.probe.pct !== null && sig.probe.pct < 100) return "probe";
  const c = sig.cache;
  const k = w.cache; // observeCache 先记过这一拍
  if (c && k && c.scrapedAt > w.enteredAt) {
    const pcts = [c.sessionPct, c.weekPct].filter((p): p is number => p !== null);
    const rolled = (a: number | null, b: number | null) => a !== null && b !== null && a !== b;
    const below = pcts.length > 0 && pcts.every((p) => p < 100);
    if (below && (k.full || rolled(k.firstWeek, c.weekResetsAtMs) || rolled(k.firstSession, c.sessionResetsAtMs))) return "usage_cache";
  }
  return null;
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
  const done = new Set(w.recovery?.resumed ?? []);
  return Object.entries(w.hits)
    .filter(([cid, h]) => !done.has(h.agent) && !hasQueued(cid))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([cid]) => cid);
}
