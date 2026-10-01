/** Pure verification/policy with an injected atomic replay claim. No credentials, files or DB are read here.
 * C2 supplies freshly loaded credentials on every request; never cache membership authorization.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./ask-bind.js";
import { MAX_SKEW_S, SIG_HEADERS, signPurpose, verifyPurpose, type InstanceKey } from "./instance-key.js";
import {
  SharedLedgerError, SHARED_LEDGER_MAX_BODY_BYTES, type SharedLedgerCommand,
  type SharedLedgerImport, type SharedLedgerProjection,
} from "./shared-ledger-contract.js";
import { id, nonce } from "./shared-ledger-contract-schema.js";
import { parseSharedLedgerCommand, parseSharedLedgerEnvelope } from "./shared-ledger-contract-validation.js";
import { parseSharedLedgerImport, parseSharedLedgerProjection } from "./shared-ledger-contract-transfer.js";

const PURPOSE = "claudestra-shared-ledger-v1";
export const SHARED_LEDGER_AUTH_HEADERS = {
  ...SIG_HEADERS, instance: "x-shared-ledger-instance", nonce: "x-shared-ledger-nonce",
} as const;
type Action = "read" | "plan" | "import" | "project";
type Role = "member" | "owner" | "service";

export interface SharedLedgerCredential {
  /** Only this hash is persisted centrally, never the Bearer secret. */
  credentialHash: string;
  teamId: string;
  personId: string;
  instanceId: string;
  publicKey: string;
  membershipStatus: "active" | "removed";
  revokedAt: number | null;
  expiresAt: number;
  /** Exact project ids, no wildcard or inherited local owner/PM/peer authority.
   * import is an explicit owner-issued grant, including for an owner credential.
   */
  projects: { projectId: string; role: Role; actions: Action[] }[];
}

export interface SharedLedgerReplayIndex {
  /** C2 implements atomic insert-if-absent, durable across restarts, before any business side effect.
   * false means already claimed; a storage failure must throw (never degrade to an in-memory cache).
   * Retain through expiresAt (exclusive), using the supplied server time to purge older claims.
   */
  claim(key: string, expiresAt: number, now: number): boolean;
}

export interface SharedLedgerSignedRequest {
  method: string;
  /** Raw pathname + query, without normalization; query is currently disallowed by the V1 route schema. */
  path: string;
  body: string;
  /** Raw secret from Authorization: Bearer (without the scheme prefix). */
  bearer: string;
  publicKey: string;
  instanceId: string;
  /** Integer Unix seconds, matching instance-key.ts; other timestamps in the contract use milliseconds. */
  ts: string;
  signature: string;
  attemptNonce: string;
}

export interface SharedLedgerPrincipal {
  teamId: string;
  personId: string;
  instanceId: string;
  /** GET /features must filter by these ids; zero accessible projects is forbidden. */
  projects: SharedLedgerCredential["projects"];
  /** Receipt lookup is restricted to these fields + requestId, then to projects above if it exists. */
  receiptScope: { teamId: string; personId: string; instanceId: string };
}
export interface SharedLedgerAuthResult {
  principal: SharedLedgerPrincipal;
  payload: SharedLedgerCommand | SharedLedgerImport | SharedLedgerProjection | null;
}

export const sharedLedgerCredentialHash = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function signedFields(req: Omit<SharedLedgerSignedRequest, "signature" | "publicKey">): string[] {
  return [req.method.toUpperCase(), req.path, req.ts, sharedLedgerCredentialHash(req.body),
    req.attemptNonce, req.instanceId, sharedLedgerCredentialHash(req.bearer)];
}

/** Explicit key/time/nonce inputs keep signing pure. C3 generates a fresh random 16–32 byte hex nonce.
 * A separate purpose prevents reuse of a peer/relay signature and permits signature-before-time checks.
 * Binding nonce, instance and credential hash also prevents transport credential substitution.
 */
export function signSharedLedgerRequest(
  request: Omit<SharedLedgerSignedRequest, "signature" | "publicKey">, key: InstanceKey,
): SharedLedgerSignedRequest {
  nonce(request.attemptNonce);
  const signed = signPurpose(PURPOSE, signedFields(request), key);
  if (!signed) throw new SharedLedgerError("bad_signature");
  return { ...request, publicKey: signed.key, signature: signed.sig };
}

