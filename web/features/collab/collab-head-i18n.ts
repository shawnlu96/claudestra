/**
 * 协作视图页头「团队版 · …」那一行的状态与文字，和团队源下「规划与提案」标签的局部词表（UXHOME1）：只这两处用，不进共享字典。
 * 给 owner 看的句子不出内部叫法：同步状态的说法取 lib/owner-words.ts；mirror-fresh.ts mirrorAgo 的模板在这里换成不带内部叫法的写法。
 * 不 import react（tests/web-collab-page-head.test.ts 直接测）。
 */
import { fillParams, type I18nParams } from "@/lib/i18n-fill";
import { MACHINE_WORDS, ownerWordEn } from "@/lib/owner-words";
import { mirrorAt, type LedgerOverview } from "./collab-model";
import { mirrorAgo } from "./mirror-fresh";

type Lang = "zh" | "en";
export type HeadTr = (s: string, params?: I18nParams) => string;

export const HEAD_WORDS = {
  team: "团队版",
  none: MACHINE_WORDS.noProgress,
  stale: MACHINE_WORDS.staleModules,
  syncedMin: "{n} 分钟前同步",
  syncedHour: "{n} 小时前同步",
  showStale: "看是哪几个",
  planTab: "规划与提案",
  planSub: "团队规划与成员提案",
} as const;

/** mirror-fresh.ts mirrorAgo 的两句模板 → 页头的写法（中文也换，所以不是只有英文才查表） */
const AGO: Record<string, string> = {
  "主场 {n} 分钟前同步": HEAD_WORDS.syncedMin,
  "主场 {n} 小时前同步": HEAD_WORDS.syncedHour,
};

const EN: Record<string, string> = {
  [HEAD_WORDS.team]: "Team version",
  [HEAD_WORDS.syncedMin]: "synced {n} min ago",
  [HEAD_WORDS.syncedHour]: "synced {n} h ago",
  [HEAD_WORDS.showStale]: "Show which",
  [HEAD_WORDS.planTab]: "Plans & proposals",
  [HEAD_WORDS.planSub]: "Team plans and member proposals",
};

export function headTr(lang: Lang): HeadTr {
  return (s, p) => {
    const zh = Object.hasOwn(AGO, s) ? AGO[s]! : s;
    return fillParams(lang === "zh" ? zh : EN[zh] ?? ownerWordEn(zh) ?? zh, p);
  };
}

export type HeadMirror =
  | { state: "none" }
  | { state: "fresh"; observedAt: number | null }
  | { state: "stale"; names: string[] };

/** 页头那一行的状态。mirror 与 items 同序（team-source-adapter.ts 都按 feature 列表出）；过期名单取对应事项的标题 */
export function headMirror(ov: Pick<LedgerOverview, "mirror" | "items">, now: number): HeadMirror {
  const facts = ov.mirror ?? [];
  const at = facts.map((m) => mirrorAt(m, now));
  const names = at.flatMap((m, i) => (m === "stale" ? [ov.items[i]?.title || ov.items[i]?.id || String(i + 1)] : []));
  if (names.length) return { state: "stale", names };
  const seen = facts.flatMap((m, i) => (at[i] === "fresh" && typeof m.observedAt === "number" ? [m.observedAt] : []));
  if (!at.includes("fresh")) return { state: "none" };
  return { state: "fresh", observedAt: seen.length ? Math.min(...seen) : null };
}

/** 那一行的文字（不含「团队版 · 」前缀） */
export function headMirrorText(m: HeadMirror, now: number, h: HeadTr): string {
  if (m.state === "stale") return h(HEAD_WORDS.stale, { n: m.names.length });
  if (m.state === "none") return h(HEAD_WORDS.none);
  return m.observedAt === null ? h(HEAD_WORDS.syncedMin, { n: 0 }) : mirrorAgo(m.observedAt, now, h);
}
