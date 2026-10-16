/**
 * Borrower side of a lender's `stopped` release (leaseLend): a worker whose login broke keeps failing every order it takes, so the
 * (peer, family) cools for 30 minutes in lend_peer_cooldowns under a `runtime:` reason, which cooldownPeerSlots already zeroes.
 * Auth (structured failure.class, or an old lender's shared lead text) cools at once; any other stop needs a second order id
 * stopped within the window with no done order in between. An auth-stopped review order is released instead of parked unknown:
 * it wrote nothing and its verdict never entered. A `not_started` cools too: a network fetch failure at once, any other on its second
 * order id in the window (a start mismatch is ours, never counted); sendBack then drops the pin on that peer (pinnedPeerCooled).
 * Switch `lendRuntimeCooldown`. tests/lend-peer-runtime-cooldown*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { classifyAirFailure } from "./acp/failures.js";
import { classifyConfigFailure } from "./lend-config-failure.js";
import { CLAUDE_AUTH_STOP_LEAD } from "./lend-claude-pause-worker.js";
import { isWriteStep } from "./lend-git.js";
import { isRuntimeCooldown } from "./lend-peer-cooldown.js";
import type { LeaseRequest } from "./lend-wire.js";
import type { WriteCtx } from "./ledger-checks.js";
import type { LendOrder } from "./ledger-lend.js";
import { appendEvent } from "./ledger-write.js";
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

/**
 * One sample per order id: an auth review release always comes with an auth cooldown, so both ride on the cooldown's sample.
 * An id the observe key cannot hold is logged rather than failing the lease.
 */
function observe(db: Database, o: Order, cooldown: { until: number; reason: string }, release: boolean, now: number): void {
  const action = `冷却 ${o.peer} 的 ${o.family} 到 ${new Date(cooldown.until).toISOString()}（${cooldown.reason}）`
    + (release ? `，并释放登录失效的审查单 ${o.orderId}（不置 unknown）` : "");
  try {
    recordObserved(db, { project: o.project, mechanism: RUNTIME_COOLDOWN_KEY, target: o.taskId, actionKey: `stop:${o.orderId}`, action,
      data: { lend: { orderId: o.orderId, peer: o.peer, family: o.family }, cooldown, release } }, now);
  } catch (e) {
    console.error(`[lend] ${RUNTIME_COOLDOWN_KEY} 观察样本没记上（${(e as Error).message}）`);
  }
}

/** lend-clone.ts reports a failed fetch as `取不到 <sha>：<git tail>`; only these tails are the network, not a missing ref or permission. */
const NETWORK_FETCH = /unable to access|SSL|Could not resolve host|Failure when receiving data/;
function notStartedForNetwork(req: Stop): boolean {
  if (req.reason !== "not_started") return false;
  const d = req.detail ?? "";
  return req.failure ? req.failure.class === "network" : d.startsWith("取不到 ") && NETWORK_FETCH.test(d);
}
/**
 * not_started kinds another mechanism owns are never counted: a start mismatch (lend-fix-start.ts retries it; our base moved),
 * a model-config failure or its refusal (lend-config-failure-pool.ts pauses until the lender's declared recovery, which a 30-minute
 * row would outlast) and a quota wall (cooldownReleaseNotices cools it to its own reset).
 */
const START_MISMATCH = /不是这一单的起点/;
const CONFIG_REFUSAL = /配置故障未恢复，没有再启动/;
function ownedElsewhere(o: Order, detail: string): boolean {
  if (START_MISMATCH.test(detail) || CONFIG_REFUSAL.test(detail) || classifyConfigFailure(detail)) return true;
  return classifyAirFailure({ id: o.orderId, revision: 1, category: "limit", severity: "error", title: detail, actions: ["retry"] }).kind === "quota";
}

const releasable = (o: Order, req: Stop): boolean => !isWriteStep(o.step) && stoppedForAuth(req);

/** Called before leaseLend parks the order: true = treat this stopped review order like not_started (released, step unbound). */
export function authReviewReleases(db: Database, o: Order, req: Stop, now: number, policy: RecoveryPolicyPort = recoveryPolicy): boolean {
  return releasable(o, req) && decide(db, o, now, policy) === "act";
}

