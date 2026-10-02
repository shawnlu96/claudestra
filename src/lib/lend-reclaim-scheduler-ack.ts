/** A cancelled row alone does not prove its worker stopped; only the lender sends this after the existing kill confirmation. */
import type { Database } from "bun:sqlite";
import { workerName } from "./lend-worker-name.js";
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
    AND json_extract(e.data, '$.op') = 'convergence_cancel' AND json_extract(e.data, '$.orderId') = o.orderId
    AND json_extract(e.data, '$.gen') = o.leaseGen LIMIT 1`)
    .get(orderId, peer, gen);
}

export async function acknowledgeConvergenceCancel(row: LendRow, why: string | null, d: LendDeps): Promise<boolean> {
  if (!why?.includes("convergence_cancelled")) return true;
  if (!row.leaseGen || typeof row.wire?.order.head !== "string") return false;
  const absent = !row.sessionId;
  if (absent) {
    if (!["claimed", "cloned"].includes(row.state) || row.work || row.payload) return false;
    const agent = row.agent ?? workerName(row.orderId);
    // Creation records the deterministic name before spawning; kill and a fresh probe also cover interrupted registration.
    if (!(await d.worker.kill(agent)).ok || await d.worker.alive(agent) !== "no_window") return false;
  }

  const body = { orderId: row.orderId, gen: row.leaseGen, cancelAck: { clean: !row.work && !row.payload, ...(absent ? { workerAbsent: true } : {}) },
    verdict: { v: 1, orderId: row.orderId, head: row.wire.order.head, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "cancel.md" },
    report: "worker exit confirmed; no work published", session: { id: row.sessionId ?? "", family: row.family } };
  const result = await lendRequest(d.call, row.peer, "result", body);
  if (!result.ok) d.log(`${row.orderId} clean cancellation acknowledgement failed: ${result.code}`);
  if (!result.ok) return false;
  const sha = createHash("sha256").update(JSON.stringify({ v: 1, ...body })).digest("hex");
  const verified = result.value.orderId === row.orderId && result.value.sha256 === sha && await d.verifyReceipt(row.peer, result.value);
  if (!verified) d.log(`${row.orderId} cancellation acknowledgement receipt did not verify; will retry`);
  return verified;
}
