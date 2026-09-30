/**
 * Codex 额度墙（T78）的状态机——纯函数，时间与 IO 由调用方给；运行时在 bridge/codex-wall.ts，单测 tests/codex-wall.test.ts。
 *
 * 和 CC 的额度闸（lib/quota-wall.ts）分开：CC 闸按「本机一个 Claude 订阅」闸 CC 窗口，这道墙按 Codex 账号（额度调度器的
 * current.codex 键）闸 Codex agent。本机同一时刻只登录一个 Codex 账号，所以只有一道墙，记下它属于哪个账号：换号 = 墙没了。
 * 墙在时发给 Codex agent 的 agent / bridge 消息押后（人发的照投）；出墙后按「补投 → 续跑 → 收卡 → 告诉 caller → 告诉 owner」恢复，
 * 每步落盘（codex-wall.json，与 quota-wall.json 分开），bridge 重启后从当前那步接着做。
 */
import { parseResetAt } from "./autopilot-run.js";
import { t } from "./i18n.js";
import { statePath } from "./paths.js";
import type { WallRecovery } from "./quota-wall.js";
import { isLimitHitText, parseWallText } from "./quota-wall-text.js";

export const CODEX_WALL_PATH = statePath("codex-wall.json");
/** `manager codex-wall clear` 留下的请求（文件信箱，同 quota-wall clear），bridge 下一拍取走 */
export const CODEX_WALL_CLEAR_PATH = statePath("codex-wall-clear.req");

type CodexWallSource = "turn_failure" | "usage";
/** usage = codex_usage 回落；account = 换了 Codex 账号；resets_at = 探测不可用时到 try-again 时刻兜底 */
export type CodexExitVia = "usage" | "cli" | "account" | "resets_at";

/** 墙里回合失败的 Codex agent：出墙时续跑它；callers = 当时在等它答复的 agent 频道（它们收到了 ⛔，出墙时告诉它们一声） */
interface CodexHit {
  agent: string;
  at: number;
  callers: string[];
}

type RecoveryStep = "flush" | "resume" | "cards" | "callers" | "owner" | "done";

/** 补投 / 续跑的记账字段与 CC 闸同义（flushed / flushedTo / wakers / resumed / running / held，见 lib/quota-wall.ts WallRecovery） */
export interface CodexRecovery extends Pick<WallRecovery, "flushed" | "flushedTo" | "wakers" | "resumed" | "running" | "held"> {
  step: RecoveryStep;
  /** 收起的额度卡张数 */
  cards?: number;
  /** 已经告诉过的 caller 频道 */
  told: string[];
}

export interface CodexWall {
  id: string;
  /** 进墙时的 Codex 账号键（HMAC 过的）；额度服务关着 / 读不到 = null */
  account: string | null;
  enteredAt: number;
  source: CodexWallSource;
  /** 原文里 try again 的时刻；认不出 = null */
  resetsAt: number | null;
  resetsText: string | null;
  /** channelId → 续跑名单 */
  hits: Record<string, CodexHit>;
  /** 墙里见过的重置卡张数（取最近一次）：变少了 = owner 兑了卡，立刻复查 */
  credits: number | null;
  lastProbeAt?: number;
  /** 到了 try-again 时刻已经复查过一次 */
  resetProbed?: boolean;
  /** 上一次探用量没探成（额度服务关着 / 凭据失败 / 退避中）：只能等到点或人手 clear */
  probeDown?: boolean;
  exit?: { at: number; via: CodexExitVia };
  recovery?: CodexRecovery;
  /** 出墙之后见过用量 <100：之后再见到 ≥100 才从用量进墙（人手 clear / 到点出的墙，接口还显示满时不马上又进） */
  belowAfterExit?: boolean;
}

export interface CodexWallState {
  v: 1;
  wall: CodexWall | null;
}

