/** Synchronous planning reads cached observations only; creation still uses the complete inventory quota reader. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { statePath } from "./paths.js";
import { normalizeQuotaState } from "./quota-state.js";
import { remoteViewOf } from "./quota-scheduler.js";
import { selectQuotaLayers } from "./quota-layers.js";
import { quotaFor } from "./ai-quota.js";
import { readUsageCacheStale } from "./usage-cache.js";
import { readConfigSync } from "./config-store.js";
import { codexWeeklyLine } from "./quota-codex-line.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";

export function quotaPoolTotals(db: Database, project: string, totals: AgentLimits, now = Date.now()): AgentLimits {
  let state = null;
  try { state = normalizeQuotaState(JSON.parse(readFileSync(statePath("quota-state.json"), "utf8"))); }
  catch (e) {
    // A missing optional cache has no observation. A broken cache is logged and the runtime reader checks again before creation.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[scheduler-agent-pool] 额度缓存读不到：${(e as Error).message}`);
  }
  const snap = selectQuotaLayers({ now, enabled: readConfigSync().quotaLive !== false,
    remote: state ? remoteViewOf(state, now, true) : null, local: { claudeCache: readUsageCacheStale(now), codexRollout: null } });
  const row = db.query("SELECT value FROM meta WHERE project=? AND key='autostart'").get(project) as { value: string } | null;
  const line = row ? JSON.parse(row.value).weeklyLinePct ?? 70 : 70;
  const over = (family: "claude" | "codex", limit: number) => quotaFor(snap, family).windows.some((w) =>
    (w.kind === "weekly" || w.kind === "weekly_scoped") && w.usedPct !== null && w.usedPct >= limit);
  return { claude: over("claude", line) ? 0 : totals.claude,
    codex: over("codex", codexWeeklyLine(db, project)) ? 0 : totals.codex };
}
