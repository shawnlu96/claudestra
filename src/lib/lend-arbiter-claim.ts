/** Arbitration claims retain the ordinary reviewer binding; fixes and ordinary reviews use the existing step writer. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LendOrder } from "./ledger-lend.js";
import { assignStep } from "./ledger-steps-write.js";
import { getIntent } from "./ledger-scheduler.js";
import { LedgerError } from "./ledger-store.js";

export function claimConvergenceStep(db: Database, ctx: WriteCtx, o: LendOrder, worker: string, peer: string): void {
  const binding = o.wire.convergence;
  if (binding?.kind === "arbitration") {
    const intent = getIntent(db, binding.intentId);
    if (intent?.action !== "arbitrate" || intent.status !== "submitted" || intent.taskId !== o.taskId || intent.head !== o.head) {
      throw new LedgerError("conflict", "arbitration claim is no longer bound");
    }
    return;
  }
  assignStep(db, ctx, { taskId: o.taskId, step: o.step, executor: `${worker}@${peer}`, executorKind: "peer", round: o.round });
}
