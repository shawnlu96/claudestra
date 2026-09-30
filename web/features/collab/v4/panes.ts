/**
 * 协作视图左右两栏的收起状态存取（纯函数，单测 tests/web-collab-panes.test.ts；hook 在 use-panes.ts）：按设备存 localStorage，
 * 存储不可用 / 内容坏了就用默认值，不影响渲染。默认：大纲展开；视口窄于 WIDE 时右栏收起，把面积让给画布
 */
export interface Panes { left: boolean; right: boolean }
export const PANES_KEY = "collab.v4.panes";
export const WIDE = 1280;

type Store = Pick<Storage, "getItem" | "setItem">;

export const defaultPanes = (width: number): Panes => ({ left: true, right: width >= WIDE });

export function readPanes(store: Store | null, width: number): Panes {
  const fallback = defaultPanes(width);
  try {
    const raw = JSON.parse(store?.getItem(PANES_KEY) ?? "null") as Partial<Panes> | null;
    return {
      left: typeof raw?.left === "boolean" ? raw.left : fallback.left,
      right: typeof raw?.right === "boolean" ? raw.right : fallback.right,
    };
  } catch {
    return fallback; // 隐私模式 / 被禁用的存储 / 手改坏的 JSON：按默认值渲染，下次切换时覆盖
  }
}

export function writePanes(store: Store | null, p: Panes): void {
  try {
    store?.setItem(PANES_KEY, JSON.stringify(p));
  } catch {
    // 写不进去（配额、隐私模式）只是这台设备下次不记得，当前会话的状态在 React 里照常生效
  }
}

/** 经 globalThis 取：单测在根 tsconfig（没有 DOM 类型）下也要 import 这个文件 */
export const browser = globalThis as { localStorage?: Store; innerWidth?: number };

export function browserStore(): Store | null {
  try {
    return browser.localStorage ?? null;
  } catch {
    return null; // 被禁用的存储连读属性都会抛；当作没有存储
  }
}

/** 右栏临时浮出被收回的那一次（use-panes.ts）：只管这一次选中，选中换成别的或清空就忘掉，之后再选回它也照样浮出 */
export const keepDismissed = (dismissed: string | null, peekKey: string | null): string | null => (peekKey === dismissed ? dismissed : null);

/**
 * 点右栏的收起 / 展开：临时浮出时只收回这一次；常驻展开时收起，并把当前选中记为已收回——不记的话同一轮就按「收起 + 有选中」
 * 临时浮出，看起来没收，要点第二次（单测）；收起着就展开
 */
export function toggleRight(p: Panes, peek: boolean, peekKey: string | null, dismissed: string | null): { panes: Panes; dismissed: string | null } {
  if (peek) return { panes: p, dismissed: peekKey };
  return { panes: { ...p, right: !p.right }, dismissed: p.right ? peekKey : dismissed };
}
