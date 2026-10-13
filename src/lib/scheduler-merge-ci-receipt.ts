/**
 * The ledger's single-line receipt gate (closeMergeRun), shared by every merge receipt generator and its parser
 * (dispatch-recovery-CIFLEN1). Generators fit their whole receipt, query prefix included, under it or produce none, so a legal
 * but long piece of evidence never reaches the gate as an over-long receipt that freezes the project. The gate is never widened.
 * tests/scheduler-merge-audit-receipt-ci.test.ts.
 */
import { LedgerError } from "./ledger-store.js";

export const RECEIPT_MAX = 600;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Whether `receipt` (already trimmed) passes the gate: non-empty, one line, at most RECEIPT_MAX UTF-16 units. */
const receiptFits = (receipt: string): boolean => !!receipt && receipt.length <= RECEIPT_MAX && !CONTROL.test(receipt);

/** The gate itself: the trimmed receipt, or the ledger's refusal. */
export function gateReceipt(raw: string | undefined): string {
  const receipt = raw?.trim() ?? "";
  if (!receiptFits(receipt)) throw new LedgerError("invalid", `回执要是单行且不超过 ${RECEIPT_MAX} 字`);
  return receipt;
}