// not_started keeps its own list so a stop and a failed start never pair up; the stopped key is unchanged from AUTHCOOL1.
const stopsKey = (o: Order, kind: Stop["reason"]): string =>
  `lend:runtime-stops:${kind === "not_started" ? "not_started:" : ""}${JSON.stringify([o.peer, o.family])}`;
function readStops(db: Database, key: string): { orderId: string; at: number }[] {
  const row = db.query("SELECT value FROM meta WHERE project = 'master' AND key = ?").get(key) as { value: string } | null;
  try {
    const v = JSON.parse(row?.value ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((s) => typeof s?.orderId === "string" && Number.isFinite(s?.at)) : [];
  } catch { return []; /* A damaged list only forgets earlier stops: the next stop starts counting again. */ }
}

/** Records this stop; true when another order id of the same (peer, family) stopped inside the window after the last done order. */
function repeatedStop(db: Database, o: Order, kind: Stop["reason"], now: number): boolean {
  const key = stopsKey(o, kind);
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
  const d = req.reason === "stopped" || req.reason === "not_started" ? decide(db, o, now, policy) : "skip";
  if (d === "skip") return;
  // A network not_started is recorded too (then network wins this reason), so a plain failure after it pairs as the second.
  const second = req.reason === "not_started" && !ownedElsewhere(o, req.detail ?? "") && repeatedStop(db, o, "not_started", now);
  const reason = req.reason === "stopped" ? (stoppedForAuth(req) ? "runtime:auth" : repeatedStop(db, o, "stopped", now) ? "runtime:stopped×2" : null)
    : notStartedForNetwork(req) ? "runtime:network" : second ? "runtime:not_started×2" : null;
  if (!reason) return;
  const until = now + RUNTIME_COOLDOWN_MS;
  if (d === "observe") return observe(db, o, { until, reason }, releasable(o, req), now);
  const cur = db.query("SELECT until, reason FROM lend_peer_cooldowns WHERE peer = ? AND family = ?").get(o.peer, o.family) as
    { until: number; reason: string } | null;
  if (cur && cur.until >= until) return;
  db.run(`INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt, baselineWeekUsedPct) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(peer, family) DO UPDATE SET until = excluded.until, reason = excluded.reason, startedAt = excluded.startedAt,
    baselineWeekUsedPct = excluded.baselineWeekUsedPct`, [o.peer, o.family, until, reason, now]);
  // The caller's dedupKey belongs to the lease request's own event; this note carries none.
  appendEvent(db, { actor: ctx.actor, now }, { project: o.project, target: o.taskId, kind: "note",
    text: `出借：${o.peer} 的 ${o.family} 冷却到 ${new Date(until).toISOString()}（${reason}）`,
    data: { lend: { orderId: o.orderId, peer: o.peer, op: "runtime_cooldown", family: o.family, until, reason,
      ...(cur && cur.until > now && !isRuntimeCooldown(cur.reason) ? { replaced: cur.reason } : {}) } } });
}

/**
 * sendBack's pin check: (peer, family) sits in a live runtime cooldown (one written earlier in the same transaction counts), which a
 * later done order has not ended (cooldownPeerSlots' rule). Only `on` unpins; observe and off leave the pin as before.
 */
export function pinnedPeerCooled(db: Database, o: Order, now: number, policy: RecoveryPolicyPort = recoveryPolicy): boolean {
  const cur = db.query("SELECT reason, startedAt FROM lend_peer_cooldowns WHERE peer = ? AND family = ? AND until > ?").get(o.peer, o.family, now) as
    { reason: string; startedAt: number } | null;
  if (!cur || !isRuntimeCooldown(cur.reason)) return false;
  const ended = db.query("SELECT 1 FROM lend_orders WHERE peer = ? AND family = ? AND status = 'done' AND updatedAt >= ?").get(o.peer, o.family, cur.startedAt);
  return !ended && decide(db, o, now, policy) === "act";
}
