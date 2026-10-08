/**
 * N8A3 batch selection: id order, ≤ AUTO_SHARE_BATCH_MAX features, no two sharing an exported task id (the import contract
 * refuses a duplicate taskId), the request body ≤ AUTO_SHARE_MAX_BATCH_BYTES (below the center's 1 MiB body limit), and a
 * feature marked `solo` (its last multi-feature batch failed) only ever alone. Skipped features wait for a later pass.
 */
import { canonicalJson } from "./ask-bind.js";
import type { SharedLedgerImport } from "./shared-ledger-contract.js";

const AUTO_SHARE_BATCH_MAX = 5;
export const AUTO_SHARE_MAX_BATCH_BYTES = 900_000;
const NONCE = "0".repeat(48); // the transport's attemptNonce: randomBytes(24) as hex, the same length on every attempt
const BATCH_ID_MAX = 128;

/** Bytes of the POST imports body the client sends (transport: canonicalJson({ attemptNonce, payload })), dry-run or commit. */
export function autoShareRequestBytes(payload: SharedLedgerImport): number {
  return Math.max(...(["dry-run", "commit"] as const).map((mode) =>
    Buffer.byteLength(canonicalJson({ attemptNonce: NONCE, payload: { ...payload, mode } }))));
}

/** Pre-check result one batch is planned from: the feature's exported task ids and its single-feature request body. */
export interface AutoSharePlanEntry { taskIds: string[]; bytes: number; envelope: number; solo: boolean }
export function autoSharePlanEntry(payload: SharedLedgerImport, taskIds: string[], solo: boolean): AutoSharePlanEntry {
  const envelope = autoShareRequestBytes({ ...payload, manifest: { ...payload.manifest, features: [] } });
  return { taskIds, bytes: autoShareRequestBytes(payload), envelope, solo };
}

/** A multi-feature body: the largest envelope (with room for the longest batch id) + each feature's own part + separators. */
function batchBytes(entries: AutoSharePlanEntry[]): number {
  const envelope = Math.max(...entries.map((e) => e.envelope)) + BATCH_ID_MAX;
  return entries.reduce((n, e) => n + e.bytes - e.envelope, envelope) + entries.length - 1;
}

export function selectAutoShareBatch(ready: readonly string[], plan: Readonly<Record<string, AutoSharePlanEntry>>): string[] {
  const picked: string[] = [], taken = new Set<string>();
  for (const id of ready) {
    if (picked.length >= AUTO_SHARE_BATCH_MAX) break;
    const entry = plan[id];
    if (!entry) continue;
    if (entry.solo) {
      if (!picked.length) return [id];
      continue;
    }
    if (entry.taskIds.some((t) => taken.has(t))) continue;
    if (picked.length && batchBytes([...picked.map((p) => plan[p]!), entry]) > AUTO_SHARE_MAX_BATCH_BYTES) continue;
    picked.push(id);
    for (const t of entry.taskIds) taken.add(t);
  }
  return picked;
}
