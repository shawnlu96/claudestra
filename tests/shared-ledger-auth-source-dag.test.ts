import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import type { InstanceKey } from "../src/lib/instance-key.js";
import {
  authenticateSharedLedgerRequest as auth, sharedLedgerCredentialHash, signSharedLedgerRequest,
  type SharedLedgerCredential, type SharedLedgerReplayIndex, type SharedLedgerSignedRequest,
} from "../src/lib/shared-ledger-auth.js";
import { SharedLedgerError } from "../src/lib/shared-ledger-contract.js";
import { SHARED_LEDGER_PROJECTION_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";
import { SOURCE_DAG_UPLOAD_RESOURCE } from "../src/lib/shared-ledger-contract-source-dag.js";
import { SOURCE_DAG_UPLOAD_FIXTURE } from "../src/lib/shared-ledger-contract-source-dag-fixtures.js";

const NOW = 1_790_000_000_000;
const SECRET = "test-only-central-credential";
const HOME = "instance-home";
const { privateKey } = generateKeyPairSync("ed25519");
const key: InstanceKey = { privateKey, publicKey: createPublicKey(privateKey).export({ format: "jwk" }).x! };
const upload = SOURCE_DAG_UPLOAD_FIXTURE;
const path = `/v1/teams/team-a/${SOURCE_DAG_UPLOAD_RESOURCE}`;

function credential(role: "member" | "owner" | "service" = "service", instanceId = HOME): SharedLedgerCredential {
  const actions = role === "service" ? ["project" as const] : ["read" as const, "plan" as const, "import" as const];
  return { credentialHash: sharedLedgerCredentialHash(SECRET), teamId: "team-a", personId: "person-a", instanceId,
    publicKey: key.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: NOW + 3600_000,
    projects: [{ projectId: "project-a", role, actions: role === "owner" ? [...actions, "project"] : actions }] };
}
function replay(): SharedLedgerReplayIndex {
  const rows = new Map<string, number>();
  return { claim(k, expiry, now) {
    if ((rows.get(k) ?? 0) > now) return false;
    rows.set(k, expiry);
    return true;
  } };
}
function request(payload: unknown, change: Partial<SharedLedgerSignedRequest> = {}, bodyNonce?: string): SharedLedgerSignedRequest {
  const attemptNonce = randomBytes(16).toString("hex");
  return signSharedLedgerRequest({ method: "POST", path, bearer: SECRET, instanceId: HOME, ts: String(NOW / 1000), attemptNonce,
    body: JSON.stringify({ attemptNonce: bodyNonce ?? attemptNonce, payload }), ...change }, key);
}
function refusal(fn: () => unknown, code: SharedLedgerError["code"]) {
  try { fn(); throw new Error("unexpected authorization"); }
  catch (e) { expect(e).toBeInstanceOf(SharedLedgerError); expect((e as SharedLedgerError).code).toBe(code); }
}
const home = { homeInstanceId: HOME };

describe("shared ledger auth: source-dags upload (N8MA)", () => {
  test("service credential on the home instance passes and yields the parsed upload", () => {
    const result = auth(request(upload), credential(), replay(), NOW, home);
    expect(result.payload).toEqual(upload);
    expect(result.principal.projects).toEqual([{ projectId: "project-a", role: "service", actions: ["project"] }]);
    expect(result.principal.instanceId).toBe(HOME);
  });
  test("member / owner credentials have no project action and are forbidden", () => {
    refusal(() => auth(request(upload), credential("member"), replay(), NOW, home), "forbidden");
    refusal(() => auth(request(upload), credential("owner"), replay(), NOW, home), "forbidden");
  });
  test("home binding: payload sourceInstanceId and target.homeInstanceId must equal the credential instance", () => {
    refusal(() => auth(request({ ...upload, sourceInstanceId: "instance-other" }), credential(), replay(), NOW, home), "forbidden");
    refusal(() => auth(request(upload), credential(), replay(), NOW), "forbidden");
    refusal(() => auth(request(upload), credential(), replay(), NOW, { homeInstanceId: "instance-other" }), "forbidden");
    refusal(() => auth(request(upload), credential(), replay(), NOW, { ...home, projectId: "project-b" }), "forbidden");
  });
  test("GET and item routes are forbidden", () => {
    refusal(() => auth(request(upload, { method: "GET", body: "" }), credential(), replay(), NOW, home), "forbidden");
    refusal(() => auth(request(upload, { path: `${path}/feature-global-a` }), credential(), replay(), NOW, home), "forbidden");
    refusal(() => auth(request(upload, { method: "GET", body: "", path: `${path}/feature-global-a` }), credential(), replay(), NOW, home), "forbidden");
  });
  test("projection-shaped, incomplete or extra payloads are invalid_field", () => {
    refusal(() => auth(request(SHARED_LEDGER_PROJECTION_FIXTURE.payload), credential(), replay(), NOW, home), "invalid_field");
    for (const field of Object.keys(upload)) {
      const { [field]: _drop, ...rest } = upload as unknown as Record<string, unknown>;
      refusal(() => auth(request(rest), credential(), replay(), NOW, home), "invalid_field");
    }
    refusal(() => auth(request({ ...upload, extra: 1 }), credential(), replay(), NOW, home), "invalid_field");
    refusal(() => auth(request(upload, { body: "{" }), credential(), replay(), NOW, home), "invalid_field");
  });
  test("envelope attemptNonce must match the signed transport nonce", () => {
    refusal(() => auth(request(upload, {}, "f".repeat(32)), credential(), replay(), NOW, home), "invalid_field");
  });
  test("transport gates are unchanged: signature, replay", () => {
    const req = request(upload);
    refusal(() => auth({ ...req, body: req.body + " " }, credential(), replay(), NOW, home), "bad_signature");
    const index = replay();
    auth(req, credential(), index, NOW, home);
    refusal(() => auth(req, credential(), index, NOW, home), "replayed");
  });
});
