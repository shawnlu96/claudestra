/** Existing acceptance transports this binding; malformed reserved markers must never become ordinary orders. */
export interface ReborrowBinding { orderId: string; gen: number; reclaimSeq: number }
const PREFIX = "[lend-reborrow";
const SHAPE = /^\[lend-reborrow:v1 old=(lend:[\w.-]+:s\d+:r\d+:a\d+) gen=(0|[1-9]\d*) reclaim=([1-9]\d*)\]$/;

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
  if (!m || !Number.isSafeInteger(Number(m[2])) || !Number.isSafeInteger(Number(m[3]))) throw new Error("续借标记错误、重复或缺字段");
  return { orderId: m[1], gen: Number(m[2]), reclaimSeq: Number(m[3]) };
}
