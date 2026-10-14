/** Edge aggregation and computation-error handling for feature-deps-sync.ts. Several local features (or projects) may map
 * to one center feature, so duplicates are merged before the contract's uniqueness check instead of failing the team.
 * Over the contract cap nothing is sent: a truncated full replacement would silently delete edges at the center.
 * tests/feature-deps-sync-edges.test.ts.
 */
import type { FeatureDep } from "./shared-ledger-contract-feature-deps.js";
import { noteOncePerDay, type GroupState, type SyncFile } from "./feature-deps-sync-state.js";

const FEATURE_DEPS_LIMIT = 2000;
export class TooManyFeatureDeps extends Error {
  constructor(readonly count: number) { super("too many feature deps"); }
}

/** count adds up; satisfied only when every merged edge is satisfied; self-loops after mapping are dropped. */
export function mergeFeatureDeps(edges: readonly FeatureDep[]): FeatureDep[] {
  const merged = new Map<string, FeatureDep>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = JSON.stringify([e.projectId, e.from, e.to, e.kind]), cur = merged.get(key);
    if (cur) { cur.count += e.count; cur.satisfied &&= e.satisfied; } else merged.set(key, { ...e });
  }
  const out = [...merged.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, e]) => e);
  if (out.length > FEATURE_DEPS_LIMIT) throw new TooManyFeatureDeps(out.length);
  return out;
}

/** True when the error was a skip or an observe-only diagnostic; false means the caller's upload-failure path applies. */
export function computeErrorHandled(file: SyncFile, st: GroupState, error: unknown, mode: "observe" | "on", now: number): boolean {
  if (error instanceof TooManyFeatureDeps) {
    st.skipped = "too_many_edges"; st.skippedEdges = error.count;
    noteOncePerDay(file, "#too_many_edges", now, `团队依赖：合并后 ${error.count} 条边超过上限 ${FEATURE_DEPS_LIMIT}，本轮不发送；原因是边太多，不是网络或中心故障`);
    return true;
  }
  if (mode !== "observe") return false;
  // Observe never uploads, so a failing computation must not pre-load backoff for a later switch to on.
  noteOncePerDay(file, "#observe_compute_error", now, "团队依赖：观察档计算失败，不计退避");
  return true;
}
