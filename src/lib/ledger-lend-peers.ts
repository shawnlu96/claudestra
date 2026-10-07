/**
 * A's side of lend protocol v2 (docs/design/remote-capacity.md §8; wire in lend-wire-v2.ts): a lender's hello lands in
 * lend_peers, its batched beat renews the leases it really holds and answers order by order, and the capacity the scheduler
 * may count on it is min(reported free, borrow.maxOpen − A's live orders there), zero once the hello is stale or the grant gone.
 * A beat that reports an order ended by revocation takes the not_started path only when that is safe: a clean review, or a
 * clean write order whose branch A itself saw unpushed; anything else stops for PM as before. Every peer-supplied field
 * other than the peer name is checked against the order row, never trusted. tests/ledger-lend-peers.test.ts.
 */
import { updatePeerCooldownHello } from "./lend-peer-cooldown.js";
import { recoverOnRedeclare } from "./lend-config-failure-pool.js";
import type { Database } from "bun:sqlite";
import { isWriteStep } from "./lend-git.js";
import type { OfferSummary } from "./lend-wire.js";
import { HELLO_FRESH_MS, type BeatAnswer, type BeatOrder, type BeatRequest, type HelloRequest, type OfferResponse } from "./lend-wire-v2.js";
import type { WriteCtx } from "./ledger-checks.js";
import { getLendOrder, leaseLend, withdrawPooledLend, type LendNotice, type LendOrder } from "./ledger-lend.js";
import { queueRefusal, queuedPushReady } from "./ledger-lend-queue.js";
import { ackPushed } from "./ledger-lend-peers-ttl.js";
import { phaseSince } from "./lend-pr-takeover.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { tx } from "./ledger-tx.js";
import { sanitizeForeign } from "./order-wire-render.js";
import { convergenceCancelled } from "./lend-reclaim-scheduler-ack.js";
import { getLendPeer, hasPeersTable, type LendPeer } from "./scheduler-placement-reservations.js";
export { getLendPeer, peerCapacity, unifiedPeerCapacity, type LendPeer, type PeerCapacity, type UnifiedPeerCapacity } from "./scheduler-placement-reservations.js";

/**
 * One hello. Within one boot of the lender the sequence must grow, so a delayed or replayed hello never rolls the grant back
 * (a revoke carries a higher seq than the grant it ends); a new boot starts over. applied:false = an old one, answered anyway.
 */
export function recordHello(db: Database, peer: string, fp: string | null, req: HelloRequest, now: number): { applied: boolean } {
  return tx(db, () => {
    const cur = getLendPeer(db, peer);
    if (cur && cur.boot === req.boot && req.seq <= cur.seq) return { applied: false };
    db.prepare(`INSERT INTO lend_peers (peer, fp, proto, boot, seq, grant, slots, paused, helloAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer) DO UPDATE SET fp = excluded.fp, proto = excluded.proto, boot = excluded.boot, seq = excluded.seq, grant = excluded.grant,
      slots = excluded.slots, paused = excluded.paused, helloAt = excluded.helloAt`).run(
      peer, fp, req.proto, req.boot, req.seq, req.grant ? JSON.stringify(req.grant) : null, JSON.stringify(req.slots),
      req.paused ? JSON.stringify(req.paused) : null, now);
    updatePeerCooldownHello(db, peer, req.paused, now, req.quota);
    recoverOnRedeclare(db, peer, cur, req, now);
    return { applied: true };
  });
}

/** A beat or ask says a revocation happened: the grant counts as gone until the lender's next hello says otherwise. */
const markRevoked = (db: Database, peer: string): void => void db.prepare("UPDATE lend_peers SET grant = NULL WHERE peer = ?").run(peer);

export type CleanCheck = "clean" | "dirty" | "unknown";

/** Only a peer whose hello on file says proto 2 gets the revoke-and-requeue path; no row = proto 1 (design doc §8.3). */
const speaksV2 = (db: Database, peer: string): boolean => (getLendPeer(db, peer)?.proto ?? 1) >= 2;

