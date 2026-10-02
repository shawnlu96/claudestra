/** A cancelled row alone does not prove its worker stopped; only the lender sends this after the existing kill confirmation. */
import type { Database } from "bun:sqlite";
import type { LendDeps } from "./lend-drive.js";
import type { LendRow } from "./lend-journal.js";
import { lendRequest } from "./lend-remote.js";
import { createHash } from "node:crypto";
export { convergenceWriteMismatch } from "./fix-strategy-remote-branch.js";
export const CONVERGENCE_GONE = { convergence_cancelled: "cancelled" } as const;

export function convergenceCancelled(db: Database, peer: string, orderId: string, gen: number): boolean {
  return !!db.query(`SELECT 1 FROM lend_orders o JOIN events e ON e.target = o.taskId
    JOIN lend_peers p ON p.peer = o.peer AND p.proto >= 3
    WHERE o.orderId = ? AND o.peer = ? AND o.leaseGen = ? AND o.status = 'cancelled' AND e.actor = 'scheduler'
    AND json_extract(e.data, '$.op') = 'convergence_cancel' AND json_extract(e.data, '$.orderId') = o.orderId LIMIT 1`)
    .get(orderId, peer, gen);
}

export async function acknowledgeConvergenceCancel(row: LendRow, why: string | null, d: LendDeps): Promise<boolean> {
  if (!why?.includes("convergence_cancelled")) return true;
  if (!row.sessionId || !row.leaseGen || typeof row.wire?.order.head !== "string") return false;
  const body = { orderId: row.orderId, gen: row.leaseGen, cancelAck: { clean: !row.work && !row.payload },
    verdict: { v: 1, orderId: row.orderId, head: row.wire.order.head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "cancel.md" },
    report: "worker exit confirmed; no work published", session: { id: row.sessionId, family: row.family } };
  const result = await lendRequest(d.call, row.peer, "result", body);
  if (!result.ok) d.log(`${row.orderId} clean cancellation acknowledgement failed: ${result.code}`);
  if (!result.ok) return false;
  const sha = createHash("sha256").update(JSON.stringify({ v: 1, ...body })).digest("hex");
  const verified = result.value.orderId === row.orderId && result.value.sha256 === sha && await d.verifyReceipt(row.peer, result.value);
  if (!verified) d.log(`${row.orderId} cancellation acknowledgement receipt did not verify; will retry`);
  return verified;
}
