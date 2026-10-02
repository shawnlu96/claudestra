/** Optional deliver fields are peeled off before the original strict parser, leaving all other field checks unchanged. */
import { parseDisputes, type FindingDispute } from "./review-arbiter.js";
export type { FindingDispute };

export function deliverWithoutDisputes(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const { disputes: _disputes, ...legacy } = raw as Record<string, unknown>;
  return legacy;
}

export function deliverDisputeFields(raw: unknown, fail: (path: string, why: string) => never): { disputes?: FindingDispute[] } {
  const value = (raw as Record<string, unknown>).disputes;
  if (value === undefined) return {};
  try { return { disputes: parseDisputes(value) }; } catch (e) { return fail("disputes", (e as Error).message); }
}