/** The write orders a beat reports as cleanly ended that this peer holds under the stated gen: A checks their branches before the transaction. */
export function cleanEndedWrites(db: Database, peer: string, req: BeatRequest): LendOrder[] {
  if (!speaksV2(db, peer)) return [];
  return req.orders.flatMap((b) => {
    const o = b.ended?.clean ? getLendOrder(db, b.orderId) : null;
    return o && o.peer === peer && o.status === "claimed" && o.leaseGen === b.gen && isWriteStep(o.step) && o.branch ? [o] : [];
  });
}

const VERDICT_OF: Partial<Record<LendOrder["status"], BeatAnswer["verdict"]>> = {
  done: "done", cancelled: "cancelled", released: "cancelled", unknown: "lease_expired", pooled: "not_found",
};

/** The held, live, same-generation order this beat line may touch, or the verdict that refuses it. */
function heldOrder(db: Database, peer: string, b: Pick<BeatOrder, "orderId" | "gen">, now: number): LendOrder | BeatAnswer["verdict"] {
  const o = getLendOrder(db, b.orderId);
  if (!o || o.peer !== peer || !o.worker) return "not_found";
  if (convergenceCancelled(db, peer, b.orderId, b.gen)) return "convergence_cancelled";
  if (o.status !== "claimed") return VERDICT_OF[o.status] ?? "not_found";
  if ((o.leaseUntil ?? 0) < now) return "lease_expired";
  return o.leaseGen === b.gen ? o : "stale_gen";
}

/** Revoked: clean only for a proto-2 peer (checked inside the transaction) that said clean, and for a write order whose branch A checked. */
function endOrder(db: Database, ctx: WriteCtx, o: LendOrder, b: BeatOrder, checks: Map<string, CleanCheck>): LendNotice[] {
  const v2 = speaksV2(db, o.peer);
  const writeClean = !isWriteStep(o.step) || checks.get(o.orderId) === "clean";
  const clean = v2 && b.ended!.clean && writeClean;
  const detail = clean ? "出借方收回授权，worker 干净停下（没有外部副作用），自动重排"
    : !v2 ? "出借方收回授权；对方没有 v2 hello（proto 1），不自动重排"
    : b.ended!.clean ? "出借方收回授权；写单分支在远端核对不了或已有推送，不自动重排" : "出借方收回授权，worker 停下时不干净";
  markRevoked(db, o.peer);
  return leaseLend(db, ctx, o.peer, { v: 1, orderId: o.orderId, gen: o.leaseGen, action: "release", reason: clean ? "not_started" : "stopped", detail }).notices;
}

/**
 * One batched heartbeat: each line renews the lease of an order this peer holds under that gen, or says why not; an `ended`
 * line releases it (see endOrder). The phase / excerpt land in lend_orders.beat (excerpt masked again here), with since = when this phase
 * began (kept while the phase stays the same). One transaction.
 */
export function beatLend(db: Database, ctx: WriteCtx, peer: string, req: BeatRequest, checks: Map<string, CleanCheck>): { orders: BeatAnswer[]; notices: LendNotice[] } {
  return tx(db, () => {
    const now = ctx.now ?? Date.now();
    const notices: LendNotice[] = [];
    const orders = req.orders.map((b): BeatAnswer => {
      const o = heldOrder(db, peer, b, now);
      if (typeof o === "string") return { orderId: b.orderId, verdict: o, lease: null };
      const prev = (db.query("SELECT beat FROM lend_orders WHERE orderId = ?").get(o.orderId) as { beat: string | null } | null)?.beat ?? null;
      const since = phaseSince(prev, b.phase, now); // 这个 phase 从哪一刻起：A 侧 publishing 卡住的接管按它算（lend-pr-takeover.ts）
      const beat = JSON.stringify({ gen: b.gen, phase: b.phase, lastActivityAt: b.lastActivityAt, excerpt: sanitizeForeign(b.excerpt), at: now, since });
      db.prepare("UPDATE lend_orders SET beatAt = ?, beat = ? WHERE orderId = ?").run(now, beat, o.orderId);
      if (b.ended) {
        notices.push(...endOrder(db, ctx, o, b, checks));
        return { orderId: b.orderId, verdict: "ok", lease: null };
      }
      const until = now + o.leaseMs;
      db.prepare("UPDATE lend_orders SET leaseUntil = ?, updatedAt = ? WHERE orderId = ? AND status = 'claimed'").run(until, now, o.orderId);
      return { orderId: b.orderId, verdict: "ok", lease: { gen: o.leaseGen, expiresAt: until, ms: o.leaseMs } };
    });
    return { orders, notices };
  });
}

