/**
 * Borrower side of a lender's `stopped` release (leaseLend): a worker whose login broke keeps failing every order it takes, so the
 * (peer, family) cools for 30 minutes in lend_peer_cooldowns under a `runtime:` reason, which cooldownPeerSlots already zeroes.
 * Auth (structured failure.class, or an old lender's shared lead text) cools at once; any other stop needs a second order id
 * stopped within the window with no done order in between. An auth-stopped review order is released instead of parked unknown:
 * it wrote nothing and its verdict never entered. Switch `lendRuntimeCooldown`. tests/lend-peer-runtime-cooldown*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { CLAUDE_AUTH_STOP_LEAD } from "./lend-claude-pause-worker.js";
import { isWriteStep } from "./lend-git.js";
import { isRuntimeCooldown } from "./lend-peer-cooldown.js";
import type { LeaseRequest } from "./lend-wire.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { LendOrder } from "./ledger-lend.js";
import { insertEvent } from "./ledger-tx.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";

const RUNTIME_COOLDOWN_KEY = "lendRuntimeCooldown";
export const RUNTIME_COOLDOWN_MS = 30 * 60_000;
/** Recent stops kept per (peer, family); two inside the window are enough, a few more absorb retries of the same order. */
const STOPS_KEPT = 8;

type Stop = Pick<LeaseRequest, "reason" | "detail" | "failure">;
type Order = Pick<LendOrder, "orderId" | "taskId" | "project" | "peer" | "family" | "step">;
type Decision = "act" | "observe" | "skip";

/** A structured class decides alone; only a release without one falls back to the lender's shared lead text. */
function stoppedForAuth(req: Stop): boolean {
  if (req.reason !== "stopped") return false;
  return req.failure ? req.failure.class === "auth" : (req.detail ?? "").startsWith(CLAUDE_AUTH_STOP_LEAD);
}

function decide(db: Database, o: Order, now: number, policy: RecoveryPolicyPort): Decision {
  const a = { project: o.project, mechanism: RUNTIME_COOLDOWN_KEY } as const;
  return decideRecovery(noteDefaultOn(db, a, policy(o.project, RUNTIME_COOLDOWN_KEY), now)).kind;
}

/** One sample per order id and action; an id the observe key cannot hold is logged rather than failing the lease. */
function observe(db: Database, o: Order, kind: "cooldown" | "release", action: string, now: number): void {
  try {
    recordObserved(db, { project: o.project, mechanism: RUNTIME_COOLDOWN_KEY, target: o.taskId, actionKey: `${kind}:${o.orderId}`, action,
      data: { lend: { orderId: o.orderId, peer: o.peer, family: o.family } } }, now);
  } catch (e) {
    console.error(`[lend] ${RUNTIME_COOLDOWN_KEY} 观察样本没记上（${(e as Error).message}）`);
  }
}

/** Called before leaseLend parks the order: true = treat this stopped review order like not_started (released, step unbound). */
export function authReviewReleases(db: Database, o: Order, req: Stop, now: number, policy: RecoveryPolicyPort = recoveryPolicy): boolean {
  if (isWriteStep(o.step) || !stoppedForAuth(req)) return false;
  const d = decide(db, o, now, policy);
  if (d === "observe") observe(db, o, "release", `释放 ${o.peer} 登录失效的审查单 ${o.orderId}（不置 unknown）`, now);
  return d === "act";
}

const stopsKey = (o: Order): string => `lend:runtime-stops:${JSON.stringify([o.peer, o.family])}`;
function readStops(db: Database, key: string): { orderId: string; at: number }[] {
  const row = db.query("SELECT value FROM meta WHERE project = 'master' AND key = ?").get(key) as { value: string } | null;
  try {
    const v = JSON.parse(row?.value ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((s) => typeof s?.orderId === "string" && Number.isFinite(s?.at)) : [];
  } catch { return []; /* A damaged list only forgets earlier stops: the next stop starts counting again. */ }
}

/** Records this stop; true when another order id of the same (peer, family) stopped inside the window after the last done order. */
function repeatedStop(db: Database, o: Order, now: number): boolean {
  const key = stopsKey(o);
  const done = db.query("SELECT MAX(updatedAt) AS at FROM lend_orders WHERE peer = ? AND status = 'done' AND family = ?").get(o.peer, o.family) as
    { at: number | null } | null;
  const since = Math.max(now - RUNTIME_COOLDOWN_MS, done?.at ?? 0);
  const prior = readStops(db, key).filter((s) => s.at > since && s.orderId !== o.orderId);
  db.run(`INSERT INTO meta (project, key, value) VALUES ('master', ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify([...prior, { orderId: o.orderId, at: now }].slice(-STOPS_KEPT))]);
  return prior.length > 0;
}

/** Called after the stop note: cool (peer, family) when warranted; never shortens a longer cooldown already in place. */
export function runtimeStopCooldown(db: Database, ctx: WriteCtx, o: Order, req: Stop, now: number, policy: RecoveryPolicyPort = recoveryPolicy): void {
  if (req.reason !== "stopped") return;
  const d = decide(db, o, now, policy);
  if (d === "skip") return;
  const reason = stoppedForAuth(req) ? "runtime:auth" : repeatedStop(db, o, now) ? "runtime:stopped×2" : null;
  if (!reason) return;
  const until = now + RUNTIME_COOLDOWN_MS;
  if (d === "observe") return observe(db, o, "cooldown", `冷却 ${o.peer} 的 ${o.family} 到 ${new Date(until).toISOString()}（${reason}）`, now);
  const cur = db.query("SELECT until, reason FROM lend_peer_cooldowns WHERE peer = ? AND family = ?").get(o.peer, o.family) as
    { until: number; reason: string } | null;
  if (cur && cur.until >= until) return;
  db.run(`INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt, baselineWeekUsedPct) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(peer, family) DO UPDATE SET until = excluded.until, reason = excluded.reason, startedAt = excluded.startedAt,
    baselineWeekUsedPct = excluded.baselineWeekUsedPct`, [o.peer, o.family, until, reason, now]);
  insertEvent(db, ctx, { project: o.project, target: o.taskId, kind: "note",
    text: `出借：${o.peer} 的 ${o.family} 冷却到 ${new Date(until).toISOString()}（${reason}）`,
    data: { lend: { orderId: o.orderId, peer: o.peer, op: "runtime_cooldown", family: o.family, until, reason,
      ...(cur && cur.until > now && !isRuntimeCooldown(cur.reason) ? { replaced: cur.reason } : {}) } } }, false);
}