/** 调度器视图里 codex_usage 的样子（bridge/quota-service.ts codexWall） */
export interface CodexUsageSignal {
  account: string | null;
  /** 5h / 7d 两个窗口里较高的那个；没有窗口 = null */
  usedPct: number | null;
  limitReached: boolean;
  observedAt: number;
  /** 持有的重置卡张数（codex_usage 与 codex_reset_credits 里较新的那个）；不知道 = null */
  credits: number | null;
}

export const CODEX_WALL_TIMING = {
  probeEveryMs: 5 * 60_000,
  /** 到了 try-again 再等这么久复查 / 兜底出墙 */
  exitSlackMs: 60_000,
  /** 原文没有 try again 时刻、探测又不可用：这么久之后兜底出墙（再撞会再进，好过永远等人） */
  fallbackSpanMs: 5 * 3_600_000,
  /** 探过之后拿到的快照比这更旧 = 其实没探成（被间隔 / 冷却挡掉了） */
  probeFreshMs: 60_000,
  tickMs: 15_000,
} as const;

export const emptyCodexWallState = (): CodexWallState => ({ v: 1, wall: null });

export function isCodexWallState(x: unknown): boolean {
  const s = x as CodexWallState | null;
  return !!s && typeof s === "object" && s.v === 1 && (s.wall === null || (typeof s.wall === "object" && typeof s.wall.enteredAt === "number" && !!s.wall.hits));
}

/** 墙在（还没出墙）；出墙后恢复做完之前 wall 还留着，但不再押消息 */
export const codexWallActive = (s: CodexWallState): boolean => !!s.wall && !s.wall.exit;

/** 恢复做完了（或从没有过墙）：可以开新墙、清孤儿押后 */
export const codexWallIdle = (s: CodexWallState): boolean => !s.wall || (!!s.wall.exit && s.wall.recovery?.step === "done");

/**
 * Codex 的 ⛔ 条目算不算账号撞墙：watcher 已按结构化字段标了 rateLimited，这里只排除单个模型的额度（「reached your gpt-5 limit」：
 * 换模型就能接着用，不闸整个账号）。原文认不出是哪种（ACP 给的措辞不一定是这几句）按账号墙算
 */
export const isCodexAccountWall = (text: string): boolean => !isLimitHitText(text) || !!parseWallText(text, 0);

/** 上一道墙恢复还没做完就又撞：它名单里还没续跑的带进新墙（同 CC 闸 freshWall） */
function freshWall(prev: CodexWall | null, id: string, at: number, source: CodexWallSource, account: string | null): CodexWall {
  const hits: Record<string, CodexHit> = {};
  if (prev?.recovery && prev.recovery.step !== "done") {
    const done = new Set([...prev.recovery.resumed, ...prev.recovery.running, ...(prev.recovery.held ?? [])]);
    for (const [cid, h] of Object.entries(prev.hits)) if (!done.has(h.agent)) hits[cid] = h;
  }
  return { id, account, enteredAt: at, source, resetsAt: null, resetsText: null, hits, credits: null, lastProbeAt: at };
}

export interface CodexHitInput {
  channelId: string;
  agent: string;
  at: number;
  text: string;
  account: string | null;
  callers: string[];
}

/** 一个 Codex agent 的回合以撞额度结束：没墙就开一道，有墙就并进去。重置时刻取更晚的；caller 取并集 */
export function noteCodexHit(s: CodexWallState, h: CodexHitInput, newId: () => string): { state: CodexWallState; entered: boolean } {
  const cur = codexWallActive(s) ? structuredClone(s.wall!) : null;
  const w = cur ?? freshWall(s.wall, newId(), h.at, "turn_failure", h.account);
  const resetsAt = parseResetAt(h.text, h.at);
  if (resetsAt !== null && (w.resetsAt === null || resetsAt > w.resetsAt)) {
    w.resetsAt = resetsAt;
    w.resetsText = /\btry again\s+(.+?)\s*$/i.exec(h.text.split("\n")[0])?.[1]?.replace(/[.。]$/, "") ?? null;
  }
  const prev = w.hits[h.channelId];
  w.hits[h.channelId] = { agent: h.agent, at: h.at, callers: [...new Set([...(prev?.callers ?? []), ...h.callers])].filter((c) => c !== h.channelId) };
  return { state: { v: 1, wall: w }, entered: !cur };
}

