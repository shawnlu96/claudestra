/**
 * 五个入口选中哪一个（NAVBAR1）：手机底部栏和电脑竖向图标栏读写同一份，模块级小 store（写法同 collab/collab-nav.ts）。
 * 不持久化：没点过时 tab 是 null，手机冷开落在「今天」、电脑冷开落在「会话」；进会话再返回列表，store 还在，回到原来那个入口。
 */
import { useSyncExternalStore } from "react";
import type { TodaySection } from "../now/today-nav";

export type NavTab = "today" | "projects" | "sessions" | "team" | "me";

let tab: NavTab | null = null;
/** openToday 在手机上要滚到的那一块：seq 每次加一，「今天」页据此取一次 */
let today: { seq: number; section: TodaySection | null } = { seq: 0, section: null };
const subs = new Set<() => void>();

export function setTab(next: NavTab): void {
  if (next === tab) return;
  tab = next;
  for (const cb of subs) cb();
}

/** 手机 openToday（「看额度」「看在跑的单」）：切到「今天」，再让那一页滚到 section */
export function showToday(section: TodaySection | null): void {
  today = { seq: today.seq + 1, section };
  tab = "today";
  for (const cb of subs) cb();
}

/** 取走还没滚过的那一块（取过就清，后挂上的页面不会再滚到旧位置） */
export function takeTodaySection(): TodaySection | null {
  const s = today.section;
  today = { ...today, section: null };
  return s;
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => { subs.delete(cb); };
};
const snapshot = () => tab;

/** narrow = 手机排版：决定冷开默认值（两端各自的默认，点过以后两端是同一个值） */
export function useNavTab(narrow: boolean): NavTab {
  return useSyncExternalStore(subscribe, snapshot, snapshot) ?? (narrow ? "today" : "sessions");
}

/** 「今天」页订阅：每次 showToday 变一次 */
export const useTodaySeq = (): number => useSyncExternalStore(subscribe, () => today.seq, () => today.seq);

/** 测试用：回到冷开（没点过）的状态 */
export function resetNavTab(): void {
  tab = null;
  for (const cb of subs) cb();
}
