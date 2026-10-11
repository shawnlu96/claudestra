/**
 * One budget for the V1 import mapping set: the request (one mapping per feature and per task it will create) and the
 * response (the full mapping list) are both measured here, so an import the contract accepts always has a readable receipt.
 */
import { SHARED_LEDGER_MAX_BODY_BYTES, type SharedLedgerImportManifest, type SharedLedgerImportResult } from "./shared-ledger-contract.js";
import { invalid, unique } from "./shared-ledger-contract-schema.js";

type Mapping = SharedLedgerImportResult["mappings"][number];

/** Features plus tasks of one import. The per-array caps (1000 features, 1000 tasks each) still apply underneath. */
export const SHARED_LEDGER_MAX_IMPORT_MAPPINGS = 4000;
/** Import responses stay within the default body cap; the reserve holds the result scalars and the receipt wrapper. */
const ENVELOPE_RESERVE_BYTES = 4096;
export const SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES = SHARED_LEDGER_MAX_BODY_BYTES - ENVELOPE_RESERVE_BYTES;
/** The center picks the mapped id after the request is accepted, so the request side reserves the longest valid id. */
const RESERVED_ID = "x".repeat(128);

/** Wire bytes of one mapping with its separator. Ids are ASCII by schema, so string length equals UTF-8 length. */
export function sharedLedgerImportMappingBytes(mapping: Mapping): number {
  const { kind, sourceInstanceId, sourceId, id } = mapping;
  return JSON.stringify({ kind, sourceInstanceId, sourceId, id }).length + 1;
}

function checkBudget(mappings: readonly Mapping[]): void {
  if (mappings.length > SHARED_LEDGER_MAX_IMPORT_MAPPINGS) invalid();
  let bytes = 0;
  for (const mapping of mappings) bytes += sharedLedgerImportMappingBytes(mapping);
  if (bytes > SHARED_LEDGER_MAX_IMPORT_MAPPING_BYTES) invalid();
}

/** The mappings a parsed manifest obliges the center to return, sized for the longest id it may assign. */
export function sharedLedgerImportManifestMappings(manifest: SharedLedgerImportManifest): Mapping[] {
  const sourceInstanceId = manifest.sourceInstanceId;
  // Counted before anything is allocated: the per-array caps alone admit a million tasks.
  if (manifest.features.reduce((n, f) => n + 1 + f.projection.tasks.length, 0) > SHARED_LEDGER_MAX_IMPORT_MAPPINGS) invalid();
  return manifest.features.flatMap((f): Mapping[] => [{ kind: "feature", sourceInstanceId, sourceId: f.sourceFeatureId, id: RESERVED_ID },
    ...f.projection.tasks.map((t): Mapping => ({ kind: "task", sourceInstanceId, sourceId: t.sourceTaskId, id: RESERVED_ID }))]);
}

/** Request side: refuse before submission any import whose complete receipt could not fit the shared budget. */
export function checkSharedLedgerImportManifestBudget(manifest: SharedLedgerImportManifest): void {
  checkBudget(sharedLedgerImportManifestMappings(manifest));
}

/** Response side: the whole list or nothing. A duplicate source or target would silently hide another mapping. */
export function checkSharedLedgerImportMappings(mappings: readonly Mapping[]): void {
  checkBudget(mappings);
  unique(mappings.map((m) => JSON.stringify([m.kind, m.sourceInstanceId, m.sourceId])));
  unique(mappings.map((m) => JSON.stringify([m.kind, m.id])));
}