const full = (u: CodexUsageSignal): boolean => u.limitReached || (u.usedPct !== null && u.usedPct >= 100);
const below = (u: CodexUsageSignal): boolean => !u.limitReached && u.usedPct !== null && u.usedPct < 100;

/**
 * 用量说满了 → 进墙（没墙、上一道恢复做完时）。只认比上一道出墙新的观测；上一道是人手 clear / 到点出的，要先见过一次 <100
 * 才从用量进（接口还没刷新时不刚出又进；真撞了自有 ⛔ 条目进墙）
 */
export function enterFromUsage(s: CodexWallState, u: CodexUsageSignal, now: number, newId: () => string): { state: CodexWallState; entered: boolean } {
  const no = { state: s, entered: false };
  if (!codexWallIdle(s) || !full(u)) return no;
  const prev = s.wall;
  if (prev?.exit && u.observedAt <= prev.exit.at) return no;
  if (prev?.exit && (prev.exit.via === "cli" || prev.exit.via === "resets_at") && !prev.belowAfterExit) return no;
  const w = freshWall(prev, newId(), now, "usage", u.account);
  w.credits = u.credits;
  return { state: { v: 1, wall: w }, entered: true };
}

/** 出墙后记下「见过 <100」（enterFromUsage 用）；没变化返回 null */
export function noteBelowAfterExit(s: CodexWallState, u: CodexUsageSignal | null): CodexWallState | null {
  const w = s.wall;
  if (!u || !w?.exit || w.belowAfterExit || u.observedAt <= w.exit.at || !below(u)) return null;
  return { v: 1, wall: { ...structuredClone(w), belowAfterExit: true } };
}

/** 这道墙按什么时刻到点：原文的 try-again → 进墙时刻 + 兜底 */
const codexWallUntil = (w: CodexWall): number => w.resetsAt ?? w.enteredAt + CODEX_WALL_TIMING.fallbackSpanMs;

/** 重置卡比墙里上一次看到的少了：owner 兑了卡 */
export const creditsDropped = (w: CodexWall, credits: number | null): boolean => w.credits !== null && credits !== null && credits < w.credits;

/** 该探用量了：每 5 分钟一次，到了 try-again 时刻额外一次 */
export function codexProbeDue(w: CodexWall, now: number): boolean {
  if (w.exit) return false;
  if (now - (w.lastProbeAt ?? w.enteredAt) >= CODEX_WALL_TIMING.probeEveryMs) return true;
  return w.resetsAt !== null && !w.resetProbed && now >= w.resetsAt + CODEX_WALL_TIMING.exitSlackMs;
}

export interface CodexExitSignals {
  now: number;
  cli?: boolean;
  usage?: CodexUsageSignal | null;
  /** 这一拍探用量没探成 */
  probeDown?: boolean;
}

/** 该不该出墙、因为什么；不该返回 null。只认进墙之后的观测（进墙前的 <100 是撞墙之前的旧值） */
export function codexExitVia(w: CodexWall, sig: CodexExitSignals): CodexExitVia | null {
  if (w.exit) return null;
  if (sig.cli) return "cli";
  const u = sig.usage;
  if (u && w.account && u.account && u.account !== w.account) return "account";
  if (u && u.observedAt > w.enteredAt && below(u)) return "usage";
  if (sig.probeDown && sig.now >= codexWallUntil(w) + CODEX_WALL_TIMING.exitSlackMs) return "resets_at";
  return null;
}

export function markCodexExit(s: CodexWallState, via: CodexExitVia, now: number): CodexWallState {
  if (!s.wall || s.wall.exit) return s;
  const w = structuredClone(s.wall);
  w.exit = { at: now, via };
  w.recovery = { step: "flush", flushed: 0, resumed: [], running: [], told: [] };
  return { v: 1, wall: w };
}

