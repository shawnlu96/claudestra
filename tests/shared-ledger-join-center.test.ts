import { test, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { signSharedLedgerJoin } from "../src/lib/shared-ledger-join.ts";
import { sharedLedgerJoinFields, SHARED_LEDGER_JOIN_PURPOSE } from "../src/lib/shared-ledger-join-protocol.ts";
import { verifyPurpose } from "../src/lib/instance-signature.ts";

// Center enrollment/storage/rate-limit assertions moved to the private counterpart; this tests the public proof consumer.
test("member proof binds the center, complete join code, public key and instance", () => {
  const pair = generateKeyPairSync("ed25519");
  const key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
  const centerId = `center-${"a".repeat(32)}`, code = `sljoin1.${centerId}.${"b".repeat(32)}.${"C".repeat(43)}`;
  const proof = signSharedLedgerJoin(code, "instance-a", key);
  expect(proof).toMatchObject({ code, publicKey: key.publicKey, instanceId: "instance-a" });
  expect(verifyPurpose(key.publicKey, SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields(centerId, code, key.publicKey, "instance-a"), proof.signature)).toBe(true);
  expect(verifyPurpose(key.publicKey, SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields(centerId, code, key.publicKey, "instance-b"), proof.signature)).toBe(false);
});
