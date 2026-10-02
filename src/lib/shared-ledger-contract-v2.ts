/** Frozen V2 execution contracts. Unix milliseconds, central ids, positive revisions/fences; no local authority fallback.
 * Domains export V2DomainModule and use caller-owned transactions. X12 owns identity, CAS, authorization and composition.
 * Snapshot/manifest parsers check structure; storage must atomically verify current rows, hashes, leases and all references.
 */
export * from "./shared-ledger-contract-v2-validation.js";
export * from "./shared-ledger-contract-v2-tasks.js";
export * from "./shared-ledger-contract-v2-asks.js";
export * from "./shared-ledger-contract-v2-scheduling.js";
export * from "./shared-ledger-contract-v2-lend.js";
export * from "./shared-ledger-contract-v2-dag.js";
export * from "./shared-ledger-contract-v2-commands.js";
export * from "./shared-ledger-contract-v2-transfer.js";
export * from "./shared-ledger-contract-v2-transaction.js";
export * from "./shared-ledger-contract-v2-integrity.js";
export const V2_SCHEMA_VERSION = 2 as const;