/** 出墙时要续跑谁：名单里、没处理过、补投没叫醒它的；按撞墙先后 */
export function codexResumeTargets(w: CodexWall, woken: (channelId: string) => boolean): string[] {
  const r = w.recovery;
  const done = new Set([...(r?.resumed ?? []), ...(r?.held ?? []), ...(r?.running ?? [])]);
  return Object.entries(w.hits)
    .filter(([cid, h]) => !done.has(h.agent) && !woken(cid))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([cid]) => cid);
}

/** 要告诉哪些 caller、各是哪几个 agent 恢复了（已告诉过的不再说） */
export function callersToTell(w: CodexWall): Map<string, string[]> {
  const told = new Set(w.recovery?.told ?? []);
  const out = new Map<string, string[]>();
  for (const h of Object.values(w.hits)) {
    for (const c of h.callers) if (!told.has(c)) out.set(c, [...new Set([...(out.get(c) ?? []), h.agent])]);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 续跑消息（owner 09-30 定的原话；不重发原回合，让 agent 自己核对） */
export const codexResumeText = (hitAt: number): string => t(
  `[Codex 额度恢复] Codex 额度已恢复，继续你被打断的任务；先核对做到哪一步再动手（你 ${hhmm(hitAt)} 那一回合撞额度中断了）。如果确实没有未完的事，直接 end_turn。`,
  `[Codex usage restored] Codex usage is back — continue the task that was cut off; check how far you got before acting `
    + `(your turn at ${hhmm(hitAt)} hit the usage limit). If nothing is left, just end_turn.`,
);

/** 给在等它答复、收到过 ⛔ 的 caller */
export const codexCallerText = (agents: string[]): string => t(
  `[ℹ️ bridge] ${agents.join("、")} 的 Codex 额度已恢复，bridge 已让它接着做被打断的任务；回程还留着，答复到了照常推给你，不用重发。`,
  `[ℹ️ bridge] Codex usage is back for ${agents.join(", ")}; bridge told it to continue the interrupted task. Your reply slot is kept — no need to resend.`,
);

const VIA_TEXT: Record<CodexExitVia, [string, string]> = {
  usage: ["用量回落", "usage dropped"],
  cli: ["人工确认", "confirmed manually"],
  account: ["换了 Codex 账号", "Codex account changed"],
  resets_at: ["到了重置时刻（探测不可用，按时间放行）", "reset time reached (probe unavailable)"],
};

/** 恢复做完告诉 owner 的一条（inform） */
export function codexRecoveredNotice(w: CodexWall): string {
  const r = w.recovery!;
  const via = VIA_TEXT[w.exit!.via];
  const agents = Object.values(w.hits).map((h) => h.agent);
  const lines = [
    t(`🟢 Codex 额度已恢复（${via[0]}），墙从 ${hhmm(w.enteredAt)} 开到 ${hhmm(w.exit!.at)}`, `🟢 Codex usage is back (${via[1]}); wall ${hhmm(w.enteredAt)}–${hhmm(w.exit!.at)}`),
    t(`补投押着的消息 ${r.flushed} 条；续跑 ${r.resumed.length ? r.resumed.join("、") : "无"}`, `Delivered ${r.flushed} held message(s); resumed ${r.resumed.length ? r.resumed.join(", ") : "none"}`),
  ];
  if (r.running.length) lines.push(t(`出墙时已在跑、没打扰：${r.running.join("、")}`, `Already running, left alone: ${r.running.join(", ")}`));
  if (r.held?.length) lines.push(t(`续跑消息被押住（要人看一眼）：${r.held.join("、")}`, `Resume message held (needs a look): ${r.held.join(", ")}`));
  if (!agents.length) lines.push(t("墙里没有回合失败的 agent", "No agent turn failed inside the wall"));
  if (r.cards) lines.push(t(`收起 Codex 额度卡 ${r.cards} 张`, `Dismissed ${r.cards} Codex quota card(s)`));
  return lines.join("\n");
}
