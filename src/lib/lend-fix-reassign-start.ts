/**
 * Automatic fix reassignment (i28-RA1), the pool step's half: inside the offer's transaction, when the planned peer is not the
 * write-lease holder, re-check the relay rules on the ledger, end the old lease, record one relay event (why, from, to, start
 * head) and put out the fix order through the ordinary order core in the same savepoint: a refused order rolls the relay back.
 * Stage entry reused: the card stays in fix and the order is an ordinary fix order (no protocol change, any v2 lender takes it),
 * only on the new lender's own lend/ branch, from the PR's current head, with no PR number, so the lender opens a new PR
 * against the order's base, which is main (lend-write-materials.ts). tests/lend-fix-reassign.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { endWriteLease, heldLease, type WriteOffer } from "./ledger-lend-lease.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { lendBranch } from "./lend-git.js";
import { prCoordinates } from "./scheduler-pool-facts.js";
import { FIX_RELAY_OP, FIX_RELAY_WINDOW_MS, fixRelays } from "./lend-fix-reassign-event.js";

type LiveOrder = { orderId: string; peer: string; status: string };

function startRelay(db: Database, ctx: WriteCtx, task: LedgerTask, peer: string, write: WriteOffer, now: number): void {
  const lease = heldLease(db, task)!;
  const live = db.query(`SELECT orderId, peer, status FROM lend_orders WHERE taskId = ? AND status IN (${LEND_LIVE.map(() => "?").join(",")})`)
    .all(task.id, ...LEND_LIVE) as LiveOrder[];
  if (live.length) throw new LedgerError("conflict", `不自动改派：${live[0].peer} 在这张卡上还有未结的单 ${live[0].orderId}（${live[0].status}）`);
  const recent = fixRelays(db, task.id).findLast((r) => now - r.ts < FIX_RELAY_WINDOW_MS);
  if (recent) throw new LedgerError("conflict", `不自动改派：本卡一小时内已改派过一次（${recent.from} → ${recent.to}），交 PM`);
  const toBranch = lendBranch(task.id, write.fp);
  if (!toBranch || toBranch === lease.branch) throw new LedgerError("conflict", `不自动改派：${peer} 的出借分支与原分支 ${lease.branch} 撞名`);
  if (!task.headSHA || !/^[0-9a-f]{40}$/.test(task.headSHA)) throw new LedgerError("invalid", "卡上没有完整的 40 位 head，接力没有起点");
  const reason = `修复单等写租约方 ${lease.peer} 超过阈值，自动改派给 ${peer}`;
  endWriteLease(db, task.id, `自动改派：${lease.peer} → ${peer}`, now);
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:fix-relay:${task.id}:s${task.specRev}:r${task.round}:${peer}` }, {
    project: task.project, target: task.id, kind: "scheduler", text: `${reason}：从 PR 当前 head ${task.headSHA.slice(0, 12)} 在 ${toBranch} 接力`,
    data: { op: FIX_RELAY_OP, from: lease.peer, to: peer, head: task.headSHA, round: task.round, specRev: task.specRev, fromBranch: lease.branch,
      toBranch, repo: lease.repo, oldPr: prCoordinates(task.pr)?.pr ?? null, reason },
  }, true);
}

/**
 * The pool step's offer, wrapped: relay = the planned peer is not the lease holder of this fix. `offer(relay)` must put out the
 * order with no PR number when relay is true (the new lender opens a new PR; the old one is closed after delivery).
 */
export function relayOffer<T>(db: Database, ctx: WriteCtx, task: LedgerTask, peer: string, write: WriteOffer | null, offer: (relay: boolean) => T): T {
  const lease = task.stage === "fix" ? heldLease(db, task) : null;
  if (!lease || lease.peer === peer || !write) return offer(false);
  return tx(db, () => {
    startRelay(db, ctx, task, peer, write, ctx.now ?? Date.now());
    return offer(true);
  });
}
