/** Minimal CLP integration: runtime pause is separate from the shared auth-probe cache. */
import type { Database } from "bun:sqlite";
import { claudeQuota } from "./lend-claude-worker-capacity.js";
import { claudePauseNeedsQuota, refreshClaudePause, syncClaudePause } from "./lend-claude-pause.js";

export async function settleClaudePause(db: Database, wanted: boolean, settle: () => Promise<void>): Promise<void> {
  syncClaudePause(db);
  await settle();
  const q = wanted && claudePauseNeedsQuota() ? await claudeQuota().catch(() => {
    console.error("[lend] 读 Claude 暂停后的额度失败，保留运行时重置时刻");
    return null;
  }) : null;
  // Re-read inside the transaction: a worker can fail while the auth/quota probe is in flight.
  refreshClaudePause(db, q, Date.now());
}
