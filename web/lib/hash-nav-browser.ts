/** lib/hash-nav.ts 接浏览器的部分（它本身是纯函数，能被仓库根的测试直接引用，不能碰 window） */
import { createBackGuard, NARROW_QUERY } from "./hash-nav";

export const isNarrow = (): boolean => typeof window !== "undefined" && window.matchMedia(NARROW_QUERY).matches;

/** 全页一份：会话页和抽屉共用同一道闸（两边交替连点也不会多退） */
export const backGuard = createBackGuard({
  back: () => window.history.back(),
  onceOnPop: (f) => window.addEventListener("popstate", f, { once: true }),
  later: (f, ms) => void setTimeout(f, ms),
});

/** 摘掉 hash、不动历史栈（基础条目用） */
export const stripHash = (): void => window.history.replaceState(null, "", window.location.pathname + window.location.search);

/** features/collab/v4/sheet-history.ts 的浏览器实现；push 打 cstraCollab 标，同详情页压的条目 */
export const browserHistory = {
  hash: (): string => window.location.hash,
  push: (hash: string): void => window.history.pushState({ cstraCollab: true }, "", hash),
  replace: (hash: string): void => window.history.replaceState(window.history.state, "", hash),
  back: (): void => window.history.back(),
  onPop: (f: () => void): (() => void) => {
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  },
};
