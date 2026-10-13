/** Add-only V1 extension (team-project-TEAMVIS1): the home instance uploads scrubbed body text of its cards so team
 * members can read it at the center, and members ask the home instance for session pages through the center.
 * Own endpoints and an own capability probe: ext-capabilities is a closed object, so a new key there would break old
 * clients. A center without the probe answers 404, which the home instance reads as "unsupported", never as a failure.
 * Text is scrubbed at home before it leaves; the contract only carries which scrub ran and how much it masked.
 */
import { createHash } from "node:crypto";
import {
  array, boolean, choice, digest, id, integer, invalid, literal, nonce, nullable, object, positive, record, text, unique, type Schema,
} from "./shared-ledger-contract-schema.js";

/** Relative to `/v1/teams/{teamId}/`. Uploads, claims and returns are signed with the home instance's service credentials. */
export const TEAM_BODY_PATHS = {
  capability: "/v1/teams/{teamId}/team-body/capability",
  upload: "/v1/teams/{teamId}/team-body/batches",
  read: "/v1/teams/{teamId}/team-body/features/{featureId}/tasks/{taskId}",
  pageRequest: "/v1/teams/{teamId}/team-body/session-pages",
  pageClaim: "/v1/teams/{teamId}/team-body/session-pages/claim",
  pageReturn: "/v1/teams/{teamId}/team-body/session-pages/{requestId}/result",
  pageRead: "/v1/teams/{teamId}/team-body/session-pages/{requestId}",
} as const;

export const TEAM_BODY_KINDS = ["event", "review", "spec", "session-page"] as const;
export type TeamBodyKind = (typeof TEAM_BODY_KINDS)[number];
/** UTF-8 bytes of one record's text. */
export const TEAM_BODY_TEXT_MAX_BYTES = 1024 * 1024;
export const TEAM_BODY_BATCH_MAX_RECORDS = 100;
/** Sum of text bytes in one upload batch, so a batch stays one bounded request body. */
export const TEAM_BODY_BATCH_MAX_BYTES = 4 * 1024 * 1024;
export const TEAM_BODY_PAGE_LIMIT_MAX = 200;
/**
 * Page requests reach the home instance by long poll, fixed here so both sides agree: one claim waits at most 8 s, and
 * an idle home instance claims no more often than once per 8 s. 8 s stays under Bun's default 10 s HTTP idleTimeout
 * and nginx's default 60 s proxy_read_timeout; a center that lowers either below this must lower it here first.
 */
export const TEAM_BODY_CLAIM_WAIT_MAX_MS = 8_000;
export const TEAM_BODY_CLAIM_IDLE_INTERVAL_MIN_MS = 8_000;

/** Status table both sides assert. `unsupported` is the old center's 404, whatever its body. */
export const TEAM_BODY_STATUS = {
  ok: 200, invalid: 400, not_member: 403, gate_refused: 403, unsupported: 404, not_open: 409, expired: 410, home_offline: 503,
} as const;
/**
 * home_offline: the home instance has not claimed recently, so a page cannot be fetched. not_member: the caller is not
 * in the team / project. gate_refused: the home instance's gate declined to send this text. not_open: the project's
 * teamBody switch is not on. expired: the page request passed its expiresAt.
 */
export const TEAM_BODY_ERROR_CODES = ["home_offline", "not_member", "gate_refused", "not_open", "expired"] as const;
type TeamBodyErrorCode = (typeof TEAM_BODY_ERROR_CODES)[number];
export interface TeamBodyError { schemaVersion: 1; code: TeamBodyErrorCode; status: number; message: string }

/**
 * sourceKey names the home-side source: the event seq for event / review, the specRev for spec (canonical decimal), and
 * the page's own cursor key for session-page. digest is sha256 of the UTF-8 text, so a record cannot carry other text.
 */
export interface TeamBodyRecord {
  featureId: string; taskId: string; kind: TeamBodyKind; sourceKey: string; text: string;
  scrubVersion: number; maskedSegments: number; digest: string;
}
export interface TeamBodyUpload { schemaVersion: 1; projectId: string; sourceInstanceId: string; batchId: string; records: TeamBodyRecord[] }
/** One result per uploaded record, same order. unchanged = same key and digest already stored (idempotent retry). */
interface TeamBodyUploadResult {
  taskId: string; kind: TeamBodyKind; sourceKey: string; status: "stored" | "unchanged" | "refused"; code: TeamBodyErrorCode | null;
}
export interface TeamBodyUploadReceipt { schemaVersion: 1; batchId: string; results: TeamBodyUploadResult[] }
/** syncedAt: when the home instance last uploaded for this task (Unix ms), null = never. homeOnline: it claimed recently. */
export interface TeamBodyRead {
  schemaVersion: 1; teamId: string; projectId: string; featureId: string; taskId: string;
  records: TeamBodyRecord[]; syncedAt: number | null; homeOnline: boolean;
}
interface TeamBodyCapability { schemaVersion: 1; teamId: string; teamBody: boolean }

