import type { LedgerOverview } from "@/features/collab/collab-model";
import { ApiError } from "@/lib/api/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Check the wire/cache boundary before a partial response can become render state. */
export function isLedgerOverview(value: unknown): value is LedgerOverview {
  return isRecord(value) && isRecord(value.meta)
    && Array.isArray(value.tasks) && Array.isArray(value.items) && Array.isArray(value.deps);
}

export function assertLedgerOverview(value: unknown): asserts value is LedgerOverview {
  if (!isLedgerOverview(value)) {
    throw new ApiError("Invalid ledger overview — please retry", 200, { retryable: true }, "invalid_ledger_overview");
  }
}

/** Render fallback for missing metadata; invalid overviews still fail at the boundary. */
export function metaOf(ov: unknown): LedgerOverview["meta"] & { team: unknown } {
  const meta = isRecord(ov) && isRecord(ov.meta) ? ov.meta : {};
  const queue = isRecord(meta.queueFrozen) ? meta.queueFrozen : {};
  return {
    pms: Array.isArray(meta.pms) ? meta.pms.filter((pm): pm is string => typeof pm === "string") : [],
    team: meta.team ?? null,
    docsDir: typeof meta.docsDir === "string" ? meta.docsDir : null,
    queueFrozen: {
      frozen: queue.frozen === true,
      reason: typeof queue.reason === "string" ? queue.reason : "",
      since: typeof queue.since === "number" ? queue.since : null,
    },
  };
}
