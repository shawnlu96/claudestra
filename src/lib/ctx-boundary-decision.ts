/**
 * 上下文边界的决策（纯函数）：这一轮用哪条线（策略 / 全局）、决策表、面板显示。策略的解析与匹配在 ctx-boundary-policy.ts，
 * 执行在 bridge/ctx-boundary.ts；设计 docs/architecture/context-boundary.md，单测 tests/ctx-boundary-policy.test.ts。
 */
import type { CompactAction, CompactKeep, PolicyMatch, PolicyVia, PolicyWarning } from "./ctx-boundary-policy.js";
import type { PaneQuotaState } from "./lp-state.js";

// ── 这一轮用哪条线 ─────────────────────────────────────────────────────

/** 一个 agent 这一轮生效的边界：命中的策略，或退回全局 */
export interface Boundary {
  policy: string;
  via: PolicyVia | "global";
  /** 0 = 软边界关（全局 window=0） */
  window: number;
  /** null = 没有硬上限（全局且拿不到真实窗口） */
  hardCap: number | null;
  idleMs: number;
  action: CompactAction;
  keep: CompactKeep | null;
  ccWindow: number | null;
}

export interface GlobalAutoCompact {
  window?: number;
  idleHours?: number;
  emergency?: boolean;
  /** 自动注入总开关，缺省关：先用 `manager ctx-boundary dry-run` 看会对谁做什么，再 `ctx-boundary on` */
  inject?: boolean;
}

// 全局口径（从 stats-dashboard 原样搬来）：缺省 40 万 + 闲置 3 小时；拿得到真实窗口时软线收到 85%、救命线 93%。
// 救命线离 CC 默认的 ~967K 只剩几万，踩到就不管闲置（打断一次 ≪ 被 CC 裸压丢记忆）。来龙去脉：git log -S EMERGENCY_WINDOW_RATIO
const DEFAULT_GLOBAL_WINDOW = 400_000;
const DEFAULT_GLOBAL_IDLE_HOURS = 3;
const REAL_WINDOW_TRIGGER_RATIO = 0.85;
const EMERGENCY_WINDOW_RATIO = 0.93;

export function globalBoundary(cfg: GlobalAutoCompact | undefined, realWindow: number | null): Boundary {
  const w = cfg?.window;
  const base = w === 0 ? 0 : typeof w === "number" && Number.isFinite(w) && w > 0 ? w : DEFAULT_GLOBAL_WINDOW;
  const h = cfg?.idleHours;
  const idleHours = h === 0 ? 0 : typeof h === "number" && Number.isFinite(h) && h > 0 ? h : DEFAULT_GLOBAL_IDLE_HOURS;
  return {
    policy: "global",
    via: "global",
    window: base > 0 && realWindow ? Math.min(base, Math.floor(realWindow * REAL_WINDOW_TRIGGER_RATIO)) : base,
    // 救命线独立于软线：window=0 关了软线它照样兜底
    hardCap: cfg?.emergency !== false && realWindow ? Math.floor(realWindow * EMERGENCY_WINDOW_RATIO) : null,
    idleMs: idleHours * 3600_000,
    action: "save-compact",
    keep: null,
    ccWindow: null,
  };
}

/** 策略的线同样不越过真实窗口的 85% / 93%（小窗口模型上 CC 会先压） */
export function policyBoundary(m: PolicyMatch, realWindow: number | null): Boundary {
  const p = m.policy;
  const cap = (v: number, ratio: number) => (realWindow ? Math.min(v, Math.floor(realWindow * ratio)) : v);
  return {
    policy: p.id,
    via: m.via,
    window: cap(p.window, REAL_WINDOW_TRIGGER_RATIO),
    hardCap: cap(p.hardCap, EMERGENCY_WINDOW_RATIO),
    idleMs: p.idleMinutes * 60_000,
    action: p.action,
    keep: p.keep,
    ccWindow: p.ccWindow,
  };
}

// ── 决策表 ─────────────────────────────────────────────────────────────

/**
 * 注入前要看的窗口状态。前六项来自 lib/lp-state.ts 的 paneQuotaState（T35 与本模块共用一份判定），其余是：
 * 画面上已有排队消息、spinner 行在报 API 重试（压缩途中也会这样，认不出就会再排一条 /compact）、
 * tmux 报的 copy-mode（有人在翻历史，发键会把他拽回底部）、前台进程不是 Claude Code（CC 退出了，敲进去的是 shell）、
 * 停在额度菜单 / 撞墙自动续跑倒计时上（lib/quota-wall-text wallWaitKind：打字会取消续跑，菜单里有花钱项；开了 LP 也一样）。
 */
export type PaneGate = PaneQuotaState & { queued: boolean; apiRetry: boolean; copyMode: boolean; notCc: boolean; wallWait: boolean };

export interface BoundaryInput {
  ctx: number;
  window: number;
  hardCap: number | null;
  /** 最后一条真实对话距今满 idleMs，且画面不在忙 */
  idle: boolean;
  /** null = 读不到画面 */
  pane: PaneGate | null;
  /** bridge 刚注入过压缩（守卫期内） */
  injectedRecently: boolean;
  lastTrig: number;
  now: number;
  retryMs: number;
  /** 额度闸关着（账号撞墙、没开 LP）：常规线起的这一轮注定撞墙，只让硬上限敲 */
  gated?: boolean;
}

