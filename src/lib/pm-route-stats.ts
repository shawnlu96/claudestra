import type { DigestRecord } from "./pm-digest-store.js";
import type { PmRouteClass } from "./pm-route-types.js";

export function pmRouteStats(rows: readonly DigestRecord[]) {
  const counts: Record<PmRouteClass, number> = { auto: 0, digest: 0, judge: 0, owner: 0 };
  const byRule: Record<string, number> = {}, seen = new Set<string>();
  for (const r of rows) {
    if (!r.route) continue;
    const id = `${r.project}\u0000${r.route.messageId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const tag of r.route.tags) {
      counts[tag.route]++;
      byRule[`${tag.route}:${tag.rule}`] = (byRule[`${tag.route}:${tag.rule}`] ?? 0) + 1;
    }
  }
  return { ...counts, byRule };
}
