/** Existing acceptance transports this binding; malformed reserved markers must never become ordinary orders. */
import { ORDER_ID, TASK_ID } from "./lend-wire-v2-schema.js";
export interface ReborrowBinding { orderId: string; gen: number; reclaimSeq: number }
const PREFIX = "[lend-reborrow";
const SHAPE = /^\[lend-reborrow:v1 old=(lend:[^\s\]]+) gen=(0|[1-9]\d*) reclaim=([1-9]\d*)\]$/;
/** Only the two ids this repo issues for lend orders: ledger-lend `s/r/a` and remote convergence `cv:<eventSeq>`. */
const ISSUED = /^lend:([^:]+):(?:s\d+:r\d+:a\d+|cv:([1-9]\d*))$/;

function issuedOrderId(id: string): boolean {
  const m = ORDER_ID.test(id) ? ISSUED.exec(id) : null;
  return !!m && TASK_ID.test(m[1]) && (m[2] === undefined || Number.isSafeInteger(Number(m[2])));
}

export function reborrowMarker(b: ReborrowBinding): string {
  const line = `[lend-reborrow:v1 old=${b.orderId} gen=${b.gen} reclaim=${b.reclaimSeq}]`;
  readReborrowBinding([line]);
  return line;
}

export function readReborrowBinding(acceptance: readonly string[]): ReborrowBinding | null {
  const candidates = acceptance.filter((s) => {
    const lower = s.toLowerCase();
    return lower.includes(PREFIX) || lower.includes("lend-reborrow:");
  });
  if (!candidates.length) return null;
  const m = candidates.length === 1 ? SHAPE.exec(candidates[0]) : null;
  if (!m || !issuedOrderId(m[1]) || !Number.isSafeInteger(Number(m[2])) || !Number.isSafeInteger(Number(m[3]))) {
    throw new Error("续借标记错误、重复或缺字段");
  }
  return { orderId: m[1], gen: Number(m[2]), reclaimSeq: Number(m[3]) };
}