export type PaneBlock = "not-cc" | "copy-mode" | "compacting" | "api-retry" | "quota-wall" | "menu" | "queued" | "draft";
export type SkipReason = PaneBlock | "under" | "recent" | "retry-wait" | "pane-unknown" | "busy" | "gated";
export type BoundaryVerdict = { fire: true; kind: "idle" | "hard-cap" } | { fire: false; reason: SkipReason };

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  under: "没过线",
  recent: "15 分钟内刚注入过压缩",
  compacting: "正在压缩",
  "api-retry": "API 在重试（可能是压缩在重试）",
  "not-cc": "窗口里跑的不是 Claude Code（多半已经退出，只剩 shell）",
  "copy-mode": "有人在翻看终端历史（copy-mode）",
  "retry-wait": "冷却中（注入过还没见效，30 分钟；或刚发送失败，5 分钟）",
  "pane-unknown": "读不到画面",
  "quota-wall": "撞了额度墙又没开 low-priority",
  menu: "画面上有选择菜单",
  draft: "输入框里有没发出去的字",
  queued: "已经有排队的消息（多半是上一条压缩）",
  busy: "还在忙",
  gated: "额度闸关着（账号撞墙），只有硬上限能敲",
};

/** 画面挡不挡注入（自动和手动共用）：不是 CC → copy-mode → 正在压缩 → API 重试 → 撞墙且没开 LP → 菜单 → 已排队 → 草稿 */
export function paneBlock(p: PaneGate): PaneBlock | null {
  if (p.notCc) return "not-cc";
  if (p.copyMode) return "copy-mode";
  if (p.compacting) return "compacting";
  if (p.apiRetry) return "api-retry";
  if ((p.wall && p.lp !== "on") || p.exhausted || p.wallWait) return "quota-wall";
  if (p.menu) return "menu";
  // 排队在草稿之前判：lp-state 把排队也算进 draft（输入框不是确定的空），这里单独报出来，owner 看结果分得清
  if (p.queued) return "queued";
  if (p.draft) return "draft";
  return null;
}

/**
 * 按顺序判，先命中先返回：
 *   没过线 → 刚注入过 → 正在压缩 / API 重试 → 30 分钟重试冷却 → 读不到画面 → paneBlock 的其余各条
 *   → 过硬上限（忙也注入，排队到回合结束） → 额度闸关着 → 过软线且闲置 → 其余（忙）不动。
 * 撞墙那条排在冷却之后、且不开火，所以不占重试计时；菜单那条挡的是「往菜单里敲字」——额度墙菜单第 3 项是花钱的 usage credits；
 * 草稿那条挡的是「把 owner 打了一半的字连着 /compact 一起提交」，硬上限也不能越过它。
 */
export function boundaryDecision(i: BoundaryInput): BoundaryVerdict {
  const overSoft = i.window > 0 && i.ctx >= i.window;
  const overHard = i.hardCap !== null && i.ctx >= i.hardCap;
  if (!overSoft && !overHard) return { fire: false, reason: "under" };
  if (i.injectedRecently) return { fire: false, reason: "recent" };
  if (i.pane?.compacting) return { fire: false, reason: "compacting" };
  if (i.pane?.apiRetry) return { fire: false, reason: "api-retry" };
  if (i.lastTrig > 0 && i.now - i.lastTrig <= i.retryMs) return { fire: false, reason: "retry-wait" };
  if (!i.pane) return { fire: false, reason: "pane-unknown" };
  const blocked = paneBlock(i.pane);
  if (blocked) return { fire: false, reason: blocked };
  if (overHard) return { fire: true, kind: "hard-cap" };
  if (i.gated) return { fire: false, reason: "gated" };
  if (i.idle) return { fire: true, kind: "idle" };
  return { fire: false, reason: "busy" };
}

// ── 显示 ───────────────────────────────────────────────────────────────

type BoundaryLevel = "ok" | "over" | "cap";

/** 面板 / 网页列表显示用：命中哪条、离软线还剩多少（负数 = 已超出）、过线等级 */
export interface CtxBoundaryView {
  policy: string;
  via: PolicyVia | "global";
  window: number;
  hardCap: number | null;
  remaining: number | null;
  level: BoundaryLevel;
  action: CompactAction;
  ccWindow: number | null;
  warnings: string[];
}

const LABEL: Record<string, string> = { executor: "执行类", coordinator: "协调类", global: "全局" };
/** 面板上显示的策略名：内置的给中文名，自定义的显示 id */
export const boundaryLabel = (policy: string): string => LABEL[policy] ?? policy;

export function boundaryView(b: Boundary, ctx: number | null, warnings: PolicyWarning[] = []): CtxBoundaryView {
  const c = ctx ?? 0;
  const level: BoundaryLevel = b.hardCap !== null && c >= b.hardCap ? "cap" : b.window > 0 && c >= b.window ? "over" : "ok";
  return {
    policy: b.policy,
    via: b.via,
    window: b.window,
    hardCap: b.hardCap,
    remaining: b.window > 0 && ctx !== null ? b.window - ctx : null,
    level,
    action: b.action,
    ccWindow: b.ccWindow,
    warnings: warnings.filter((w) => w.policy === b.policy).map((w) => w.text),
  };
}
