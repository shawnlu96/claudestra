/**
 * 「今天」整页的入口（TODAY1）。桌面：借协作视图那层覆盖（collab-nav）盖在主区上，键是保留的 TODAY_KEY，CollabSwitch 见到它就画今天页；
 * 点任何会话照旧由 closingCollab 收起。手机：回到列表页、把侧栏条展开（NAVBAR1 合入后改为切到「今天」入口）。
 * section 让页面平滑滚到那一块（QUOTA1 / XMACH1 的「看额度」「看在跑的单」用 "team"）。
 */
import { openCollab } from "../collab/collab-nav";

/** 不会是项目 id 的键（项目 id 不带 @） */
export const TODAY_KEY = "@today";
export type TodaySection = "waits" | "stuck" | "doing" | "done" | "team";

/** 最近一次打开请求：seq 每次加一，页面 / 侧栏条据此滚动或展开一次 */
export interface TodayRequest { seq: number; section: TodaySection | null; strip: boolean }

let request: TodayRequest = { seq: 0, section: null, strip: false };
const subs = new Set<() => void>();

const narrow = () => typeof matchMedia === "function" && matchMedia("(max-width: 639.98px)").matches;

export function openToday(section?: TodaySection, nav?: { toList(): void }): void {
  const strip = narrow();
  request = { seq: request.seq + 1, section: section ?? null, strip };
  if (strip) nav?.toList();
  else openCollab(TODAY_KEY);
  for (const cb of subs) cb();
}

let handled = 0;
/** 取走还没处理的那次请求（strip = 侧栏条来取 / 页面来取，各取各的）；取过就不再给，后挂上的页面不会滚到旧位置 */
export function takeTodayRequest(strip: boolean): TodayRequest | null {
  if (request.seq === handled || request.strip !== strip) return null;
  handled = request.seq;
  return request;
}

/** 订阅打开请求（回调里用 takeTodayRequest 取） */
export function subscribeToday(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** 平滑滚到某一块（块不在 DOM 里就不动）；motion-reduce 下直接跳 */
export function scrollToSection(root: ParentNode | null, section: TodaySection | null): void {
  if (!root || !section) return;
  const el = root.querySelector<HTMLElement>(`[data-now-${section}]`);
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
}
