/**
 * 主场执行镜像的新鲜窗口（team-project-N8F）：shared/shared-model.ts stale 和 team-source-adapter.ts mirrorFact 共用这一个常量。
 * 主场只在本机台账有新事件时推镜像（src/lib/shared-ledger-projector.ts），整机空闲几分钟没事件是常态，所以窗口给 10 分钟；
 * 过了窗口不只写「过期」，带上多久前同步的（mirrorAgo）。
 */
import { MACHINE_WORDS } from "@/lib/owner-words";
import type { Tr } from "./collab-model";

export const MIRROR_FRESH_MS = 10 * 60_000;

/** observedAt 到 now 超过新鲜窗口 = 过期 */
export const mirrorExpired = (observedAt: number, now: number): boolean => now - observedAt > MIRROR_FRESH_MS;

/** 更新年龄向下取整；满 60 分钟用小时，和页头的同步时间共用。 */
export function mirrorAgo(observedAt: number, now: number, tr: Tr): string {
  const min = Math.max(0, Math.floor((now - observedAt) / 60_000));
  return min >= 60 ? tr(MACHINE_WORDS.staleHours, { n: Math.floor(min / 60) }) : tr(MACHINE_WORDS.staleMinutes, { n: min });
}

/** 没收到进度与最新分开；过期带更新年龄。agoTr 允许页头保留自己的同步时间格式。 */
export function mirrorLine(observedAt: number | null, now: number, tr: Tr, agoTr: Tr = tr): string {
  if (observedAt === null) return tr(MACHINE_WORDS.noProgress);
  return mirrorExpired(observedAt, now) ? mirrorAgo(observedAt, now, agoTr) : tr(MACHINE_WORDS.fresh);
}