export function sharedLedgerCommandDigest(envelope: unknown): string {
  const parsed = parseSharedLedgerEnvelope(envelope, parseSharedLedgerCommand);
  return createHash("sha256").update(canonicalJson(parsed.payload)).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
    && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function verifyTransport(req: SharedLedgerSignedRequest, replay: SharedLedgerReplayIndex, now: number): void {
  const fields = [req.method, req.path, req.body, req.bearer, req.publicKey, req.instanceId, req.ts, req.signature, req.attemptNonce];
  if (fields.some((v) => typeof v !== "string") || !verifyPurpose(req.publicKey, PURPOSE, signedFields(req), req.signature)) {
    throw new SharedLedgerError("bad_signature");
  }
  const ts = Number(req.ts);
  if (!/^\d{1,12}$/.test(req.ts) || !Number.isFinite(now) || Math.abs(now / 1000 - ts) > MAX_SKEW_S) throw new SharedLedgerError("expired");
  nonce(req.attemptNonce);
  // A future-dated signature can stay valid for twice the skew window; retain to signed time + skew.
  const expiresAt = (ts + MAX_SKEW_S) * 1000 + 1;
  const replayKey = sharedLedgerCredentialHash(canonicalJson([PURPOSE, req.publicKey, req.attemptNonce]));
  if (!replay || typeof replay.claim !== "function") throw new SharedLedgerError("forbidden");
  if (!replay.claim(replayKey, expiresAt, now)) throw new SharedLedgerError("replayed");
  if (Buffer.byteLength(req.body, "utf8") > SHARED_LEDGER_MAX_BODY_BYTES) throw new SharedLedgerError("payload_too_large");
}

function route(req: SharedLedgerSignedRequest): { teamId: string; action: Action; resource: string; item?: string } {
  const match = /^\/v1\/teams\/([A-Za-z0-9_.:-]+)\/(features|commands|imports|projections)(?:\/([A-Za-z0-9_.:-]+))?$/.exec(req.path);
  if (!match) throw new SharedLedgerError("forbidden");
  const [, teamId, resource, item] = match;
  id(teamId);
  if (item) id(item);
  const method = req.method.toUpperCase();
  if (method === "GET" && (resource === "features" || (resource === "commands" && item))) return { teamId, action: "read", resource, item };
  if (method === "POST" && !item && resource !== "features") {
    return { teamId, action: resource === "commands" ? "plan" : resource === "imports" ? "import" : "project", resource };
  }
  throw new SharedLedgerError("forbidden");
}

const allowedRoles: Record<Role, readonly Action[]> = {
  member: ["read", "plan"], owner: ["read", "plan", "import"], service: ["read", "plan", "import", "project"],
};

function parsePayload(req: SharedLedgerSignedRequest, action: Action): SharedLedgerAuthResult["payload"] {
  if (action === "read") {
    if (req.body !== "") throw new SharedLedgerError("invalid_field");
    return null;
  }
  let raw: unknown;
  try { raw = JSON.parse(req.body); }
  catch { throw new SharedLedgerError("invalid_field"); } // Malformed wire JSON is an expected input rejection, not a server failure.
  const parser = action === "plan" ? parseSharedLedgerCommand : action === "import" ? parseSharedLedgerImport : parseSharedLedgerProjection;
  const envelope = parseSharedLedgerEnvelope<NonNullable<SharedLedgerAuthResult["payload"]>>(raw, parser);
  if (envelope.attemptNonce !== req.attemptNonce) throw new SharedLedgerError("invalid_field");
  return envelope.payload;
}

/** Authentication order is fixed: signature → time → durable replay → byte limit → membership/binding/scope/role.
 * C2 must resolve read feature/existing receipt project and projection home from its DB, never request metadata.
 * An absent own receipt needs no project lookup; respond unknown without querying other identities.
 * C2 additionally checks command target project, import authorization and registered homes transactionally.
 */
export function authenticateSharedLedgerRequest(
  req: SharedLedgerSignedRequest, credential: SharedLedgerCredential | null, replay: SharedLedgerReplayIndex, now: number,
  target: { projectId?: string; homeInstanceId?: string } = {},
): SharedLedgerAuthResult {
  verifyTransport(req, replay, now);
  if (!credential || !sameHash(sharedLedgerCredentialHash(req.bearer), credential.credentialHash)
    || credential.membershipStatus !== "active" || credential.revokedAt !== null) throw new SharedLedgerError("not_member");
  if (!Number.isSafeInteger(credential.expiresAt) || now >= credential.expiresAt) throw new SharedLedgerError("expired");
  if (req.publicKey !== credential.publicKey || req.instanceId !== credential.instanceId) throw new SharedLedgerError("forbidden");
  const r = route(req);
  if (r.teamId !== credential.teamId) throw new SharedLedgerError("forbidden");
  const payload = parsePayload(req, r.action);
  const projectId = payload ? ("manifest" in payload ? payload.manifest.projectId : payload.projectId) : target.projectId;
  if ((payload && target.projectId && target.projectId !== projectId) || (r.item && r.resource === "features" && !projectId)) {
    throw new SharedLedgerError("forbidden");
  }
  const grants = credential.projects.filter((p) => p.projectId !== "*" && (!projectId || p.projectId === projectId)
    && p.actions.includes(r.action) && Object.hasOwn(allowedRoles, p.role) && allowedRoles[p.role].includes(r.action));
  if (!grants.length) throw new SharedLedgerError("forbidden");
  if (payload && "sourceInstanceId" in payload
    && (payload.sourceInstanceId !== credential.instanceId || target.homeInstanceId !== credential.instanceId)) throw new SharedLedgerError("forbidden");
  if (payload && "manifest" in payload && payload.manifest.sourceInstanceId !== credential.instanceId) throw new SharedLedgerError("forbidden");
  const receiptScope = { teamId: credential.teamId, personId: credential.personId, instanceId: credential.instanceId };
  return { principal: { ...receiptScope, projects: grants.map((p) => ({ ...p, actions: [...p.actions] })), receiptScope }, payload };
}
