/**
 * 旁白（工具间的过程叙述）的收起 / 展开状态（owner 2026-09-24「旁白容器右下角
 * 加【收起】【收起全部】/【展开】【展开全部】」）。纯逻辑 + 模块级状态，无 React；
 * 渲染在 components/narration-fold.tsx。单测见 tests/web-narration-fold.test.ts。
 *
 * 两层：`all` 是会话级（按 agent）的默认态，后续新到的旁白继承它，写 localStorage
 * 跨刷新保留，新会话默认展开；`overrides` 是单块的手动切换，只在内存里活着，
 * 「收起 / 展开全部」一按就清空——全部 = 重新对齐，不保留零星例外。
 */

export interface FoldState {
  /** 会话级默认：true = 新旁白一律收起 */
  all: boolean;
  /** 单块覆盖：key → 是否收起 */
  overrides: Record<string, boolean>;
}

export const EMPTY_FOLD: FoldState = Object.freeze({ all: false, overrides: Object.freeze({}) }) as FoldState;

export function isFolded(s: FoldState, key: string): boolean {
  return key in s.overrides ? s.overrides[key] : s.all;
}

export function foldOne(s: FoldState, key: string, folded: boolean): FoldState {
  return { all: s.all, overrides: { ...s.overrides, [key]: folded } };
}

export function foldAll(s: FoldState, folded: boolean): FoldState {
  return { all: folded, overrides: {} };
}

/** localStorage 键：每个 agent 一份「全部收起」偏好 */
export const FOLD_KEY_PREFIX = "cstra_narr_fold:";

export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadFoldAll(storage: MinimalStorage | null, agent: string): boolean {
  if (!storage || !agent) return false;
  try {
    return storage.getItem(FOLD_KEY_PREFIX + agent) === "1";
  } catch {
    return false; // 隐私模式读不到 = 默认展开
  }
}

export function saveFoldAll(storage: MinimalStorage | null, agent: string, all: boolean): void {
  if (!storage || !agent) return;
  try {
    storage.setItem(FOLD_KEY_PREFIX + agent, all ? "1" : "0");
  } catch {
    /* 隐私模式写不进：本次会话内仍生效，刷新后回默认 */
  }
}

// ── 模块级状态（按 agent）+ 订阅，给 useSyncExternalStore 用 ──
const states = new Map<string, FoldState>();
const subs = new Set<() => void>();

/** 根 tsconfig 无 dom lib：不直接引用 window / localStorage */
function browserStorage(): MinimalStorage | null {
  try {
    return ((globalThis as { localStorage?: MinimalStorage }).localStorage as MinimalStorage | undefined) ?? null;
  } catch {
    return null; // 某些嵌入环境访问 localStorage 直接抛 SecurityError
  }
}

export function getFold(agent: string): FoldState {
  if (!agent) return EMPTY_FOLD;
  let s = states.get(agent);
  if (!s) {
    s = { all: loadFoldAll(browserStorage(), agent), overrides: {} };
    states.set(agent, s);
  }
  return s;
}

function commit(agent: string, next: FoldState): void {
  states.set(agent, next);
  subs.forEach((f) => f());
}

export function setFoldOne(agent: string, key: string, folded: boolean): void {
  if (!agent) return;
  commit(agent, foldOne(getFold(agent), key, folded));
}

export function setFoldAll(agent: string, folded: boolean): void {
  if (!agent) return;
  saveFoldAll(browserStorage(), agent, folded);
  commit(agent, foldAll(getFold(agent), folded));
}

export function subscribeFold(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 测试 / 切换 agent 数据源时清空内存态（localStorage 不动） */
export function resetFoldStates(): void {
  states.clear();
}
