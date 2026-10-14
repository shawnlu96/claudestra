/** Idle bindings are capacity only in the legacy modes; unsettled scheduler effects remain the caller's unchanged SQL. */
import type { Database } from "bun:sqlite";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

export function reviewSeatMode(project: string): RecoveryMode {
  const p = recoveryPolicy(project, "reviewSeatIdle");
  if (p.diagnostic) console.error(`[scheduler-review-seat] ${p.diagnostic}`);
  return p.mode;
}

/** ledger dispatch names a review kind, not an agent: keep every local binding until that round's subsequent verdict. */
export function reviewSeatCondition(db: Database, mode: RecoveryMode): string {
  if (mode !== "on") return "t.stage='review'";
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get()) return "t.stage='review'";
  return `t.stage='review' AND EXISTS (SELECT 1 FROM events d WHERE d.project=t.project AND d.target=t.id AND d.kind='dispatch'
    AND json_extract(d.data,'$.round')=t.round AND NOT EXISTS (SELECT 1 FROM events v
      WHERE v.project=t.project AND v.target=t.id AND v.kind='review' AND v.seq>d.seq AND json_extract(v.data,'$.round')=t.round))`;
}
