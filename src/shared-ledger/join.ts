/**
 * Shared-ledger enrollment, center side. Join codes are minted offline (scripts/shared-ledger-admin.ts) and
 * redeemed once over HTTP with proof of the member's instance key. Only hashes of codes and bearers are stored.
 * Every redeem failure is the same 403 join_rejected; only rate limiting answers differently (429).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isPublicKey, verifyPurpose } from "../lib/instance-key.js";
import { sharedLedgerCredentialHash, type SharedLedgerCredential } from "../lib/shared-ledger-auth.js";
import {
  SHARED_LEDGER_JOIN_PATH, SHARED_LEDGER_JOIN_PURPOSE, formatSharedLedgerJoinCode, parseSharedLedgerJoinCode,
  sharedLedgerJoinFields, type SharedLedgerJoinGrant,
} from "../lib/shared-ledger-join.js";
import { registerCredential } from "./identity.js";
import { Store, decode, encode } from "./store.js";

export { SHARED_LEDGER_JOIN_PATH };
type Role = "member" | "service";
type Action = SharedLedgerJoinGrant["projects"][number]["actions"][number];
/** Same ceilings as C1 allowedRoles; enrollment never mints owner, wildcard, merge/release/grant/remote authority. */
const ROLE_ACTIONS: Record<Role, readonly Action[]> = { member: ["read", "plan"], service: ["read", "plan", "import", "project"] };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_CODE_TTL_MS = 30 * 86_400_000;
const MAX_CREDENTIAL_TTL_MS = 365 * 86_400_000;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

export interface JoinInvite {
  teamId: string; projectId: string; personId: string; memberCode: string; role: Role; actions: string[];
  ttlMs: number; credentialTtlMs?: number;
}
export function centerId(store: Store): string {
  return store.get<{ id: string }>("SELECT id FROM center_identity")!.id;
}
/** Throws on any grant outside the enrollment policy; checked at mint time and again at redeem time. */
export function checkJoinGrant(role: string, projectId: string, actions: readonly string[]): asserts role is Role {
  if (!Object.hasOwn(ROLE_ACTIONS, role)) throw new Error("join role must be member or service");
  if (projectId === "*" || !ID_RE.test(projectId)) throw new Error("join project must be one exact project id");
  const allowed = ROLE_ACTIONS[role as Role] as readonly string[];
  if (!actions.length || new Set(actions).size !== actions.length || actions.some((a) => !allowed.includes(a))) {
    throw new Error(`join actions for ${role} must be a subset of ${allowed.join(",")}`);
  }
  if (!actions.includes("read")) throw new Error("join actions must include read");
}
export function parseDuration(raw: string): number {
  const m = /^(\d{1,6})([mhd])$/.exec(raw);
  if (!m) throw new Error("duration must look like 30m, 24h or 7d");
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

/** The returned code is the only copy of the secret; the store keeps its sha256. */
export function createJoinCode(store: Store, invite: JoinInvite, now = Date.now()): { id: string; code: string; expiresAt: number } {
  for (const v of [invite.teamId, invite.personId, invite.memberCode]) if (!ID_RE.test(v)) throw new Error("invalid team, person or member code");
  checkJoinGrant(invite.role, invite.projectId, invite.actions);
  const credentialTtl = invite.credentialTtlMs ?? 90 * 86_400_000;
  if (!(invite.ttlMs > 0 && invite.ttlMs <= MAX_CODE_TTL_MS)) throw new Error("join code ttl must be within 30d");
  if (!(credentialTtl > 0 && credentialTtl <= MAX_CREDENTIAL_TTL_MS)) throw new Error("credential ttl must be within 365d");
  const id = randomBytes(16).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = now + invite.ttlMs;
  store.write(() => store.run("INSERT INTO join_codes VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)", id, sha(secret), invite.teamId,
    invite.projectId, invite.personId, invite.memberCode, invite.role, encode(invite.actions), now, expiresAt, credentialTtl));
  return { id, code: formatSharedLedgerJoinCode({ centerId: centerId(store), codeId: id, secret }), expiresAt };
}
interface JoinRow {
  id: string; secretHash: string; teamId: string; projectId: string; personId: string; memberCode: string; role: string;
  actions: string; createdAt: number; expiresAt: number; credentialTtlMs: number; usedAt: number | null;
  revokedAt: number | null; instanceId: string | null;
}
export function listJoinCodes(store: Store, now = Date.now()) {
  return store.all<JoinRow>("SELECT * FROM join_codes ORDER BY createdAt").map(({ secretHash: _hash, actions, ...r }) => ({
    ...r, actions: decode<string[]>(actions),
    status: r.revokedAt !== null ? "revoked" : r.usedAt !== null ? "used" : r.expiresAt <= now ? "expired" : "pending" }));
}
/** Revoking a used code changes nothing: the issued credential is managed separately. */
export function revokeJoinCode(store: Store, id: string, now = Date.now()): boolean {
  return store.write(() => store.db.query("UPDATE join_codes SET revokedAt=? WHERE id=? AND usedAt IS NULL AND revokedAt IS NULL")
    .run(now, id).changes === 1);
}

class Rejected extends Error {}
const reject = (): never => { throw new Rejected(); };
function parseRequest(body: string): { code: string; publicKey: string; instanceId: string; signature: string } {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(body); }
  catch { return reject(); } // Malformed input is rejected like any other failed join.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) reject();
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "code,instanceId,publicKey,signature" || Object.values(raw).some((v) => typeof v !== "string")) reject();
  return raw as { code: string; publicKey: string; instanceId: string; signature: string };
}

