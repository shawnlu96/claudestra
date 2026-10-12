import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  SharedLedgerError, SHARED_LEDGER_MAX_BODY_BYTES, type SharedLedgerImport, type SharedLedgerImportManifest, type SharedLedgerImportResult,
  type SharedLedgerProjection, type SharedLedgerTaskProjection,
} from "./shared-ledger-contract.js";
import { array, boolean, choice, digest, id, integer, invalid, literal, nullable, object, positive, text, unique, type Schema } from "./shared-ledger-contract-schema.js";
import { nodeSchema, validateDag } from "./shared-ledger-contract-validation.js";

const head: Schema<string> = (v) => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v) ? v : invalid();
export const taskProjectionSchema: Schema<SharedLedgerTaskProjection> = object({
  sourceTaskId: id, sourceRev: integer, sourceSeq: integer, stage: text(80, 1), assigneeCode: nullable(id),
  executorInstanceId: nullable(id), pr: nullable(positive), head: nullable(head), deps: array(id), specSummary: text(16000),
  specDigest: nullable(digest), fullText: literal("home_only"),
  steps: array(object({ sourceStepId: id, sourceRev: integer, sourceSeq: integer, state: text(80, 1) })),
  asks: array(object({ kind: text(80, 1), state: text(80, 1), blocking: boolean })),
});
const projectionFields = {
  mode: choice(["snapshot", "delta"]), previousSourceSeq: integer, sourceSeq: integer, observedAt: integer,
  tasks: array(taskProjectionSchema),
  events: array(object({ sourceSeq: integer, sourceTaskId: id, type: text(80, 1), at: integer, summary: text(2000) })),
};
const projectionSchema: Schema<SharedLedgerProjection> = object({ projectId: id, featureId: id, sourceInstanceId: id, ...projectionFields });

function validateProjection(p: Pick<SharedLedgerProjection, keyof typeof projectionFields>): void {
  if (p.previousSourceSeq > p.sourceSeq || (p.mode === "delta" && p.previousSourceSeq === p.sourceSeq)) invalid();
  unique(p.tasks.map((t) => t.sourceTaskId));
  unique(p.events.map((e) => String(e.sourceSeq)));
  for (const task of p.tasks) {
    if (task.sourceSeq > p.sourceSeq) invalid();
    unique(task.deps);
    unique(task.steps.map((s) => s.sourceStepId));
    if (task.steps.some((s) => s.sourceSeq > p.sourceSeq)) invalid();
  }
  if (p.events.some((e) => e.sourceSeq > p.sourceSeq || (p.mode === "delta" && e.sourceSeq <= p.previousSourceSeq))) invalid();
}

export function parseSharedLedgerProjection(value: unknown): SharedLedgerProjection {
  const p = projectionSchema(value);
  validateProjection(p);
  return p;
}

export const importVersion = (v: unknown) => {
  const parsed = object({ version: integer, nodes: array(nodeSchema),
    bindings: array(object({ nodeKey: id, taskId: id })), reason: text(2000) })(v);
  validateDag(parsed);
  return parsed;
};
const manifestSchema: Schema<SharedLedgerImportManifest> = object({
  projectId: id, sourceInstanceId: id, sourceSeq: integer,
  features: array(object({ sourceFeatureId: id, title: text(300, 1), description: text(16000), rev: positive,
    authorityMode: choice(["source", "planning"]), pendingProposal: literal(false), versions: array(importVersion),
    projection: object(projectionFields),
  })),
});

/*
 * One budget for the V1 import mapping set: the request (one mapping per feature and per task it will create) and the
 * response (the full mapping list) are both measured here, so an import the contract accepts always has a readable receipt.
 */
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

/** Response side: the whole list or nothing. A duplicate source or target would silently hide another mapping. */
export function checkSharedLedgerImportMappings(mappings: readonly Mapping[]): void {
  checkBudget(mappings);
  unique(mappings.map((m) => JSON.stringify([m.kind, m.sourceInstanceId, m.sourceId])));
  unique(mappings.map((m) => JSON.stringify([m.kind, m.id])));
}

export function sharedLedgerManifestDigest(manifest: SharedLedgerImportManifest): string {
  return createHash("sha256").update(canonicalJson(manifestSchema(manifest))).digest("hex");
}

/** observedAt is transport observation time, not part of projection idempotency. */
export function sharedLedgerProjectionDigest(projection: SharedLedgerProjection): string {
  const { observedAt: _observation, ...business } = parseSharedLedgerProjection(projection);
  return createHash("sha256").update(canonicalJson(business)).digest("hex");
}

export function parseSharedLedgerImport(value: unknown): SharedLedgerImport {
  // Report the migration blocker explicitly instead of treating a pending proposal as approved data.
  const raw = value as Partial<SharedLedgerImport> | null;
  if (Array.isArray(raw?.manifest?.features) && raw.manifest.features.some((f) => (f as { pendingProposal?: unknown })?.pendingProposal === true)) {
    throw new SharedLedgerError("pending_proposal");
  }
  const parsed = object({ mode: choice(["dry-run", "commit"]), batchId: id, manifestDigest: digest, manifest: manifestSchema })(value);
  const m = parsed.manifest;
  // Every feature and task becomes one receipt mapping: refuse here what the receipt parser could not read back.
  checkBudget(sharedLedgerImportManifestMappings(m));
  unique(m.features.map((f) => f.sourceFeatureId));
  unique(m.features.map((f) => f.title));
  const taskIds: string[] = [];
  for (const f of m.features) {
    validateProjection(f.projection);
    if (f.projection.mode !== "snapshot" || f.projection.sourceSeq !== m.sourceSeq) invalid();
    for (const [index, dag] of f.versions.entries()) {
      if (dag.version !== index + 1) invalid();
      const tasks = new Set(f.projection.tasks.map((t) => t.sourceTaskId));
      if (dag.bindings.some((b) => !tasks.has(b.taskId))) invalid();
    }
    taskIds.push(...f.projection.tasks.map((t) => t.sourceTaskId));
  }
  unique(taskIds);
  const allTasks = new Set(taskIds);
  for (const f of m.features) {
    if (f.projection.tasks.some((t) => t.deps.some((dep) => !allTasks.has(dep)))) invalid();
    if (f.projection.events.some((e) => !allTasks.has(e.sourceTaskId))) invalid();
  }
  if (sharedLedgerManifestDigest(m) !== parsed.manifestDigest) invalid();
  return parsed;
}
