/**
 * 主场执行镜像的新鲜窗口（team-project-N8F）：shared/shared-model.ts stale 和 team-source-adapter.ts mirrorFact 共用这一个常量。
 * 主场只在本机台账有新事件时推镜像（src/lib/shared-ledger-projector.ts），整机空闲几分钟没事件是常态，所以窗口给 10 分钟；
 * 过了窗口不只写「过期」，带上多久前同步的（mirrorAgo）。
 */
import type { Tr } from "./collab-model";

export const MIRROR_FRESH_MS = 10 * 60_000;

/** observedAt 到 now 超过新鲜窗口 = 过期 */
export const mirrorExpired = (observedAt: number, now: number): boolean => now - observedAt > MIRROR_FRESH_MS;

/** 「主场 N 分钟前同步」，满 60 分钟写「主场 N 小时前同步」；N 向下取整 */
export function mirrorAgo(observedAt: number, now: number, tr: Tr): string {
  const min = Math.max(0, Math.floor((now - observedAt) / 60_000));
  return min >= 60 ? tr("主场 {n} 小时前同步", { n: Math.floor(min / 60) }) : tr("主场 {n} 分钟前同步", { n: min });
}

/** 团队规划面板那一句（shared/team-ops.tsx）：没镜像「尚无执行镜像」、窗口内「主场镜像最新」、过期「主场 N 分钟前同步」；agoTr 是带 collab-i18n 词条的 tr */
export function mirrorLine(observedAt: number | null, now: number, tr: Tr, agoTr: Tr = tr): string {
  if (observedAt === null) return tr("尚无执行镜像");
  return mirrorExpired(observedAt, now) ? mirrorAgo(observedAt, now, agoTr) : tr("主场镜像最新");
}