/** Who is asking, as A knows it: the peer from the verified principal, everything else from the order row. */
export interface RemoteCaller { peer: string; fp: string | null; orderId: string; gen: number; worker: string; taskId: string; project: string }

export function remoteCaller(db: Database, peer: string, b: { orderId: string; gen: number }, now: number): RemoteCaller | { refused: string } {
  const o = heldOrder(db, peer, b, now);
  if (typeof o === "string") return { refused: `这一单不在你名下或已失效（${o}）` };
  return { peer, fp: getLendPeer(db, peer)?.fp ?? null, orderId: o.orderId, gen: o.leaseGen, worker: o.worker as string, taskId: o.taskId, project: o.project };
}

/** Is this peer on protocol 2 (has said hello)? Pushes and push TTLs apply only then. */
/** A pooled order the push loop may announce to its peer: its summary is exactly what v1 poll would list (no v2 field). */
export interface PushCandidate { peer: string; summary: OfferSummary }

/**
 * Pooled orders whose peer has a fresh v2 hello with a live grant. A peer that never said hello (proto 1), went quiet past
 * HELLO_FRESH_MS or revoked gets no push; its orders are left to polling and to the push TTL.
 */
export function pushCandidates(db: Database, now: number): PushCandidate[] {
  if (!hasPeersTable(db)) return [];
  const live = new Map<string, boolean>();
  const ok = (peer: string): boolean => {
    if (!live.has(peer)) {
      const p = getLendPeer(db, peer);
      live.set(peer, !!p && p.proto >= 2 && now - p.helloAt <= HELLO_FRESH_MS && !!p.grant && p.grant.until > now);
    }
    return live.get(peer) as boolean;
  };
  const rows = db.query(`SELECT orderId, taskId, step, family, repo, pr, head, round, specRev, createdAt, peer FROM lend_orders
    WHERE status = 'pooled' AND peer IN (SELECT peer FROM lend_peers WHERE proto >= 2) ORDER BY createdAt`).all() as (Omit<OfferSummary, "offeredAt"> & { createdAt: number; peer: string })[];
  return rows.filter((r) => ok(r.peer) && queuedPushReady(db, r, getLendPeer(db, r.peer)!, now)).map(({ peer, createdAt, ...s }) => ({ peer, summary: { ...s, offeredAt: createdAt } }));
}

/**
 * What a lender answered to one push: accepted orders are acknowledged (first ack only, ledger-lend-peers-ttl.ts), refused ones
 * withdrawn now so the round can go elsewhere. Only this peer's orders that are still pooled are touched. PM is told about
 * PM-offered cards; auto cards are re-placed by the scheduler's pool sync.
 */
export function answerPush(db: Database, ctx: WriteCtx, peer: string, a: OfferResponse): { acked: number; withdrawn: string[]; notices: LendNotice[] } {
  return tx(db, () => {
    const out = { acked: ackPushed(db, peer, a.accepted, ctx.now ?? Date.now()), withdrawn: [] as string[], notices: [] as LendNotice[] };
    for (const f of a.refused) {
      const o = getLendOrder(db, f.orderId);
      if (!o || o.peer !== peer) continue;
      const queued = queueRefusal(db, o, f.code, ctx.now ?? Date.now());
      if (queued) { out.notices.push(...queued.notices); continue; }
      if (!withdrawPooledLend(db, ctx, { orderId: o.orderId, reason: `推送被 ${peer} 拒收（${f.code}）` }).withdrawn) continue;
      out.withdrawn.push(o.orderId);
      if (getWorkflow(db, o.taskId)?.mode === "auto") continue;
      out.notices.push({ project: o.project, taskId: o.taskId, text: `出借单 ${o.orderId}（${o.taskId}）被 ${peer} 拒收（${f.code}），已撤回；要再借就 ledger lend-offer ${o.taskId}` });
    }
    return out;
  });
}
