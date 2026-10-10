import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import {
  SharedLedgerError, type SharedLedgerImport, type SharedLedgerImportManifest,
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
