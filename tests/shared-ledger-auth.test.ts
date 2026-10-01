import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { MAX_SKEW_S, SIG_HEADERS, signedHeaders, signPurpose, type InstanceKey } from "../src/lib/instance-key.js";
import {
  authenticateSharedLedgerRequest as auth, sharedLedgerCommandDigest, sharedLedgerCredentialHash,
  signSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS,
  type SharedLedgerCredential, type SharedLedgerReplayIndex, type SharedLedgerSignedRequest, type SharedLedgerPrincipal,
} from "../src/lib/shared-ledger-auth.js";
import { SharedLedgerError, SHARED_LEDGER_MAX_BODY_BYTES } from "../src/lib/shared-ledger-contract.js";
import { SHARED_LEDGER_COMMAND_FIXTURES, SHARED_LEDGER_IMPORT_FIXTURE, SHARED_LEDGER_PROJECTION_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";

const NOW = 1_790_000_000_000;
const SECRET = "test-only-central-credential";
function makeKey(): InstanceKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: createPublicKey(privateKey).export({ format: "jwk" }).x! };
}
const key = makeKey();
const otherKey = makeKey();
const fixture = SHARED_LEDGER_COMMAND_FIXTURES[0];
function credential(change: Partial<SharedLedgerCredential> = {}): SharedLedgerCredential {
  return { credentialHash: sharedLedgerCredentialHash(SECRET), teamId: "team-a", personId: "person-a", instanceId: "instance-a",
    publicKey: key.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: NOW + 3600_000,
    projects: [{ projectId: "project-a", role: "member", actions: ["read", "plan"] }], ...change };
}
function replay(rows = new Map<string, number>()): SharedLedgerReplayIndex {
  return { claim(k, expiry, now) {
    if ((rows.get(k) ?? 0) > now) return false;
    rows.set(k, expiry);
    return true;
  } };
}
function request(change: Partial<SharedLedgerSignedRequest> = {}, signingKey = key): SharedLedgerSignedRequest {
  const attemptNonce = randomBytes(16).toString("hex");
  return signSharedLedgerRequest({ method: "POST", path: "/v1/teams/team-a/commands", bearer: SECRET, instanceId: "instance-a",
    ts: String(NOW / 1000), attemptNonce, body: JSON.stringify({ ...fixture, attemptNonce }), ...change }, signingKey);
}
function refusal(fn: () => unknown, code: SharedLedgerError["code"]) {
  try { fn(); throw new Error("unexpected authorization"); }
  catch (e) { expect(e).toBeInstanceOf(SharedLedgerError); expect((e as SharedLedgerError).code).toBe(code); }
}
function post(path: string, payload: unknown): SharedLedgerSignedRequest {
  const attemptNonce = randomBytes(16).toString("hex");
  return request({ path: `/v1/teams/team-a/${path}`, attemptNonce, body: JSON.stringify({ attemptNonce, payload }) });
}

