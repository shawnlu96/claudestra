/** Borrower-side quota memory survives stale lender capacity reports and process restarts. */
import type { Database } from "bun:sqlite";
import { classifyAirFailure } from "./acp/failures.js";
import type { LendFamily } from "./lend-config.js";
import type { LendNotice, LendOrder } from "./ledger-lend.js";
import type { Paused } from "./lend-wire-v2.js";

export const LEND_PEER_COOLDOWN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lend_peer_cooldowns (
    peer TEXT NOT NULL, family TEXT NOT NULL CHECK (family IN ('codex','claude')),
    until INTEGER NOT NULL, reason TEXT NOT NULL, startedAt INTEGER NOT NULL,
    PRIMARY KEY (peer, family))`,
];
const HOUR = 3600_000;
// A weekly reset hint may omit its timezone; one extra day keeps the actual reset reachable.
const MAX_COOLDOWN = 8 * 24 * HOUR;

/** Extract only the reset hint; absent zones use UTC, never the host's local zone. */
export function peerCooldownUntil(reason: string, now: number): number {
  const english = reason.match(/try again at ([A-Za-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}) (\d{1,2}):(\d{2})\s*(AM|PM)(?:\s+(UTC|GMT|[+-]\d{2}:?\d{2}))?/i);
  const iso = reason.match(/try again at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  const value = english ? `${english[1]} ${english[2]}, ${english[3]} ${english[4]}:${english[5]} ${english[6]} ${english[7] ?? 'UTC'}`
    : iso ? `${iso[1]}${/Z$|[+-]\d{2}:?\d{2}$/.test(iso[1]) ? '' : 'Z'}` : '';
  const reset = Date.parse(value);
  return Math.min(Number.isFinite(reset) ? reset : now + 6 * HOUR, now + MAX_COOLDOWN);
}

/** Clearing happens only after a successful claim / PM reoffer inside the owning transaction. */
export function clearPeerCooldown(db: Database, peer: string, family: LendFamily): void {
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

/** Only an accepted hello may replace a live cooldown; another family's pause cannot change it. */
export function updatePeerCooldownHello(db: Database, peer: string, paused: Paused | null, now: number): void {
  if (!paused) return;
  db.run(`UPDATE lend_peer_cooldowns SET until = ? WHERE peer = ? AND until > ?
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
