/** Existing acceptance transports this binding; malformed reserved markers must never become ordinary orders. */
import { ORDER_ID, TASK_ID } from "./lend-wire-v2-schema.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";
/** v1 = PM reclaim (`reclaimSeq` is the reclaim note). conv = CONV2 formal end: `reclaimSeq` is the fix_strategy_reclaim event. */
export interface ReborrowBinding { orderId: string; gen: number; reclaimSeq: number; conv?: { from: LendFamily; to: LendFamily } }
const PREFIX = "[lend-reborrow";
const SHAPE = /^\[lend-reborrow:v1 old=(lend:[^\s\]]+) gen=(0|[1-9]\d*) reclaim=([1-9]\d*)\]$/;
const CONV = /^\[lend-reborrow:v2 src=conv old=(lend:[^\s\]]+) gen=(0|[1-9]\d*) end=([1-9]\d*) from=([a-z]+) to=([a-z]+)\]$/;
/** Only the two ids this repo issues for lend orders: ledger-lend `s/r/a` and remote convergence `cv:<eventSeq>`. */
const ISSUED = /^lend:([^:]+):(?:s\d+:r\d+:a\d+|cv:([1-9]\d*))$/;
const family = (f: string): f is LendFamily => (LEND_FAMILIES as readonly string[]).includes(f);

function issuedOrderId(id: string): boolean {
  const m = ORDER_ID.test(id) ? ISSUED.exec(id) : null;
  return !!m && TASK_ID.test(m[1]) && (m[2] === undefined || Number.isSafeInteger(Number(m[2])));
}

export function reborrowMarker(b: ReborrowBinding): string {
  const line = b.conv ? `[lend-reborrow:v2 src=conv old=${b.orderId} gen=${b.gen} end=${b.reclaimSeq} from=${b.conv.from} to=${b.conv.to}]`
    : `[lend-reborrow:v1 old=${b.orderId} gen=${b.gen} reclaim=${b.reclaimSeq}]`;
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
  const c = !m && candidates.length === 1 ? CONV.exec(candidates[0]) : null;
  const g = m ?? c;
  if (!g || !issuedOrderId(g[1]) || !Number.isSafeInteger(Number(g[2])) || !Number.isSafeInteger(Number(g[3])) ||
    (c && (!family(c[4]) || !family(c[5]) || c[4] === c[5]))) {
    throw new Error("续借标记错误、重复或缺字段");
  }
  return { orderId: g[1], gen: Number(g[2]), reclaimSeq: Number(g[3]), ...(c ? { conv: { from: c[4] as LendFamily, to: c[5] as LendFamily } } : {}) };
}
