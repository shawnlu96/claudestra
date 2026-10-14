/**
 * dispatch-recovery-PEERLEASE1 · scheduler-local-author.ts launch: the family a new local author is created in under a peer author
 * handover — the runtime the handover froze (recovery-peer-lease-family.ts), so the seat wait and the registry receipt check go by it
 * and no other family is created. Only under on: off and observe always get null, and the launch line is the old expression unchanged.
 * After a delivery since the handover, or for another spec / round / head, null (the original choice again). Kept apart from the
 * family module, which sessions import and so may not read the switch (deps:no-cycle). tests/recovery-peer-lease-runtime.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { peerLeaseMode } from "./recovery-peer-lease.js";
import { handoverFrozenRuntime } from "./recovery-peer-lease-family.js";

export function handoverRuntime(db: Database, task: { id: string; project: string; specRev: number; round: number; headSHA: string | null; stage: string }): AuthorFamily | null {
  return peerLeaseMode(db, task.project) === "on" ? handoverFrozenRuntime(db, task) : null;
}