/** Atomic: lookup, proof check, credential registration and single-use mark share one immediate transaction. */
function redeemJoinCode(store: Store, body: string, now = Date.now()): SharedLedgerJoinGrant {
  const req = parseRequest(body);
  const parsed = parseSharedLedgerJoinCode(req.code);
  if (!parsed || !isPublicKey(req.publicKey) || !ID_RE.test(req.instanceId)) return reject();
  return store.write(() => {
    const center = centerId(store);
    const row = store.get<JoinRow>("SELECT * FROM join_codes WHERE id=?", parsed.codeId);
    const given = Buffer.from(sha(parsed.secret), "hex");
    if (!row || parsed.centerId !== center || !timingSafeEqual(given, Buffer.from(row.secretHash, "hex"))) return reject();
    if (row.usedAt !== null || row.revokedAt !== null || now >= row.expiresAt) return reject();
    if (!verifyPurpose(req.publicKey, SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields(center, req.code, req.publicKey, req.instanceId),
      req.signature)) return reject();
    const actions = decode<Action[]>(row.actions);
    try { checkJoinGrant(row.role, row.projectId, actions); }
    catch { return reject(); } // A tampered stored grant must never be issued.
    // An instance id may not be re-bound to another person or another key through enrollment.
    const bound = store.all<{ personId: string; publicKey: string }>(
      "SELECT personId, publicKey FROM instance_bindings WHERE teamId=? AND instanceId=?", row.teamId, req.instanceId);
    if (bound.some((b) => b.personId !== row.personId || b.publicKey !== req.publicKey)) return reject();
    const bearer = randomBytes(32).toString("base64url");
    const expiresAt = now + row.credentialTtlMs;
    const projects: SharedLedgerCredential["projects"] = [{ projectId: row.projectId, role: row.role as Role, actions }];
    registerCredential(store, { credentialHash: sharedLedgerCredentialHash(bearer), teamId: row.teamId, personId: row.personId,
      instanceId: req.instanceId, publicKey: req.publicKey, membershipStatus: "active", revokedAt: null, expiresAt, projects }, row.memberCode);
    if (store.db.query("UPDATE join_codes SET usedAt=?, instanceId=? WHERE id=? AND usedAt IS NULL").run(now, req.instanceId, row.id).changes !== 1) {
      return reject();
    }
    return { centerId: center, teamId: row.teamId, personId: row.personId, instanceId: req.instanceId, bearer, expiresAt,
      role: row.role as Role, projects: [{ projectId: row.projectId, actions: [...actions] }] };
  });
}

interface Window { at: number; count: number }
export interface JoinLimits { perSourcePerMinute: number; perCodePer10Minutes: number }
/** Limits count every attempt, keyed by source address and by the claimed code id (existing or not). */
export function joinHandler(store: Store, limits: JoinLimits = { perSourcePerMinute: 10, perCodePer10Minutes: 5 }) {
  const sources = new Map<string, Window>();
  const codes = new Map<string, Window>();
  const hit = (map: Map<string, Window>, key: string, windowMs: number, max: number, now: number): boolean => {
    for (const [k, v] of map) if (now - v.at >= windowMs) map.delete(k);
    if (!map.has(key) && map.size >= 4096) return false;
    const w = map.get(key) ?? { at: now, count: 0 };
    w.count++;
    map.set(key, w);
    return w.count <= max;
  };
  const rejected = () => Response.json({ code: "join_rejected", message: "Join rejected" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  return (method: string, body: string, remote: string, now: number): Response => {
    let codeKey = "malformed";
    try { codeKey = String(JSON.parse(body)?.code ?? "").split(".")[2] ?? "malformed"; }
    catch { codeKey = "malformed"; } // Unparseable bodies share one bucket and are rejected below.
    if (!hit(sources, remote, 60_000, limits.perSourcePerMinute, now) || !hit(codes, codeKey.slice(0, 64), 600_000, limits.perCodePer10Minutes, now)) {
      return Response.json({ code: "rate_limited", message: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
    }
    if (method !== "POST") return rejected();
    try {
      return Response.json(redeemJoinCode(store, body, now), { status: 200, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (!(error instanceof Rejected)) console.error("Shared ledger join failed in storage");
      return rejected();
    }
  };
}
