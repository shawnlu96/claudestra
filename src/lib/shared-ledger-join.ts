/**
 * Shared-ledger enrollment, member side: a one-time join code is redeemed with the local instance key.
 * The center learns this instance's public key only through a signature over (center, code, key, instance).
 * Neither the join code nor the issued bearer is ever returned, logged or written outside the 0600 credential file.
 */
import { sharedLedgerJoinPinsMatch } from "./shared-ledger-gate-proxy-join-pins.js";
import { signPurpose, isPublicKey, type InstanceKey } from "./instance-key.js";
import { STATE_DIR } from "./paths.js";
import {
  parseSharedLedgerJoinCode, SHARED_LEDGER_JOIN_PATH, SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerInstanceId, sharedLedgerJoinFields,
  type SharedLedgerJoinGrant, type SharedLedgerJoinRequest,
} from "./shared-ledger-join-protocol.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import { readSharedLedgerBindings, setSharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential, writeSharedLedgerCredential, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";

/** The pure protocol lives in shared-ledger-join-protocol.ts; these names stay importable from here. */
export {
  formatSharedLedgerJoinCode, looksLikeSharedLedgerJoinCode, parseSharedLedgerJoinCode, SHARED_LEDGER_JOIN_PATH, SHARED_LEDGER_JOIN_PURPOSE,
  sharedLedgerInstanceId, sharedLedgerJoinFields, type SharedLedgerJoinCode, type SharedLedgerJoinGrant,
} from "./shared-ledger-join-protocol.js";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const BEARER_RE = /^[A-Za-z0-9_-]{43}$/;
type Action = SharedLedgerJoinGrant["projects"][number]["actions"][number];
const ACTIONS: readonly Action[] = ["read", "plan", "import", "project"];

export function signSharedLedgerJoin(code: string, instanceId: string, key: InstanceKey): SharedLedgerJoinRequest {
  const parsed = parseSharedLedgerJoinCode(code);
  if (!parsed || !ID_RE.test(instanceId)) throw new SharedLedgerJoinError("invalid join input");
  const signed = signPurpose(SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields(parsed.centerId, code.trim(), key.publicKey, instanceId), key);
  if (!signed) throw new SharedLedgerJoinError("instance key unavailable");
  return { code: code.trim(), publicKey: signed.key, instanceId, signature: signed.sig };
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
  url: string; code: string; key: InstanceKey; instanceId?: string;
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

/** Confirm the center accepts the bearer before replacing any local credential or binding. */
export async function joinSharedLedger(input: SharedLedgerJoinInput): Promise<SharedLedgerJoinResult> {
  const parsed = parseSharedLedgerJoinCode(input.code);
  if (!parsed) throw new SharedLedgerJoinError("invalid join code");
  if (!ID_RE.test(input.subject) || (input.localProjectId !== undefined && !ID_RE.test(input.localProjectId))) {
    throw new SharedLedgerJoinError("invalid local subject or project");
  }
  const baseUrl = centerBaseUrl(input.url);
  if (!isPublicKey(input.key.publicKey)) throw new SharedLedgerJoinError("instance key unavailable");
  const grant = await redeem(input, signSharedLedgerJoin(input.code, input.instanceId ?? sharedLedgerInstanceId(input.key.publicKey), input.key), parsed.centerId);
  const dir = input.stateDir ?? STATE_DIR;
  const kind = grant.role === "service" ? "service" : "person";
  const project = grant.projects[0]!;
  const credential: SharedLedgerLocalCredential = { localSubject: input.subject, kind, centerId: grant.centerId, baseUrl,
    teamId: grant.teamId, personId: grant.personId, instanceId: grant.instanceId, bearer: grant.bearer, projects: grant.projects };
  try {
    const features = await new SharedLedgerClient(credential, input.key, { fetch: input.fetch, timeoutMs: input.timeoutMs }).features();
    if (features.teamId !== grant.teamId) throw new Error("team mismatch");
  } catch {
    // Client errors may carry response detail. Retrying the same code revokes the bearer this attempt was issued.
    throw new SharedLedgerJoinError("code redeemed, but the center did not accept the new credential; nothing was saved — retry the same code before it expires");
  }
  const localProjectId = input.localProjectId ?? project.projectId;
  if (!sharedLedgerJoinPinsMatch(credential, localProjectId, project.projectId, dir)) {
    throw new SharedLedgerJoinError("center or project does not match the pinned center; nothing was saved");
  }
  await writeSharedLedgerCredential(credential, dir);
  await setSharedLedgerBinding({ centerId: grant.centerId, teamId: grant.teamId, projectId: project.projectId, localProjectId }, dir);
  const identities = readSharedLedgerBindings(dir).filter((b) =>
    resolveSharedLedgerCredential(input.subject, kind, b.centerId, b.teamId, b.projectId, "read", dir));
  if (!identities.some((b) => b.centerId === grant.centerId && b.projectId === project.projectId)) {
    throw new SharedLedgerJoinError("joined, but the local identity did not read back");
  }
  return { centerId: grant.centerId, teamId: grant.teamId, personId: grant.personId, projectId: project.projectId, localProjectId,
    kind, expiresAt: grant.expiresAt, identities: identities.length };
}
