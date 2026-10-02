/**
 * Shared-ledger enrollment, member side: a one-time join code is redeemed with the local instance key.
 * The center learns this instance's public key only through a signature over (center, code, key, instance).
 * Neither the join code nor the issued bearer is ever returned, logged or written outside the 0600 credential file.
 */
import { createHash } from "node:crypto";
import { signPurpose, isPublicKey, type InstanceKey } from "./instance-key.js";
import { STATE_DIR } from "./paths.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import { readSharedLedgerBindings, setSharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential, writeSharedLedgerCredential, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";

export const SHARED_LEDGER_JOIN_PATH = "/v1/join";
/** Join proofs reuse the shared-ledger purpose; the JOIN tag and field count keep them disjoint from request signatures. */
export const SHARED_LEDGER_JOIN_PURPOSE = "claudestra-shared-ledger-v1";
const CODE_RE = /^sljoin1\.(center-[a-f0-9]{32})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BEARER_RE = /^[A-Za-z0-9_-]{43}$/;
type Action = SharedLedgerLocalCredential["projects"][number]["actions"][number];
const ACTIONS: readonly Action[] = ["read", "plan", "import", "project"];

export interface SharedLedgerJoinCode { centerId: string; codeId: string; secret: string }
export const formatSharedLedgerJoinCode = (c: SharedLedgerJoinCode): string => `sljoin1.${c.centerId}.${c.codeId}.${c.secret}`;
export function parseSharedLedgerJoinCode(code: unknown): SharedLedgerJoinCode | null {
  const m = typeof code === "string" ? CODE_RE.exec(code.trim()) : null;
  return m ? { centerId: m[1]!, codeId: m[2]!, secret: m[3]! } : null;
}
/** True for anything shaped like a join code: callers use it to refuse codes passed through argv. */
export const looksLikeSharedLedgerJoinCode = (v: string): boolean => /sljoin1\./.test(v);

export function sharedLedgerJoinFields(centerId: string, code: string, publicKey: string, instanceId: string): string[] {
  return ["JOIN", SHARED_LEDGER_JOIN_PATH, centerId, createHash("sha256").update(code).digest("hex"), publicKey, instanceId];
}
interface SharedLedgerJoinRequest { code: string; publicKey: string; instanceId: string; signature: string }
export function signSharedLedgerJoin(code: string, instanceId: string, key: InstanceKey): SharedLedgerJoinRequest {
  const parsed = parseSharedLedgerJoinCode(code);
  if (!parsed || !ID_RE.test(instanceId)) throw new SharedLedgerJoinError("invalid join input");
  const signed = signPurpose(SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields(parsed.centerId, code.trim(), key.publicKey, instanceId), key);
  if (!signed) throw new SharedLedgerJoinError("instance key unavailable");
  return { code: code.trim(), publicKey: signed.key, instanceId, signature: signed.sig };
}

export interface SharedLedgerJoinGrant {
  centerId: string; teamId: string; personId: string; instanceId: string; bearer: string; expiresAt: number;
  role: "member" | "service"; projects: { projectId: string; actions: Action[] }[];
}
function parseGrant(v: unknown, centerId: string, instanceId: string): SharedLedgerJoinGrant {
  const g = v as SharedLedgerJoinGrant;
  const ok = !!g && typeof g === "object" && g.centerId === centerId && g.instanceId === instanceId
    && [g.teamId, g.personId].every((s) => typeof s === "string" && ID_RE.test(s)) && typeof g.bearer === "string" && BEARER_RE.test(g.bearer)
    && Number.isSafeInteger(g.expiresAt) && ["member", "service"].includes(g.role) && Array.isArray(g.projects) && g.projects.length > 0
    && g.projects.every((p) => p && typeof p.projectId === "string" && ID_RE.test(p.projectId) && Array.isArray(p.actions)
      && p.actions.length > 0 && p.actions.every((a) => ACTIONS.includes(a)));
  if (!ok) throw new Error("center returned an invalid join grant");
  return { ...g, projects: g.projects.map((p) => ({ projectId: p.projectId, actions: [...p.actions] })) };
}

function centerBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new SharedLedgerJoinError("invalid center URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new SharedLedgerJoinError("center requires HTTPS");
  }
  return url.toString();
}

export interface SharedLedgerJoinInput {
  url: string; code: string; key: InstanceKey; instanceId: string;
  /** Local principal the credential is resolved for (owner:self by default for people). */
  subject: string; localProjectId?: string; stateDir?: string; fetch?: typeof fetch; timeoutMs?: number;
}
export interface SharedLedgerJoinResult {
  centerId: string; teamId: string; personId: string; projectId: string; localProjectId: string;
  kind: "person" | "service"; expiresAt: number; identities: number;
}

/** Thrown with fixed messages only: neither the code nor any response text is ever included. */
export class SharedLedgerJoinError extends Error {}

async function redeem(input: SharedLedgerJoinInput, req: SharedLedgerJoinRequest, centerId: string): Promise<SharedLedgerJoinGrant> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(new URL(SHARED_LEDGER_JOIN_PATH, centerBaseUrl(input.url)), {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  } catch {
    throw new SharedLedgerJoinError("center unreachable"); // Transport text may echo the URL or body; keep the error fixed.
  } finally { clearTimeout(timer); }
  if (response.status === 429) throw new SharedLedgerJoinError("join rate limited; retry later");
  if (!response.ok) throw new SharedLedgerJoinError("join rejected");
  try { return parseGrant(await response.json(), centerId, req.instanceId); }
  catch { throw new SharedLedgerJoinError("center returned an invalid join grant"); } // Never surface a body that may hold a bearer.
}

/** Redeem → 0600 credential → binding → read identities back once and confirm the center accepts the new bearer. */
export async function joinSharedLedger(input: SharedLedgerJoinInput): Promise<SharedLedgerJoinResult> {
  const parsed = parseSharedLedgerJoinCode(input.code);
  if (!parsed) throw new SharedLedgerJoinError("invalid join code");
  if (!ID_RE.test(input.subject) || (input.localProjectId !== undefined && !ID_RE.test(input.localProjectId))) {
    throw new SharedLedgerJoinError("invalid local subject or project");
  }
  const baseUrl = centerBaseUrl(input.url);
  if (!isPublicKey(input.key.publicKey)) throw new SharedLedgerJoinError("instance key unavailable");
  const grant = await redeem(input, signSharedLedgerJoin(input.code, input.instanceId, input.key), parsed.centerId);
  const dir = input.stateDir ?? STATE_DIR;
  const kind = grant.role === "service" ? "service" : "person";
  const project = grant.projects[0]!;
  const credential: SharedLedgerLocalCredential = { localSubject: input.subject, kind, centerId: grant.centerId, baseUrl,
    teamId: grant.teamId, personId: grant.personId, instanceId: grant.instanceId, bearer: grant.bearer, projects: grant.projects };
  await writeSharedLedgerCredential(credential, dir);
  const localProjectId = input.localProjectId ?? project.projectId;
  await setSharedLedgerBinding({ centerId: grant.centerId, teamId: grant.teamId, projectId: project.projectId, localProjectId }, dir);
  const identities = readSharedLedgerBindings(dir).filter((b) =>
    resolveSharedLedgerCredential(input.subject, kind, b.centerId, b.teamId, b.projectId, "read", dir));
  if (!identities.some((b) => b.centerId === grant.centerId && b.projectId === project.projectId)) {
    throw new SharedLedgerJoinError("joined, but the local identity did not read back");
  }
  try {
    const features = await new SharedLedgerClient(credential, input.key, { fetch: input.fetch, timeoutMs: input.timeoutMs }).features();
    if (features.teamId !== grant.teamId) throw new Error("team mismatch");
  } catch {
    throw new SharedLedgerJoinError("joined, but the center did not accept the new credential"); // Client errors may carry response detail.
  }
  return { centerId: grant.centerId, teamId: grant.teamId, personId: grant.personId, projectId: project.projectId, localProjectId,
    kind, expiresAt: grant.expiresAt, identities: identities.length };
}