/** cursor null = from the newest page; otherwise the nextCursor of an earlier page, opaque to the center. */
export interface TeamBodyPageRequest { schemaVersion: 1; projectId: string; featureId: string; taskId: string; cursor: string | null; limit: number }
export interface TeamBodyPageTicket { schemaVersion: 1; requestId: string; expiresAt: number }
export interface TeamBodyPageClaim { schemaVersion: 1; sourceInstanceId: string; waitMs: number }
type TeamBodyPendingPage = Omit<TeamBodyPageRequest, "schemaVersion"> & { requestId: string; expiresAt: number };
/** Empty `requests` is the normal answer of a claim that waited its whole waitMs. */
export interface TeamBodyPageClaimed { schemaVersion: 1; requests: TeamBodyPendingPage[] }
interface TeamBodyPage { records: TeamBodyRecord[]; nextCursor: string | null }
type TeamBodyPageResult = ({ kind: "page" } & TeamBodyPage) | { kind: "refused"; code: "gate_refused" | "not_open" };
export interface TeamBodyPageReturn { schemaVersion: 1; requestId: string; sourceInstanceId: string; result: TeamBodyPageResult }
/** pending: the home instance has not returned yet (result null); an expired request answers the `expired` error instead. */
export interface TeamBodyPageRead {
  schemaVersion: 1; requestId: string; status: "pending" | "ready"; expiresAt: number; homeOnline: boolean; result: TeamBodyPageResult | null;
}

export function teamBodyDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const bodyText: Schema<string> = (v) => {
  const s = text(TEAM_BODY_TEXT_MAX_BYTES)(v);
  return Buffer.byteLength(s, "utf8") <= TEAM_BODY_TEXT_MAX_BYTES ? s : invalid();
};
const seqKey: Schema<string> = (v) => typeof v === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(v) && Number.isSafeInteger(Number(v)) ? v : invalid();
const cursor = text(512, 1);
const limit: Schema<number> = (v) => positive(v) <= TEAM_BODY_PAGE_LIMIT_MAX ? v as number : invalid();
const errorCode = choice(TEAM_BODY_ERROR_CODES);
const recordShape = object({
  featureId: id, taskId: id, kind: choice(TEAM_BODY_KINDS), sourceKey: id, text: bodyText,
  scrubVersion: positive, maskedSegments: integer, digest,
});
const bodyRecord: Schema<TeamBodyRecord> = (value) => {
  const r = recordShape(value);
  if (r.kind !== "session-page") seqKey(r.sourceKey);
  if (teamBodyDigest(r.text) !== r.digest) invalid();
  return r;
};
const keyOf = (r: { taskId: string; kind: string; sourceKey: string }): string => JSON.stringify([r.taskId, r.kind, r.sourceKey]);
const textBytes = (rows: readonly TeamBodyRecord[]): number => rows.reduce((n, r) => n + Buffer.byteLength(r.text, "utf8"), 0);

const upload = object({
  schemaVersion: literal(1), projectId: id, sourceInstanceId: id, batchId: nonce, records: array(bodyRecord, TEAM_BODY_BATCH_MAX_RECORDS),
});
export function parseTeamBodyUpload(value: unknown): TeamBodyUpload {
  const parsed = upload(value);
  if (!parsed.records.length || textBytes(parsed.records) > TEAM_BODY_BATCH_MAX_BYTES) invalid();
  unique(parsed.records.map(keyOf));
  return parsed;
}

