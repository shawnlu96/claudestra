/** Add-only V1 extension (team-project-N8MK): a home instance uploads a newer DAG version of a source feature.
 * Separate endpoint, not a capability key: ext-capabilities `uploads` is a closed object, so a new key would break old
 * clients. A center without this endpoint answers 404, which the client records as "unsupported", never as a failure.
 * Projection, import manifest and ext-capabilities parsers are untouched.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { SharedLedgerDag } from "./shared-ledger-contract.js";
import { choice, digest, id, integer, invalid, literal, object, positive, record, text, type Schema } from "./shared-ledger-contract-schema.js";
import { importVersion } from "./shared-ledger-contract-transfer.js";

/** Relative to `/v1/teams/{teamId}/`; signed with service credentials (home instance, project action), like projections. */
export const SOURCE_DAG_UPLOAD_RESOURCE = "source-dags";
export const SOURCE_DAG_UPLOAD_PATH = "/v1/teams/{teamId}/source-dags";

/** Status table both sides assert. Same version + same content is idempotent 200; a skipped version (> current + 1) is 200 too. */
export const SOURCE_DAG_UPLOAD_STATUS = {
  ok: 200, invalid: 400, forbidden: 403, unsupported: 404, conflict: 409,
} as const;

/** `dag.bindings[].taskId` is the home sourceTaskId; the center maps it through id_map and drops (and counts) the rest. */
export interface SourceDagUpload {
  schemaVersion: 1; projectId: string; featureId: string; sourceInstanceId: string;
  dag: SharedLedgerDag & { reason: string };
}
interface SourceDagUploadResult { schemaVersion: 1; featureId: string; version: number; digest: string; droppedBindings: number }
/** forbidden: not the home instance / not a source feature / credential mismatch.
 * conflict: version ≤ current with different content; currentVersion is the center's latest. */
export type SourceDagUploadError =
  | { schemaVersion: 1; code: "conflict"; status: 409; message: string; currentVersion: number }
  | { schemaVersion: 1; code: "forbidden" | "invalid"; status: 403 | 400; message: string };
export type SourceDagUploadOutcome =
  | { kind: "ok"; result: SourceDagUploadResult }
  | { kind: "unsupported" }
  | { kind: "error"; error: SourceDagUploadError };

const upload: Schema<SourceDagUpload> = object({
  schemaVersion: literal(1), projectId: id, featureId: id, sourceInstanceId: id,
  dag: (v: unknown) => {
    const dag = importVersion(v);
    positive(dag.version);
    return dag;
  },
});

export function parseSourceDagUpload(value: unknown): SourceDagUpload {
  return upload(value);
}

/** Canonical JSON sha256 of the whole parsed upload, written like sharedLedgerProjectionDigest (no transport time to strip). */
export function sourceDagUploadDigest(value: SourceDagUpload): string {
  return createHash("sha256").update(canonicalJson(parseSourceDagUpload(value))).digest("hex");
}

const result: Schema<SourceDagUploadResult> = object({
  schemaVersion: literal(1), featureId: id, version: positive, digest, droppedBindings: integer,
});
const errorCodes = ["conflict", "forbidden", "invalid"] as const;
function error(value: unknown): SourceDagUploadError {
  const code = choice(errorCodes)(record(value).code);
  const e = code === "conflict"
    ? object({ schemaVersion: literal(1), code: literal("conflict"), status: literal(409), message: text(500), currentVersion: positive })(value)
    : object({ schemaVersion: literal(1), code: literal(code), status: integer, message: text(500) })(value);
  if (SOURCE_DAG_UPLOAD_STATUS[e.code] !== e.status) invalid();
  return e as SourceDagUploadError;
}

/** 404 is "center does not support this endpoint" whatever the body; any other status must match its body exactly. */
export function parseSourceDagUploadResponse(status: number, body: unknown): SourceDagUploadOutcome {
  if (status === SOURCE_DAG_UPLOAD_STATUS.unsupported) return { kind: "unsupported" };
  if (status === SOURCE_DAG_UPLOAD_STATUS.ok) return { kind: "ok", result: result(body) };
  const e = error(body);
  if (e.status !== status) invalid();
  return { kind: "error", error: e };
}
