import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  authenticateSharedLedgerRequest as auth, sharedLedgerCredentialHash, signSharedLedgerRequest,
  type SharedLedgerCredential, type SharedLedgerReplayIndex, type SharedLedgerSignedRequest,
} from "../src/lib/shared-ledger-auth.js";
import {
  SharedLedgerError, sharedLedgerBodyLimit, SHARED_LEDGER_MAX_BODY_BYTES, SHARED_LEDGER_MAX_IMPORT_BODY_BYTES,
} from "../src/lib/shared-ledger-contract.js";
import { SHARED_LEDGER_IMPORT_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.js";

const MIB = 1_048_576;
const NOW = 1_790_000_000_000;
const IMPORT_PATH = "/v1/teams/t/imports";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = { privateKey, publicKey: publicKey.export({ format: "jwk" }).x! };
const bearer = "synthetic-import-limit-test-credential";
const attemptNonce = "a".repeat(32);
const credential: SharedLedgerCredential = {
  credentialHash: sharedLedgerCredentialHash(bearer), teamId: "t", personId: "test-person", instanceId: "instance-a",
  publicKey: key.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: NOW + 60_000,
  projects: [{ projectId: "project-a", role: "owner", actions: ["import"] }],
};
const defaultRoutes = [
  ["POST", "/v1/teams/t/imports/batch"], ["GET", "/v1/teams/t/imports/batch"],
  ["POST", "/v1/teams/t/projections"], ["POST", "/v1/teams/t/commands"],
  ["POST", "/v1/feature-proposals"], ["POST", "/v1/join"],
  ["POST", "/v1/teams/t/imports?x=1"], ["POST", "/v1/teams/t/imports/"],
  ["POST", "/V1/teams/t/imports"], ["POST", "/v1/Teams/t/imports"], ["POST", "/v1/teams/t/Imports"],
  ["GET", IMPORT_PATH], ["PUT", IMPORT_PATH], ["post", IMPORT_PATH], ["Post", IMPORT_PATH],
  ["POST", "/v1/teams//imports"], ["POST", "/v1/teams/t%2Fa/imports"],
  ["POST", "/v1/teams/t/imports#fragment"],
] as const;

function replay(): SharedLedgerReplayIndex {
  const claimed = new Set<string>();
  return { claim(k) { if (claimed.has(k)) return false; claimed.add(k); return true; } };
}

function request(bytes: number, method = "POST", path = IMPORT_PATH, mode: "dry-run" | "commit" = "dry-run") {
  const json = JSON.stringify({ attemptNonce, payload: { ...SHARED_LEDGER_IMPORT_FIXTURE.payload, mode } });
  // JSON whitespace pads the wire body without changing the manifest or bypassing its schema/digest checks.
  const body = json + " ".repeat(bytes - Buffer.byteLength(json, "utf8"));
  return signSharedLedgerRequest({ method, path, body, bearer, instanceId: "instance-a",
    ts: String(NOW / 1000), attemptNonce }, key);
}

function refusal(req: SharedLedgerSignedRequest, code: SharedLedgerError["code"], index = replay()) {
  expect(() => auth(req, credential, index, NOW)).toThrow(expect.objectContaining({ code, status: 413 }));
}

describe("shared ledger import body limit", () => {
  test("limit constants and method/path table reserve 8 MiB for the exact POST collection", () => {
    expect(SHARED_LEDGER_MAX_BODY_BYTES).toBe(MIB);
    expect(SHARED_LEDGER_MAX_IMPORT_BODY_BYTES).toBe(8 * MIB);
    const paths = [...new Set([IMPORT_PATH, "/v1/teams/Team_1.:-/imports", ...defaultRoutes.map(([, path]) => path),
      "/v1/teams/t/imports\n", "/v1/teams/t/imports\r\n", "/v1/teams/秘密/imports"])];
    for (const path of paths) {
      for (const method of ["POST", "GET", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "post", "Post", "POST ", ""]) {
        const expected = method === "POST" && [IMPORT_PATH, "/v1/teams/Team_1.:-/imports"].includes(path) ? 8 * MIB : MIB;
        expect(sharedLedgerBodyLimit(method, path)).toBe(expected);
      }
    }
  });

  test("signed 2 MiB and exact 8 MiB imports authenticate in both modes", () => {
    for (const mode of ["dry-run", "commit"] as const) {
      for (const bytes of [2 * MIB, 8 * MIB]) {
        const req = request(bytes, "POST", IMPORT_PATH, mode);
        expect(Buffer.byteLength(req.body, "utf8")).toBe(bytes);
        expect(auth(req, credential, replay(), NOW).payload).toEqual({ ...SHARED_LEDGER_IMPORT_FIXTURE.payload, mode });
      }
    }
  });

  test("8 MiB + 1 byte import is rejected with 413", () => {
    refusal(request(8 * MIB + 1), "payload_too_large");
  });

  test.each(defaultRoutes)("%s %s retains the 1 MiB transport cap", (method, path) => {
    refusal(request(MIB + 1, method, path), "payload_too_large");
  });

  test("changing signed method or path fails before replay and the large-body exception", () => {
    const req = request(2 * MIB);
    for (const patch of [{ method: "GET" }, { path: "/v1/teams/other/imports" }, { path: "/v1/teams/t/commands" }]) {
      let claims = 0;
      expect(() => auth({ ...req, ...patch }, credential, { claim() { claims++; return true; } }, NOW))
        .toThrow(expect.objectContaining({ code: "bad_signature" }));
      expect(claims).toBe(0);
    }
  });

  test("freshness and replay still precede the enlarged byte cap", () => {
    const req = request(8 * MIB + 1);
    expect(() => auth(req, credential, replay(), NOW + 600_000)).toThrow(expect.objectContaining({ code: "expired" }));
    const index = replay();
    refusal(req, "payload_too_large", index);
    expect(() => auth(req, credential, index, NOW)).toThrow(expect.objectContaining({ code: "replayed" }));
  });

  test("UTF-8 byte count rejects an import whose character count is below 8 MiB", () => {
    const req = request(2 * MIB);
    const signed = signSharedLedgerRequest({ ...req, body: "中".repeat(Math.floor(8 * MIB / 3) + 1) }, key);
    expect(signed.body.length).toBeLessThan(8 * MIB);
    refusal(signed, "payload_too_large");
  });
});
