/**
 * 上下文边界的显示（owner 09-29：执行者上下文要有边界）。数据是 bridge agent 列表里的 ctxBoundary 字段
 * （src/bridge/ctx-boundary.ts ctxBoundaryViewFor）：命中哪条策略、压缩线、硬上限、离线还剩多少、等级。
 * 过压缩线标黄、过硬上限标红。单测 tests/web-ctx-boundary-view.test.ts。
 */
export type CtxBoundaryLevel = "ok" | "over" | "cap";

export interface CtxBoundaryInfo {
  policy: string;
  window: number;
  hardCap: number | null;
  /** window − 当前占用；负数 = 已超出；软线关掉时 null */
  remaining: number | null;
  level: CtxBoundaryLevel;
  /** 这条策略的配置问题（越界的 ccWindow 之类） */
  warnings?: string[];
}

const LABEL: Record<string, string> = { executor: "执行类", coordinator: "协调类", global: "全局" };

/** 内置策略给中文名（再经 t() 翻译），自定义的显示 id */
export function boundaryLabel(policy: string): string {
  return LABEL[policy] ?? policy;
}

const k = (n: number) => `${Math.round(n / 1000)}k`;

/** 「余 35k」/「超 20k」；软线关着时只剩硬上限可说 → null */
export function boundaryLeft(b: CtxBoundaryInfo): { key: "余 {n}" | "超 {n}"; n: string } | null {
  if (b.remaining === null) return null;
  return b.remaining >= 0 ? { key: "余 {n}", n: k(b.remaining) } : { key: "超 {n}", n: k(-b.remaining) };
}

/** 悬停说明的参数：压缩线 / 硬上限 */
export function boundaryLines(b: CtxBoundaryInfo): { window: string; cap: string } {
  return { window: b.window > 0 ? k(b.window) : "—", cap: b.hardCap !== null ? k(b.hardCap) : "—" };
}

/** 文字色（列表小标 / 面板）；等级 ok 用中性色 */
export const BOUNDARY_TEXT: Record<CtxBoundaryLevel, string> = {
  ok: "text-base-content/45",
  over: "text-warning",
  cap: "text-error",
};

/** 进度条色（用量面板） */
export const BOUNDARY_BAR: Record<CtxBoundaryLevel, string> = {
  ok: "bg-success",
  over: "bg-warning",
  cap: "bg-error",
};

/** 列表行的背景填充色：只对命中了具名策略的行生效，没命中的（全局）保留原来按 1M 刻度的色阶 */
export const BOUNDARY_ROW_TONE: Record<CtxBoundaryLevel, string> = {
  ok: "bg-base-content/[0.04]",
  over: "bg-warning/12",
  cap: "bg-error/14",
};

export function hasNamedPolicy(b: CtxBoundaryInfo | null | undefined): b is CtxBoundaryInfo {
  return !!b && b.policy !== "global";
}
