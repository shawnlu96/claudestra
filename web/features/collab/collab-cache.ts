/**
 * 协作视图的本页缓存，按「机器 + 项目」分：
 * - access：这台设备能不能读这个项目的台账。入口靠它决定出不出现——guest / 部分 scope 的设备读台账是 403（审查 #144 P1-3），
 *   /capabilities 对谁都报 ledger，不能拿它当依据；
 * - overview：上次拉到的总览，切回协作视图先显示它、后台再重拉。
 * 换机器（中继多机）时键不同，不会把 A 机的台账显示在 B 机下面。
 */
import { useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import type { LedgerOverview } from "./collab-model";

export type Access = "unknown" | "yes" | "no";

const access = new Map<string, Access>();
const overview = new Map<string, { ov: LedgerOverview; offset: number }>();
const subs = new Set<() => void>();

const keyOf = (project: string) => `${machines.currentFp() ?? "local"}|${project}`;

export function setLedgerAccess(project: string, a: Access): void {
  const k = keyOf(project);
  if (access.get(k) === a) return;
  access.set(k, a);
  for (const cb of subs) cb();
}

export function useLedgerAccess(project: string): Access {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => access.get(keyOf(project)) ?? "unknown",
    () => "unknown",
  );
}

export function cachedOverview(project: string): { ov: LedgerOverview; offset: number } | undefined {
  return overview.get(keyOf(project));
}

export function cacheOverview(project: string, ov: LedgerOverview, offset: number): void {
  overview.set(keyOf(project), { ov, offset });
  setLedgerAccess(project, "yes");
}
