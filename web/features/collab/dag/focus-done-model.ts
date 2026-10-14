/**
 * 子 DAG 已完成区的分段与搜索（team-project-SUBDAG5），纯函数，组件 focus-done.tsx 用：
 * 先按 key / 一句话搜（去首尾空格、不分大小写），再按完成时间分「今天 / 昨天 / 更早 / 时间未知」，每段保持入参顺序（at 降序）。
 * 不读时钟和时区：本地 0 点由组件算好传进来；昨天 = 往前 24 小时（夏令时那天差一小时可以接受，换成读时区要牵动测试的固定值）。
 */
import type { FocusModel } from "./subdag-focus";

export type DoneRow = FocusModel["done"][number];
export type SectionKey = "today" | "yesterday" | "earlier" | "undated";
export type DoneSectionMap = Record<SectionKey, DoneRow[]>;

/** 段的显示顺序：时间未知排在「更早」后面 */
export const SECTION_KEYS: readonly SectionKey[] = ["today", "yesterday", "earlier", "undated"];
export const SECTION_WORD: Record<SectionKey, string> = { today: "今天", yesterday: "昨天", earlier: "更早", undated: "时间未知" };
export const FIRST_ROWS = 20;
export const MORE_ROWS = 50;

const DAY = 24 * 60 * 60_000;

export function sectionOf(at: number | null, todayStart: number): SectionKey {
  if (at === null) return "undated";
  if (at >= todayStart) return "today";
  return at >= todayStart - DAY ? "yesterday" : "earlier";
}

export function doneSections(done: readonly DoneRow[], todayStart: number, query: string): DoneSectionMap {
  const q = query.trim().toLowerCase();
  const out: DoneSectionMap = { today: [], yesterday: [], earlier: [], undated: [] };
  for (const d of done) {
    if (q && !d.nodeKey.toLowerCase().includes(q) && !d.oneLine.toLowerCase().includes(q)) continue;
    out[sectionOf(d.at, todayStart)].push(d);
  }
  return out;
}

/** 全部没有完成时间（SUBDAG2 之前 / 团队侧）：不出分段标题，退回一张平铺列表 */
export const undatedOnly = (done: readonly DoneRow[]): boolean => done.every((d) => d.at === null);

/** 默认展开的段：第一个非空段（今天为空就往后找） */
export const firstFilled = (s: DoneSectionMap): SectionKey | null => SECTION_KEYS.find((k) => s[k].length > 0) ?? null;

/** 第 index 行（0 起）要露出来时，该段至少显示几行：20 起，每次 +50 */
export const rowsToShow = (index: number): number => (index < FIRST_ROWS ? FIRST_ROWS : FIRST_ROWS + Math.ceil((index + 1 - FIRST_ROWS) / MORE_ROWS) * MORE_ROWS);