const uploadResult: Schema<TeamBodyUploadResult> = (value) => {
  const r = object({
    taskId: id, kind: choice(TEAM_BODY_KINDS), sourceKey: id, status: choice(["stored", "unchanged", "refused"]), code: nullable(errorCode),
  })(value);
  if ((r.status === "refused") !== (r.code !== null)) invalid();
  return r;
};
const receipt = object({ schemaVersion: literal(1), batchId: nonce, results: array(uploadResult, TEAM_BODY_BATCH_MAX_RECORDS) });
export function parseTeamBodyUploadReceipt(value: unknown): TeamBodyUploadReceipt {
  const parsed = receipt(value);
  unique(parsed.results.map(keyOf));
  return parsed;
}
/** The receipt answers exactly the batch that was sent: same batchId, one result per record in the same order. */
export function teamBodyReceiptMatches(sent: TeamBodyUpload, got: TeamBodyUploadReceipt): boolean {
  return sent.batchId === got.batchId && sent.records.length === got.results.length
    && sent.records.every((r, i) => keyOf(r) === keyOf(got.results[i]!));
}

const read = object({
  schemaVersion: literal(1), teamId: id, projectId: id, featureId: id, taskId: id,
  records: array(bodyRecord), syncedAt: nullable(integer), homeOnline: boolean,
});
export function parseTeamBodyRead(value: unknown): TeamBodyRead {
  const parsed = read(value);
  if (parsed.records.some((r) => r.featureId !== parsed.featureId || r.taskId !== parsed.taskId)) invalid();
  unique(parsed.records.map(keyOf));
  return parsed;
}

const capability: Schema<TeamBodyCapability> = object({ schemaVersion: literal(1), teamId: id, teamBody: boolean });
/** 404 = a center without the extension; a 200 that says teamBody false is unsupported too. Other statuses are not an answer. */
export function parseTeamBodyCapability(status: number, body: unknown): { supported: boolean } {
  if (status === TEAM_BODY_STATUS.unsupported) return { supported: false };
  if (status !== TEAM_BODY_STATUS.ok) return invalid();
  return { supported: capability(body).teamBody };
}

const pageTarget = { projectId: id, featureId: id, taskId: id, cursor: nullable(cursor), limit };
export const parseTeamBodyPageRequest: Schema<TeamBodyPageRequest> = object({ schemaVersion: literal(1), ...pageTarget });
export const parseTeamBodyPageTicket: Schema<TeamBodyPageTicket> = object({ schemaVersion: literal(1), requestId: id, expiresAt: positive });
const waitMs: Schema<number> = (v) => integer(v) <= TEAM_BODY_CLAIM_WAIT_MAX_MS ? v as number : invalid();
export const parseTeamBodyPageClaim: Schema<TeamBodyPageClaim> = object({ schemaVersion: literal(1), sourceInstanceId: id, waitMs });
const claimed = object({ schemaVersion: literal(1), requests: array(object({ requestId: id, expiresAt: positive, ...pageTarget })) });
export function parseTeamBodyPageClaimed(value: unknown): TeamBodyPageClaimed {
  const parsed = claimed(value);
  unique(parsed.requests.map((r) => r.requestId));
  return parsed;
}

const pageResults = {
  page: object({ kind: literal("page"), records: array(bodyRecord, TEAM_BODY_PAGE_LIMIT_MAX), nextCursor: nullable(cursor) }),
  refused: object({ kind: literal("refused"), code: choice(["gate_refused", "not_open"]) }),
};
const pageResult: Schema<TeamBodyPageResult> = (value) => {
  const parsed = pageResults[choice(["page", "refused"])(record(value).kind)](value);
  if (parsed.kind !== "page") return parsed;
  if (parsed.records.some((r) => r.kind !== "session-page") || textBytes(parsed.records) > TEAM_BODY_BATCH_MAX_BYTES) invalid();
  unique(parsed.records.map(keyOf));
  return parsed;
};
export const parseTeamBodyPageReturn: Schema<TeamBodyPageReturn> = object({
  schemaVersion: literal(1), requestId: id, sourceInstanceId: id, result: pageResult,
});
const pageRead = object({
  schemaVersion: literal(1), requestId: id, status: choice(["pending", "ready"]), expiresAt: positive, homeOnline: boolean,
  result: nullable(pageResult),
});
export function parseTeamBodyPageRead(value: unknown): TeamBodyPageRead {
  const parsed = pageRead(value);
  if ((parsed.status === "ready") !== (parsed.result !== null)) invalid();
  return parsed;
}

const error = object({ schemaVersion: literal(1), code: errorCode, status: integer, message: text(500) });
/** The body's code must be the one this HTTP status stands for, so a proxy's own 403 / 503 page never reads as ours. */
export function parseTeamBodyError(status: number, body: unknown): TeamBodyError {
  const e = error(body);
  if (e.status !== status || TEAM_BODY_STATUS[e.code] !== status) invalid();
  return e;
}