describe("shared ledger transport", () => {
  test("valid member yields central identity, exact grants and own receipt scope", () => {
    const result = auth(request(), credential(), replay(), NOW);
    const principal: SharedLedgerPrincipal = result.principal;
    expect(principal.personId).toBe("person-a");
    expect(principal.projects[0].role).toBe("member");
    expect(principal.receiptScope).toEqual({ teamId: "team-a", personId: "person-a", instanceId: "instance-a" });
    expect(result.payload).toEqual(fixture.payload);
    expect(SHARED_LEDGER_AUTH_HEADERS.sig).toBe(SIG_HEADERS.sig);
    expect(SHARED_LEDGER_AUTH_HEADERS.nonce).toBe("x-shared-ledger-nonce");
  });
  test("signed method, path, body, timestamp, nonce, instance and bearer cannot be substituted", () => {
    const req = request();
    for (const patch of [{ method: "GET" }, { path: "/v1/teams/team-b/commands" }, { body: req.body + " " },
      { ts: "1" }, { attemptNonce: "f".repeat(32) }, { instanceId: "instance-b" }, { bearer: "stolen" },
      { signature: "" }, { publicKey: otherKey.publicKey }]) {
      refusal(() => auth({ ...req, ...patch }, credential(), replay(), NOW), "bad_signature");
    }
  });
  test("no unsigned legacy path, nor reuse of peer or other purpose signatures", () => {
    const req = request();
    const headers = signedHeaders(req.method, req.path, req.body, key, NOW);
    refusal(() => auth({ ...req, signature: headers[SIG_HEADERS.sig] }, credential(), replay(), NOW), "bad_signature");
    const invite = signPurpose("claudestra-invite-pop-v1", [req.path], key)!;
    refusal(() => auth({ ...req, signature: invite.sig }, credential(), replay(), NOW), "bad_signature");
    refusal(() => auth({ ...req, signature: req.signature + "=" }, credential(), replay(), NOW), "bad_signature");
  });
  test("signature precedes freshness, replay precedes size, size precedes membership", () => {
    const req = request({ ts: "1" });
    refusal(() => auth({ ...req, signature: "bad" }, null, replay(), NOW), "bad_signature");
    refusal(() => auth(req, null, replay(), NOW), "expired");
    const huge = request({ body: "中".repeat(Math.floor(SHARED_LEDGER_MAX_BODY_BYTES / 3) + 1) });
    const index = replay();
    refusal(() => auth(huge, null, index, NOW), "payload_too_large");
    refusal(() => auth(huge, null, index, NOW), "replayed");
  });
  test("past/future timestamp window and durable index across verifier recreation", () => {
    const rows = new Map<string, number>();
    const req = request({ ts: String(NOW / 1000 + MAX_SKEW_S) });
    auth(req, credential(), replay(rows), NOW);
    refusal(() => auth(req, credential(), replay(rows), NOW + MAX_SKEW_S * 2000), "replayed");
    expect([...rows.values()][0]).toBe(NOW + MAX_SKEW_S * 2000 + 1);
    for (const offset of [-MAX_SKEW_S - 1, MAX_SKEW_S + 1]) {
      refusal(() => auth(request({ ts: String(NOW / 1000 + offset) }), credential(), replay(), NOW), "expired");
    }
  });
  test("same nonce is rejected even after resigning with changed time; new nonce permits retry", () => {
    const req = request();
    const index = replay();
    auth(req, credential(), index, NOW);
    refusal(() => auth(request({ ...req, ts: String(NOW / 1000 + 1) }), credential(), index, NOW), "replayed");
    expect(auth(request(), credential(), index, NOW).payload).toEqual(fixture.payload);
  });
  test("missing or failed persistent replay storage cannot permit a write", () => {
    refusal(() => auth(request(), credential(), undefined as unknown as SharedLedgerReplayIndex, NOW), "forbidden");
    expect(() => auth(request(), credential(), { claim() { throw new Error("storage unavailable"); } }, NOW)).toThrow("storage unavailable");
  });
});

