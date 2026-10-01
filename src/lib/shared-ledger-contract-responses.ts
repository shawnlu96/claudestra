import {
  SHARED_LEDGER_CAPABILITIES, SHARED_LEDGER_ERROR_STATUS, type SharedLedgerFeature, type SharedLedgerFeatureDetail,
  type SharedLedgerFeatureList, type SharedLedgerCommandResult, type SharedLedgerCommandReceipt, type SharedLedgerErrorResponse,
  type SharedLedgerImportResult, type SharedLedgerProjectionResult,
} from "./shared-ledger-contract.js";
import { array, choice, digest, id, integer, invalid, literal, nullable, object, positive, record, text, unique, type Schema } from "./shared-ledger-contract-schema.js";
import { dagSchema, validateDag } from "./shared-ledger-contract-validation.js";
import { taskProjectionSchema } from "./shared-ledger-contract-transfer.js";

const capabilities = object(Object.fromEntries(Object.entries(SHARED_LEDGER_CAPABILITIES).map(([key, value]) => [key,
  object(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, literal(v)]))),
]))) as Schema<typeof SHARED_LEDGER_CAPABILITIES>;
const meta = { schemaVersion: literal(1), teamId: id, serverSeq: integer, capabilities };
const featureSchema: Schema<SharedLedgerFeature> = object({
  id, projectId: id, title: text(300, 1), description: text(16000), rev: positive, version: integer,
  authorityMode: choice(["source", "planning"]), homeInstanceId: id, executorInstanceIds: array(id),
  status: choice(["planned", "active", "done", "blocked"]),
  counts: object({ total: integer, completed: integer, blocked: integer, missing: integer }), updatedBy: id, updatedAt: integer,
  projection: nullable(object({ sourceInstanceId: id, sourceSeq: integer, observedAt: integer, receivedAt: integer })),
});

function feature(value: unknown): SharedLedgerFeature {
  const f = featureSchema(value);
  if (f.counts.completed + f.counts.blocked + f.counts.missing > f.counts.total) invalid();
  if (f.projection && f.projection.sourceInstanceId !== f.homeInstanceId) invalid();
  unique(f.executorInstanceIds);
  return f;
}

function featureDetail(value: unknown): SharedLedgerFeatureDetail {
  const task = (v: unknown) => {
    const { taskId, ...projection } = record(v);
    return { ...taskProjectionSchema(projection), taskId: id(taskId) };
  };
  const parsed = object({ ...meta, feature, dag: dagSchema, tasks: array(task) })(value);
  validateDag(parsed.dag);
  if (parsed.feature.version !== parsed.dag.version || parsed.feature.counts.total !== parsed.dag.nodes.length) invalid();
  unique(parsed.tasks.map((t) => t.sourceTaskId));
  unique(parsed.tasks.map((t) => t.taskId));
  const source = parsed.feature.projection;
  if (parsed.tasks.length && !source) invalid();
  if (source && parsed.tasks.some((t) => t.sourceSeq > source.sourceSeq || t.steps.some((s) => s.sourceSeq > source.sourceSeq))) invalid();
  return parsed;
}

const commandResult: Schema<SharedLedgerCommandResult> = object({
  schemaVersion: literal(1), requestId: id, commandDigest: digest, serverSeq: integer, committedAt: integer,
  result: object({ featureId: id, rev: positive, version: integer }),
});
const importResult: Schema<SharedLedgerImportResult> = object({
  schemaVersion: literal(1), mode: choice(["dry-run", "commit"]), batchId: id, manifestDigest: digest, serverSeq: integer,
  mappings: array(object({ kind: choice(["feature", "task"]), sourceInstanceId: id, sourceId: id, id })),
});
const projectionResult: Schema<SharedLedgerProjectionResult> = object({
  schemaVersion: literal(1), serverSeq: integer, sourceInstanceId: id, sourceSeq: integer, digest,
});

function receipt(value: unknown): SharedLedgerCommandReceipt {
  if (record(value).status === "unknown") return object({ status: literal("unknown"), requestId: id })(value);
  return object({ status: literal("committed"), receipt: commandResult })(value);
}

function error(value: unknown): SharedLedgerErrorResponse {
  if (record(value).code === "conflict") {
    const e = object({ code: literal("conflict"), status: literal(409), currentRev: positive, currentVersion: integer,
      latest: featureDetail, modifiedBy: id, modifiedAt: integer })(value);
    const f = e.latest.feature;
    if (e.currentRev !== f.rev || e.currentVersion !== f.version || e.modifiedBy !== f.updatedBy || e.modifiedAt !== f.updatedAt) invalid();
    return e;
  }
  const codes = Object.keys(SHARED_LEDGER_ERROR_STATUS).filter((k) => k !== "conflict") as Exclude<SharedLedgerErrorResponse["code"], "conflict">[];
  const e = object({ code: choice(codes), status: integer, message: text(500) })(value);
  if (SHARED_LEDGER_ERROR_STATUS[e.code] !== e.status) invalid();
  return e;
}

function features(value: unknown): SharedLedgerFeatureList {
  const result = object({ ...meta, features: array(feature) })(value);
  unique(result.features.map((f) => f.id));
  return result;
}

const responses = { features, feature: featureDetail, command: commandResult, receipt, error, import: importResult, projection: projectionResult };
export function parseSharedLedgerResponse<K extends keyof typeof responses>(kind: K, value: unknown): ReturnType<typeof responses[K]> {
  return responses[kind](value) as ReturnType<typeof responses[K]>;
}
