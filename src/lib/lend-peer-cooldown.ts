/** Borrower-side quota memory survives stale lender capacity reports and process restarts. */
import type { Database } from "bun:sqlite";
import { classifyAirFailure } from "./acp/failures.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-config.js";
import type { LendNotice, LendOrder } from "./ledger-lend.js";
import type { HelloQuota, Paused } from "./lend-wire-v2.js";
import { lendQuotaResetAt } from "./lend-quota-reset.js";

export const LEND_PEER_COOLDOWN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lend_peer_cooldowns (
    peer TEXT NOT NULL, family TEXT NOT NULL CHECK (family IN ('codex','claude')),
    until INTEGER NOT NULL, reason TEXT NOT NULL, startedAt INTEGER NOT NULL,
    PRIMARY KEY (peer, family))`,
];
const HOUR = 3600_000;
// A weekly reset hint may omit its timezone; one extra day keeps the actual reset reachable.
const MAX_COOLDOWN = 8 * 24 * HOUR;

/** Keep borrower fallback and cap independent of the lender's pause policy. */
export function peerCooldownUntil(reason: string, now: number): number {
  return Math.min(lendQuotaResetAt(reason, now) ?? now + 6 * HOUR, now + MAX_COOLDOWN);
}

/** Claims clear their target; an explicit reoffer clears only when it retries the same peer and family. */
export function clearPeerCooldown(db: Database, peer: string, family: LendFamily, destination?: Pick<LendOrder, "peer" | "family">): void {
  if (destination && (destination.peer !== peer || destination.family !== family)) return;
  db.run("DELETE FROM lend_peer_cooldowns WHERE peer = ? AND family = ?", [peer, family]);
}

/** A repeated failure inside this interval keeps the first reset and emits no second PM notice. */
export function cooldownReleaseNotices(db: Database, o: LendOrder, detail: string, now: number, notices: LendNotice[]): LendNotice[] {
  // The existing classifier applies text detection to limit banners; retry prevents generic errors becoming quota.
  const quota = classifyAirFailure({ id: o.orderId, revision: 1, category: "limit", severity: "error", title: detail, actions: ["retry"] });
  if (quota.kind !== "quota") return notices;
  const cur = db.query("SELECT until FROM lend_peer_cooldowns WHERE peer = ? AND family = ?").get(o.peer, o.family) as { until: number } | null;
  if (cur && cur.until > now) return notices;
  const until = peerCooldownUntil(detail, now);
  db.run(`INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(peer, family) DO UPDATE SET until = excluded.until, reason = excluded.reason, startedAt = excluded.startedAt`,
  [o.peer, o.family, until, detail, now]);
  return [...notices, { project: o.project, taskId: o.taskId,
    text: `额度冷却：${o.peer} 的 ${o.family} 名额暂停至 ${new Date(until).toISOString()}；原因：${detail}` }];
}

/** A later quota window can clear an unpaused family; pause deadlines alone only extend cooldowns. */
export function updatePeerCooldownHello(db: Database, peer: string, paused: Paused | null, now: number, quota?: HelloQuota): void {
  for (const family of LEND_FAMILIES) {
    const reading = quota?.[family];
    const familyPaused = paused && (paused.reason === `${family}_quota` || !paused.reason.endsWith("_quota"));
    // Equal reset times may be cached before the failure; old hellos without quota prove no recovery.
    if (!familyPaused && reading && reading.weekUsedPct < 100) {
      db.run("DELETE FROM lend_peer_cooldowns WHERE peer = ? AND family = ? AND until < ?", [peer, family, reading.resetAt]);
    }
  }
  if (!paused) return;
  db.run(`UPDATE lend_peer_cooldowns SET until = MAX(until, ?) WHERE peer = ? AND until > ?
    AND (? = family || '_quota' OR substr(?, -6) != '_quota')`, [paused.until, peer, now, paused.reason, paused.reason]);
}

/** Old in-memory fixture databases lack this optional table; production migrates before planning. */
export function cooldownPeerSlots(db: Database, peer: string, slots: Record<LendFamily, number>, now: number): Record<LendFamily, number> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'lend_peer_cooldowns' AND type = 'table'").get()) return slots;
  const rows = db.query("SELECT family FROM lend_peer_cooldowns WHERE peer = ? AND until > ?").all(peer, now) as { family: LendFamily }[];
  const result = { ...slots };
  for (const row of rows) result[row.family] = 0;
  return result;
}
