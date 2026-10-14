/**
 * Recovery key mirrorSkipBlockedId (default observe): a card whose id the scrub refuses (shared-ledger-mirror-skip-id.ts)
 * no longer blocks its whole feature's mirror. off = as before, the whole upload is refused; observe = still refused, plus
 * one note per feature + card; on = the projection leaves out the card, its events and its edges, and the source DAG
 * leaves out its binding (the node stays, unbound). Every other field still refuses the whole upload. Skipped cards are
 * never sent later. tests/shared-ledger-mirror-skip*.test.ts.
 */
import { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { observeDedupKey, recordObserved, recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { cardIdBlocked } from "./shared-ledger-mirror-skip-id.js";

export const MIRROR_SKIP_KEY = "mirrorSkipBlockedId" as const;
const mirrorSkipMode = (project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode => policy(project, MIRROR_SKIP_KEY).mode;

/**
 * One note per feature + card. Notes must target a card (appendEvent), so it lands in the skipped card's own stream, which on
 * never uploads. The mirror loop reads through a read-only connection: a missing note gets a short-lived writer, as
 * memory-retrieve-order.ts does.
 */
function noteSkip(db: Database, a: ObservedAction, now: number): void {
  const file = db.filename, shared = !file || file === ":memory:";
  let writer: Database | null = null;
  try {
    if (getEventByDedup(db, observeDedupKey(a))) return;
    writer = shared ? db : new Database(file, { readwrite: true, create: false });
    if (writer !== db) writer.exec("PRAGMA busy_timeout = 2000");
    recordObserved(writer, a, now);
  } catch (error) {
    // The skip decision never reads the note; an unwritten one is retried on the next push.
    console.warn(`[${MIRROR_SKIP_KEY}] 观察没记上：${(error as Error).message}`);
  } finally { if (writer && writer !== db) writer.close(); }
}

/**
 * The projection's cards to leave out: the blocked ones under on, none under off / observe. Under observe and on each
 * blocked card is noted once per feature.
 */
export function mirrorSkipIds(db: Database, project: string, featureId: string, ids: Iterable<string>, scrub: SharedLedgerScrubContext,
  opts: { now: number; policy?: RecoveryPolicyPort }): ReadonlySet<string> {
  const mode = mirrorSkipMode(project, opts.policy);
  if (mode === "off") return new Set();
  const blocked = [...new Set(ids)].filter((id) => cardIdBlocked(id, scrub)).sort();
  for (const id of blocked) {
    noteSkip(db, { project, mechanism: MIRROR_SKIP_KEY, target: id, actionKey: `mirror-skip:${featureId}`,
      action: `略过 ${featureId} 镜像里卡号撞外发闸的卡 ${id}`, data: { featureId, taskId: id, mode } }, opts.now);
  }
  return new Set(mode === "on" ? blocked : []);
}

/** Source DAG view (sharedLedgerDagVersion's skip): under on, bindings whose card id is blocked; else nothing is left out. */
export function mirrorSkipBinding(project: string, scrub: SharedLedgerScrubContext, policy?: RecoveryPolicyPort): ((taskId: string) => boolean) | undefined {
  return mirrorSkipMode(project, policy) === "on" ? (taskId) => cardIdBlocked(taskId, scrub) : undefined;
}