describe("membership, instance binding and role", () => {
  test("absent, revoked, removed, wrong secret and expired credentials fail closed", () => {
    for (const cred of [null, credential({ revokedAt: NOW }), credential({ membershipStatus: "removed" }),
      credential({ credentialHash: sharedLedgerCredentialHash("other") })]) {
      refusal(() => auth(request(), cred, replay(), NOW), "not_member");
    }
    refusal(() => auth(request(), credential({ expiresAt: NOW }), replay(), NOW), "expired");
    refusal(() => auth(request({}, otherKey), credential(), replay(), NOW), "forbidden");
    refusal(() => auth(request({ instanceId: "instance-b" }), credential(), replay(), NOW), "forbidden");
  });
  test("credential team and project scopes are exact; local owner:self grants nothing", () => {
    refusal(() => auth(request(), credential({ teamId: "team-b" }), replay(), NOW), "forbidden");
    for (const projectId of ["project-b", "*"]) {
      refusal(() => auth(request(), credential({ projects: [{ projectId, role: "owner", actions: ["plan"] }] }), replay(), NOW), "forbidden");
    }
    const local = credential({ personId: "owner:self" });
    expect(auth(request(), local, replay(), NOW).principal.projects[0].role).toBe("member");
    refusal(() => auth(post("imports", SHARED_LEDGER_IMPORT_FIXTURE.payload), local, replay(), NOW), "forbidden");
  });
  test("forged actor/role/owner never override credentials", () => {
    for (const field of ["actor", "role", "owner"]) {
      refusal(() => auth(post("commands", { ...fixture.payload, [field]: "owner" }), credential(), replay(), NOW), "invalid_field");
      const attemptNonce = "a".repeat(32);
      const req = request({ attemptNonce, body: JSON.stringify({ attemptNonce, payload: fixture.payload, [field]: "owner" }) });
      refusal(() => auth(req, credential(), replay(), NOW), "invalid_field");
    }
  });
  test("import needs an explicit import grant; projection needs service role and registered home", () => {
    const imported = () => post("imports", SHARED_LEDGER_IMPORT_FIXTURE.payload);
    const owner = credential({ projects: [{ projectId: "project-a", role: "owner", actions: ["read", "plan"] }] });
    refusal(() => auth(imported(), owner, replay(), NOW), "forbidden");
    owner.projects[0].actions.push("import");
    expect(auth(imported(), owner, replay(), NOW).payload).toEqual(SHARED_LEDGER_IMPORT_FIXTURE.payload);
    const projected = () => post("projections", SHARED_LEDGER_PROJECTION_FIXTURE.payload);
    const service = credential({ projects: [{ projectId: "project-a", role: "service", actions: ["project"] }] });
    refusal(() => auth(projected(), service, replay(), NOW), "forbidden");
    refusal(() => auth(projected(), service, replay(), NOW, { homeInstanceId: "instance-b" }), "forbidden");
    expect(auth(projected(), service, replay(), NOW, { homeInstanceId: "instance-a" }).payload).toEqual(SHARED_LEDGER_PROJECTION_FIXTURE.payload);
    service.projects[0].role = "member";
    refusal(() => auth(projected(), service, replay(), NOW, { homeInstanceId: "instance-a" }), "forbidden");
  });
  test("GET supports empty body, filtered list, resolved project for detail/receipts, and isolated routes", () => {
    const get = (path: string) => request({ method: "GET", body: "", path });
    expect(auth(get("/v1/teams/team-a/features"), credential(), replay(), NOW).principal.projects).toHaveLength(1);
    expect(auth(get("/v1/teams/team-a/commands/unknown"), credential(), replay(), NOW).principal.receiptScope.personId).toBe("person-a");
    for (const path of ["features/feature-a", "commands/request-new"]) {
      if (path.startsWith("features")) refusal(() => auth(get(`/v1/teams/team-a/${path}`), credential(), replay(), NOW), "forbidden");
      expect(auth(get(`/v1/teams/team-a/${path}`), credential(), replay(), NOW, { projectId: "project-a" }).payload).toBeNull();
      refusal(() => auth(get(`/v1/teams/team-a/${path}`), credential(), replay(), NOW, { projectId: "project-b" }), "forbidden");
    }
    for (const path of ["/api/v1/ledger/features", "/v1/teams/team-a/features?role=owner", "/v1/teams/team-a/imports"]) {
      refusal(() => auth(get(path), credential(), replay(), NOW), "forbidden");
    }
  });
});

describe("business idempotency", () => {
  test("same requestId/payload gives same digest across nonce, time, and object-key order", () => {
    const a = request();
    const b = request({ ts: String(NOW / 1000 + 2) });
    const digest = sharedLedgerCommandDigest(JSON.parse(a.body));
    expect(sharedLedgerCommandDigest(JSON.parse(b.body))).toBe(digest);
    const reordered = { attemptNonce: "f".repeat(32), payload: Object.fromEntries(Object.entries(fixture.payload).reverse()) };
    expect(sharedLedgerCommandDigest(reordered)).toBe(digest);
    expect(sharedLedgerCommandDigest({ ...fixture, payload: { ...fixture.payload, description: "changed" } })).not.toBe(digest);
    expect(sharedLedgerCommandDigest({ ...fixture, payload: { ...fixture.payload, requestId: "another" } })).not.toBe(digest);
  });
  test("wire nonce must be inside the signed POST body and match transport nonce", () => {
    refusal(() => auth(request({ attemptNonce: "e".repeat(32), body: JSON.stringify(fixture) }), credential(), replay(), NOW), "invalid_field");
  });
});
