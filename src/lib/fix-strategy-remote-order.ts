/** A remote convergence order and its intent link are committed together, so a restart cannot offer the same effect twice. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { SchedulerIntent, AuthorFamily } from "./ledger-scheduler.js";
import { insertEvent } from "./ledger-tx.js";
import { gateOfferTransaction } from "./order-gate-heads.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { getLendOrder, type LendOrder } from "./ledger-lend.js";
import { forPeer, heldLease, holdWriteLease } from "./ledger-lend-lease.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { LEASE_MS_DEFAULT } from "./lend-wire.js";
import { parseOrderWire, type OrderWire } from "./order-wire.js";
import { redactOrderForPeer, renderOrderWire } from "./order-wire-render.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { convergenceIntent } from "./fix-strategy-remote-intent.js";
import { convergencePlacement, type RemoteConvergenceContext } from "./fix-strategy-remote-context.js";
import { peerRefusal } from "./scheduler-placement.js";

export const remoteOrder = (db: Database, id: string): LendOrder | null => {
  const orderId = getEventByDedup(db, `scheduler:${id}:remote-order`)?.data.orderId;
  return typeof orderId === "string" ? getLendOrder(db, orderId) : null;
};

export function offerConvergence(db: Database, ctx: WriteCtx, intent: SchedulerIntent, context: RemoteConvergenceContext,
  peer: string, family: AuthorFamily, build: (task: LedgerTask, orderId: string) => OrderWire): LendOrder {
  return gateOfferTransaction(db, ctx, mustTask(db, intent.taskId), () => {
    const current = convergenceIntent(db, ctx, intent.id, intent.action);
    const prior = remoteOrder(db, intent.id);
    if (prior) return prior;
    const task = mustTask(db, intent.taskId);
    if (task.rev !== current.taskRev) throw new LedgerError("conflict", "remote convergence card changed");
    const now = ctx.now ?? Date.now(), role = intent.action === "arbitrate" ? "review" : "write";
    const { facts } = convergencePlacement(db, task, context, family, role, now);
    const p = facts.peers.find((x) => x.peer === peer);
    const refusal = peerRefusal(facts, p, role, family);
    if (refusal) throw new LedgerError("conflict", refusal);
    if (db.query("SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')").get(task.id)) {
      throw new LedgerError("conflict", "card already has a live lend order");
    }
    const orderId = `lend:${task.id}:cv:${intent.eventSeq}`;
    const raw = forPeer(db, ctx, task, { wire: build(task, orderId) }).wire, lease = heldLease(db, task), holder = getLendPeer(db, peer);
    if (raw.step === "fix") {
      if (!task.branch || (holder?.proto ?? 1) < 3 || !holder?.fp || (lease && lease.peer !== peer)) {
        throw new LedgerError("conflict", "fix requires card branch and proto-3 pinned holder");
      }
      holdWriteLease(db, task, { peer, fp: holder.fp, branch: task.branch, repo: facts.repo! }, now);
    }
    const parsed = parseOrderWire(redactOrderForPeer(raw, task.headSHA).order);
    if (!parsed.ok) throw new LedgerError("invalid", parsed.error);
    const text = renderOrderWire(parsed.value, { audience: "peer", ledgerHead: task.headSHA });
    db.prepare(`INSERT INTO lend_orders
      (orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt, branch, base)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pooled', ?, 'scheduler', ?, ?, ?, ?)`)
      .run(orderId, task.id, task.project, peer, family, raw.step, task.specRev, task.round, task.headSHA!, facts.repo!, raw.pr,
        JSON.stringify(parsed.value), text, createHash("sha256").update(text).digest("hex"), LEASE_MS_DEFAULT, now, now,
        raw.step === "fix" ? task.branch : null, raw.step === "fix" ? "main" : null);
    if (current.status === "pending") settleIntent(db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "claimed; remote convergence" });
    insertEvent(db, { ...ctx, dedupKey: `scheduler:${intent.id}:remote-order` }, { project: task.project, target: task.id,
      kind: "scheduler", text: `remote convergence ${peer}`, data: { op: "convergence_effect", intentId: intent.id, orderId, family, peer } }, true);
    return getLendOrder(db, orderId)!;
  });
}
