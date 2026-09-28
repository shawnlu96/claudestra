/**
 * 上下文边界的决策（纯函数）：这一轮用哪条线（策略 / 全局）、决策表、面板显示。策略的解析与匹配在 ctx-boundary-policy.ts，
 * 执行在 bridge/ctx-boundary.ts；设计 docs/architecture/context-boundary.md，单测 tests/ctx-boundary-policy.test.ts。
 */
import type { CompactAction, PolicyMatch, PolicyVia, PolicyWarning } from "./ctx-boundary-policy.js";
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
  keep: string | null;
  ccWindow: number | null;
}

export interface GlobalAutoCompact {
  window?: number;
  idleHours?: number;
  emergency?: boolean;
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

export interface BoundaryInput {
  ctx: number;
  window: number;
  hardCap: number | null;
  /** 最后一条真实对话距今满 idleMs，且画面不在忙 */
  idle: boolean;
  /** null = 读不到画面；来自 lib/lp-state.ts 的 paneQuotaState（T35 与本模块共用一份判定） */
  pane: PaneQuotaState | null;
  /** 画面上已有排队消息（「Press up to edit queued messages」） */
  queued: boolean;
  /** bridge 刚注入过压缩（守卫期内） */
  injectedRecently: boolean;
  lastTrig: number;
  now: number;
  retryMs: number;
}

export type SkipReason = "under" | "compacting" | "retry-wait" | "pane-unknown" | "quota-wall" | "menu" | "draft" | "queued" | "busy";
export type BoundaryVerdict = { fire: true; kind: "idle" | "hard-cap" } | { fire: false; reason: SkipReason };

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  under: "没过线",
  compacting: "正在压缩",
  "retry-wait": "冷却中（注入过还没见效，30 分钟；或刚发送失败，5 分钟）",
  "pane-unknown": "读不到画面",
  "quota-wall": "撞了额度墙又没开 low-priority",
  menu: "画面上有选择菜单",
  draft: "输入框里有没发出去的字",
  queued: "已经有排队的消息（多半是上一条压缩）",
  busy: "还在忙",
};

/**
 * 按顺序判，先命中先返回：
 *   没过线 → 正在压缩 → 30 分钟重试冷却 → 读不到画面 → 撞墙且没开 LP → 画面上有选择菜单 → 已有排队消息 → 输入框有草稿
 *   → 过硬上限（忙也注入，排队到回合结束） → 过软线且闲置 → 其余（忙）不动。
 * 撞墙那条排在冷却之后、且不开火，所以不占重试计时；菜单那条挡的是「往菜单里敲字」——额度墙菜单第 3 项是花钱的 usage credits；
 * 草稿那条挡的是「把 owner 打了一半的字连着 /compact 一起提交」，硬上限也不能越过它。
 */
export function boundaryDecision(i: BoundaryInput): BoundaryVerdict {
  const overSoft = i.window > 0 && i.ctx >= i.window;
  const overHard = i.hardCap !== null && i.ctx >= i.hardCap;
  if (!overSoft && !overHard) return { fire: false, reason: "under" };
  if (i.injectedRecently || i.pane?.compacting) return { fire: false, reason: "compacting" };
  if (i.lastTrig > 0 && i.now - i.lastTrig <= i.retryMs) return { fire: false, reason: "retry-wait" };
  if (!i.pane) return { fire: false, reason: "pane-unknown" };
  if ((i.pane.wall && i.pane.lp !== "on") || i.pane.exhausted) return { fire: false, reason: "quota-wall" };
  if (i.pane.menu) return { fire: false, reason: "menu" };
  // 排队在草稿之前判：lp-state 把排队也算进 draft（输入框不是确定的空），这里单独报出来，owner 看结果分得清
  if (i.queued) return { fire: false, reason: "queued" };
  if (i.pane.draft) return { fire: false, reason: "draft" };
  if (overHard) return { fire: true, kind: "hard-cap" };
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
