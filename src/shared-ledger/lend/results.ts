import type { V2LendOrder } from "../../lib/shared-ledger-contract-v2-lend.js";
import { parseStep } from "../../lib/shared-ledger-contract-v2-tasks.js";
import type { V2TransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { v2ObjectDigest } from "../../lib/shared-ledger-contract-v2-integrity.js";
import { fail } from "../../lib/shared-ledger-contract-v2-validation.js";
import { assertLiveLease, assertTaskOrder, loadExecution, orderStep, sameWorker, synchronous, type LendCommand, type LendPorts } from "./checks.js";
import { insertLendRow, readLendRow } from "./storage.js";
import { saveOrder } from "./actions.js";

export function resultOrder(context: V2TransactionContext, ports: LendPorts, command: Extract<LendCommand, { type: "lend.result" }>, old: V2LendOrder) {
  const result = command.payload.result;
  if (result.taskId !== old.taskId || result.specRev !== old.specRev || result.round !== old.round || result.expectedHead !== old.head) fail("stale_order");
  if (result.leaseGen !== old.leaseGen) fail("stale_lease_gen");
  if (result.executorInstanceId !== old.executorInstanceId || !sameWorker(result.worker, old.worker)) fail("forbidden");
  const existing = readLendRow(context, "result", old.orderId);
  if (existing) {
    if (v2ObjectDigest(existing) !== v2ObjectDigest(result)) fail("dedup_mismatch");
    return { order: old, result: existing, replayed: true };
  }
  assertLiveLease(context, old, result.leaseGen, result.executorInstanceId);
  const { task } = loadExecution(context, ports, old.taskId); assertTaskOrder(task, old);
  if (old.step === "review") {
    if (result.head !== old.head || result.verdict === "delivered") fail("stale_order");
  } else if (["pass", "changes", "block"].includes(result.verdict)) fail("invalid_field");
  const step = orderStep(context, ports, old);
  if (!step || step.state !== "assigned" || !sameWorker(step.executor, old.worker) || step.headFrom !== old.head) fail("stale_order");
  const completed = result.verdict !== "failed" && result.verdict !== "unknown";
  // Worker claims do not establish independent verification, ownership, task head or stage transitions.
  synchronous(ports.writeStep(context, step, parseStep({ ...step,
    state: completed ? (old.step === "review" ? "done" : "delivered") : step.state,
    headTo: completed ? result.head : step.headTo,
    verdict: ["pass", "changes", "block"].includes(result.verdict) ? result.verdict : null,
    claims: { ...step.claims, summary: result.summary }, rev: step.rev + 1, updatedAt: context.scope.now,
  })));
  insertLendRow(context, "result", result);
  const order = saveOrder(context, ports, command, old, { ...old,
    status: result.verdict === "unknown" ? "unknown" : "done", resultDigest: result.resultDigest, resultOperationId: result.operationId,
  });
  return { order, result, replayed: false };
}
