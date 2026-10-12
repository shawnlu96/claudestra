/** rename-floka-SIGN1: dual signature families (src/lib/floka-compat/signature). Every case signs with real synthetic Ed25519 keys; nothing fakes verification. */
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { signedHeaders, verifyPurpose, verifySigned, type InstanceKey } from "../src/lib/instance-signature.js";
import { checkInviteProof, signInviteProof } from "../src/lib/invite-proof.js";
import { issueReviewTicket, REVIEW_TICKET_PURPOSE } from "../src/lib/pool-review-proof-ticket.js";
import { signSharedLedgerRequest } from "../src/lib/shared-ledger-auth.js";
import {
  familyTag, parseRenameSignatureMode, PURPOSE_MAP, purposeFamily, REQUEST_HEADERS, REQUEST_SIGNATURE, type SignatureUse,
} from "../src/lib/floka-compat/signature/families.js";
import { signRequestFamily, verifyRequestFamilies } from "../src/lib/floka-compat/signature/request.js";
import { signPurposeFamily, verifyPurposeFamilies, type PurposeEnvelope } from "../src/lib/floka-compat/signature/purpose.js";
import {
  CAPABILITY_MAX_TTL_MS, capabilityValid, chooseSendFamily, issueSignatureCapability,
} from "../src/lib/floka-compat/signature/capability.js";

function synthKey(): InstanceKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}

const A = synthKey();
const B = synthKey();
const NOW = 1_800_000_000_000;
const REQ = { method: "post", path: "/api/v1/agents/x/messages?a=1", body: '{"hi":1}' };
const USES = Object.keys(PURPOSE_MAP) as SignatureUse[];
const FIELDS = ["n0nce", "join-code", "abcd-ef01", "iid-1", "https://h.example"];

describe("families: mode and explicit purpose mapping", () => {
  test("rename.signature defaults to off; only observe / on are recognised", () => {
    expect(parseRenameSignatureMode(undefined)).toBe("off");
    expect(parseRenameSignatureMode({})).toBe("off");
    expect(parseRenameSignatureMode({ rename: { signature: "ON" } })).toBe("off");
    expect(parseRenameSignatureMode({ rename: { signature: true } })).toBe("off");
    expect(parseRenameSignatureMode({ rename: { signature: "observe" } })).toBe("observe");
    expect(parseRenameSignatureMode({ rename: { signature: "on" } })).toBe("on");
  });

  test("every use maps both names explicitly and nothing else resolves", () => {
    expect(PURPOSE_MAP).toEqual({
      "invite-pop": { claudestra: "claudestra-invite-pop-v1", floka: "floka-invite-pop-v1" },
      "shared-ledger": { claudestra: "claudestra-shared-ledger-v1", floka: "floka-shared-ledger-v1" },
      "lend-receipt": { claudestra: "claudestra-lend-receipt-v1", floka: "floka-lend-receipt-v1" },
      "lend-review-ticket": { claudestra: "claudestra-lend-review-ticket-v1", floka: "floka-lend-review-ticket-v1" },
    });
    expect(REQUEST_SIGNATURE).toEqual({ claudestra: "claudestra-req-v1", floka: "floka-req-v1" });
    for (const u of USES) {
      expect(purposeFamily(PURPOSE_MAP[u].claudestra)).toEqual({ family: "claudestra", use: u });
      expect(purposeFamily(PURPOSE_MAP[u].floka)).toEqual({ family: "floka", use: u });
    }
    for (const n of ["floka-req-v1", "claudestra-req-v1", "floka-relay-auth-v2", "floka-invite-pop-v2", "FLOKA-INVITE-POP-V1", ""]) {
      expect(purposeFamily(n)).toBeNull();
    }
  });
});

describe("[验收线 1] request signatures: four directions with real keys", () => {
  test("new→new (on), new→old-compatible receive, old→new, old→old; new sender to old peer sends the old family", () => {
    const neu = signRequestFamily("floka", REQ, A, NOW);
    const old = signRequestFamily("claudestra", REQ, A, NOW);
    expect(Object.keys(neu).sort()).toEqual(Object.values(REQUEST_HEADERS.floka).sort());
    expect(old).toEqual(signedHeaders(REQ.method, REQ.path, REQ.body, A, NOW));
    // new receiver (on) accepts both families
    expect(verifyRequestFamilies(neu, REQ, "on", NOW)).toEqual({ status: "ok", family: "floka", publicKey: A.publicKey });
    expect(verifyRequestFamilies(old, REQ, "on", NOW)).toEqual({ status: "ok", family: "claudestra", publicKey: A.publicKey });
    // old receiver (= off, and the unchanged verifySigned on old headers) keeps accepting old senders
    expect(verifyRequestFamilies(old, REQ, "off", NOW)).toMatchObject({ status: "ok", family: "claudestra" });
    const h = REQUEST_HEADERS.claudestra;
    expect(verifySigned(old[h.key]!, { ...REQ, ts: old[h.ts]!, sig: old[h.sig]! }, NOW)).toBe("ok");
    // new sender facing an old peer (no capability) picks old → the old receiver verifies it unchanged
    const fam = chooseSendFamily({ allowNew: true, capability: undefined, pinned: { instanceId: "iid-b", publicKey: B.publicKey } }, NOW);
    expect(fam).toBe("claudestra");
    const sent = signRequestFamily(fam, REQ, A, NOW);
    expect(verifySigned(sent[h.key]!, { ...REQ, ts: sent[h.ts]!, sig: sent[h.sig]! }, NOW)).toBe("ok");
  });

  test("no key → no headers (unsigned stays visibly unsigned)", () => {
    expect(signRequestFamily("floka", REQ, null, NOW)).toEqual({});
    expect(verifyRequestFamilies({}, REQ, "on", NOW)).toEqual({ status: "unsigned" });
  });
});

describe("[验收线 1] purpose signatures: four directions per use", () => {
  for (const use of USES) {
    test(`${use}: new→new, old→new, old→old; new family off by default`, () => {
      const neu = signPurposeFamily("floka", use, FIELDS, A)!;
      const old = signPurposeFamily("claudestra", use, FIELDS, A)!;
      expect(neu.purpose).toBe(PURPOSE_MAP[use].floka);
      expect(old.purpose).toBe(PURPOSE_MAP[use].claudestra);
      expect(verifyPurposeFamilies([neu], use, FIELDS, "on")).toEqual({ status: "ok", family: "floka", publicKey: A.publicKey });
      expect(verifyPurposeFamilies([old], use, FIELDS, "on")).toEqual({ status: "ok", family: "claudestra", publicKey: A.publicKey });
      expect(verifyPurposeFamilies([old], use, FIELDS, "off")).toMatchObject({ status: "ok", family: "claudestra" });
      // the old signature bytes are exactly what the existing verifier checks
      expect(verifyPurpose(A.publicKey, PURPOSE_MAP[use].claudestra, FIELDS, old.sig)).toBe(true);
      // and the new one is not an old signature over the same fields
      expect(verifyPurpose(A.publicKey, PURPOSE_MAP[use].claudestra, FIELDS, neu.sig)).toBe(false);
      expect(verifyPurposeFamilies([neu], use, FIELDS, "off")).toEqual({ status: "reject", reason: "family_off" });
    });
  }

  test("dual envelope (same key, both valid) passes in on and verifies old only in off", () => {
    const pair = [signPurposeFamily("claudestra", "lend-receipt", FIELDS, A)!, signPurposeFamily("floka", "lend-receipt", FIELDS, A)!];
    expect(verifyPurposeFamilies(pair, "lend-receipt", FIELDS, "on")).toMatchObject({ status: "ok", family: "claudestra" });
    expect(verifyPurposeFamilies(pair, "lend-receipt", FIELDS, "off")).toMatchObject({ status: "ok", family: "claudestra" });
    expect(verifyPurposeFamilies(pair, "lend-receipt", FIELDS, "observe")).toMatchObject({ status: "ok", family: "claudestra", observed: true });
  });
});

describe("[验收线 2] request: conflict, mix, partial, tamper — all rejected, no fallback", () => {
  const old = signRequestFamily("claudestra", REQ, A, NOW);
  const neu = signRequestFamily("floka", REQ, A, NOW);
  const o = REQUEST_HEADERS.claudestra;
  const n = REQUEST_HEADERS.floka;

  test("both families present with different values → conflict, even if each would verify alone", () => {
    expect(verifyRequestFamilies({ ...old, ...neu }, REQ, "on", NOW)).toEqual({ status: "reject", reason: "conflict" });
    const other = signRequestFamily("claudestra", REQ, B, NOW);
    expect(verifyRequestFamilies({ ...other, ...neu }, REQ, "on", NOW)).toEqual({ status: "reject", reason: "conflict" });
  });

  test("same values in both header sets normalise to one old-family check (once, no retry as new)", () => {
    const same = { ...old, [n.key]: old[o.key]!, [n.ts]: old[o.ts]!, [n.sig]: old[o.sig]! };
    expect(verifyRequestFamilies(same, REQ, "on", NOW)).toMatchObject({ status: "ok", family: "claudestra" });
    // a new-family signature copied into both sets is not old-family → rejected, never re-tried as floka
    const copied = { ...neu, [o.key]: neu[n.key]!, [o.ts]: neu[n.ts]!, [o.sig]: neu[n.sig]! };
    expect(verifyRequestFamilies(copied, REQ, "on", NOW)).toEqual({ status: "reject", reason: "bad", family: "claudestra" });
  });

  test("half sets and cross-family mixes are rejected as partial, not unsigned", () => {
    expect(verifyRequestFamilies({ [o.key]: old[o.key]!, [o.ts]: old[o.ts]! }, REQ, "on", NOW)).toEqual({ status: "reject", reason: "partial" });
    expect(verifyRequestFamilies({ [n.sig]: neu[n.sig]! }, REQ, "on", NOW)).toEqual({ status: "reject", reason: "partial" });
    const mixed = { [o.key]: neu[n.key]!, [n.ts]: neu[n.ts]!, [n.sig]: neu[n.sig]! };
    expect(verifyRequestFamilies(mixed, REQ, "on", NOW)).toEqual({ status: "reject", reason: "partial" });
    expect(verifyRequestFamilies({ ...old, [n.sig]: old[o.sig]! }, REQ, "on", NOW)).toEqual({ status: "reject", reason: "partial" });
  });

  test("headers differing only in case with different values are a conflict", () => {
    const h = { ...old, [o.sig.toUpperCase()]: neu[n.sig]! };
    expect(verifyRequestFamilies(h, REQ, "on", NOW)).toEqual({ status: "reject", reason: "conflict" });
    expect(verifyRequestFamilies({ ...old, [o.sig.toUpperCase()]: old[o.sig]! }, REQ, "on", NOW)).toMatchObject({ status: "ok" });
  });

  test("tampered path / body / method / ts and stale signatures fail in the declared family only", () => {
    for (const r of [{ ...REQ, path: "/api/v1/agents/y/messages?a=1" }, { ...REQ, body: '{"hi":2}' }, { ...REQ, method: "PUT" }]) {
      expect(verifyRequestFamilies(neu, r, "on", NOW)).toEqual({ status: "reject", reason: "bad", family: "floka" });
      expect(verifyRequestFamilies(old, r, "on", NOW)).toEqual({ status: "reject", reason: "bad", family: "claudestra" });
    }
    expect(verifyRequestFamilies({ ...neu, [n.ts]: String(Number(neu[n.ts]) + 1) }, REQ, "on", NOW)).toMatchObject({ status: "reject", reason: "bad" });
    expect(verifyRequestFamilies(neu, REQ, "on", NOW + 301_000)).toMatchObject({ status: "reject", reason: "stale" });
  });

  test("a family's signature moved under the other family's headers fails (no cross-family acceptance)", () => {
    const asOld = { [o.key]: neu[n.key]!, [o.ts]: neu[n.ts]!, [o.sig]: neu[n.sig]! };
    const asNew = { [n.key]: old[o.key]!, [n.ts]: old[o.ts]!, [n.sig]: old[o.sig]! };
    expect(verifyRequestFamilies(asOld, REQ, "on", NOW)).toEqual({ status: "reject", reason: "bad", family: "claudestra" });
    expect(verifyRequestFamilies(asNew, REQ, "on", NOW)).toEqual({ status: "reject", reason: "bad", family: "floka" });
    // and with the unchanged old verifier directly
    expect(verifySigned(neu[n.key]!, { ...REQ, ts: neu[n.ts]!, sig: neu[n.sig]! }, NOW)).toBe("bad");
  });
});

describe("[验收线 2] purpose: mix, wrong use, conflict, tamper", () => {
  const neu = signPurposeFamily("floka", "invite-pop", FIELDS, A)!;
  const old = signPurposeFamily("claudestra", "invite-pop", FIELDS, A)!;

  test("purpose name must belong to the declared family and the expected use", () => {
    const mix1: PurposeEnvelope = { ...neu, purpose: PURPOSE_MAP["invite-pop"].claudestra };
    const mix2: PurposeEnvelope = { ...old, purpose: PURPOSE_MAP["invite-pop"].floka };
    expect(verifyPurposeFamilies([mix1], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "mixed_family" });
    expect(verifyPurposeFamilies([mix2], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "mixed_family" });
    expect(verifyPurposeFamilies([neu], "lend-receipt", FIELDS, "on")).toEqual({ status: "reject", reason: "wrong_use" });
    expect(verifyPurposeFamilies([{ ...neu, purpose: "floka-req-v1" }], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "unknown_purpose" });
  });

  test("a signature for one use does not verify for another even when relabelled consistently", () => {
    for (const fam of ["claudestra", "floka"] as const) {
      const s = signPurposeFamily(fam, "invite-pop", FIELDS, A)!;
      const relabelled = { ...s, purpose: PURPOSE_MAP["lend-receipt"][fam] };
      expect(verifyPurposeFamilies([relabelled], "lend-receipt", FIELDS, "on")).toEqual({ status: "reject", reason: "bad" });
    }
  });

  test("family relabel with matching purpose name fails crypto (old sig presented as new and vice versa)", () => {
    const oldAsNew: PurposeEnvelope = { ...old, family: "floka", purpose: PURPOSE_MAP["invite-pop"].floka };
    const newAsOld: PurposeEnvelope = { ...neu, family: "claudestra", purpose: PURPOSE_MAP["invite-pop"].claudestra };
    expect(verifyPurposeFamilies([oldAsNew], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "bad" });
    expect(verifyPurposeFamilies([newAsOld], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "bad" });
  });

  test("old signature over [tag, ...fields] cannot be produced by an old protocol: field count differs", () => {
    // an attacker-chosen first field equal to the tag still gives one field more than the old invite proof signs
    const forged = signPurposeFamily("claudestra", "invite-pop", [familyTag("floka-invite-pop-v1"), ...FIELDS.slice(0, 4)], A)!;
    expect(verifyPurposeFamilies([{ ...forged, family: "floka", purpose: "floka-invite-pop-v1" }], "invite-pop", FIELDS, "on").status).toBe("reject");
  });

  test("dual envelope: other key, same family twice, three envelopes, one bad half → rejected (no picking the good one)", () => {
    const otherKey = signPurposeFamily("floka", "invite-pop", FIELDS, B)!;
    expect(verifyPurposeFamilies([old, otherKey], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "conflict" });
    expect(verifyPurposeFamilies([old, old], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "conflict" });
    expect(verifyPurposeFamilies([old, neu, neu], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "conflict" });
    const badNew = { ...neu, sig: old.sig };
    expect(verifyPurposeFamilies([old, badNew], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "bad" });
    const badOld = { ...old, sig: neu.sig };
    expect(verifyPurposeFamilies([badOld, neu], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "bad" });
  });

  test("tampered fields or signature fail", () => {
    const f2 = [...FIELDS.slice(0, 4), "https://evil.example"];
    expect(verifyPurposeFamilies([neu], "invite-pop", f2, "on")).toEqual({ status: "reject", reason: "bad" });
    expect(verifyPurposeFamilies([old], "invite-pop", f2, "on")).toEqual({ status: "reject", reason: "bad" });
    expect(verifyPurposeFamilies([{ ...neu, key: B.publicKey }], "invite-pop", FIELDS, "on")).toEqual({ status: "reject", reason: "bad" });
    expect(signPurposeFamily("floka", "invite-pop", ["a\nb"], A)).toBeNull();
  });
});

describe("[验收线 2] capability proof gates switching the send family", () => {
  const pinned = { instanceId: "iid-b", publicKey: B.publicKey };
  const cap = issueSignatureCapability("iid-b", B, NOW)!;

  test("valid, allowed → floka; default and every bad proof → claudestra", () => {
    expect(capabilityValid(cap, pinned, NOW + 1000)).toBe(true);
    expect(chooseSendFamily({ allowNew: true, capability: cap, pinned }, NOW + 1000)).toBe("floka");
    expect(chooseSendFamily({ capability: cap, pinned }, NOW + 1000)).toBe("claudestra");
    expect(chooseSendFamily({ allowNew: true, capability: cap, pinned: null }, NOW)).toBe("claudestra");
    expect(chooseSendFamily({ allowNew: true, capability: undefined, pinned }, NOW)).toBe("claudestra");
  });

  test("forged / mismatched / unknown version / expired / overlong proofs are refused", () => {
    const forgedByA = issueSignatureCapability("iid-b", A, NOW)!; // A signs, claims to be B
    const cases: unknown[] = [
      { ...forgedByA, publicKey: B.publicKey },
      forgedByA,
      { ...cap, instanceId: "iid-c" },
      { ...cap, protocol: "floka-sig-v2" },
      { ...cap, expiresAt: cap.expiresAt + 1 },
      { ...cap, sig: issueSignatureCapability("iid-b", B, NOW + 1)!.sig },
      { ...cap, issuedAt: String(cap.issuedAt) },
      null, "cap", {},
    ];
    for (const c of cases) expect(chooseSendFamily({ allowNew: true, capability: c, pinned }, NOW + 1000)).toBe("claudestra");
    expect(capabilityValid(cap, pinned, cap.expiresAt)).toBe(false);
    expect(capabilityValid(issueSignatureCapability("iid-b", B, NOW + 3_600_000)!, pinned, NOW)).toBe(false);
    expect(issueSignatureCapability("iid-b", B, NOW, CAPABILITY_MAX_TTL_MS * 10)!.expiresAt).toBe(NOW + CAPABILITY_MAX_TTL_MS);
    expect(capabilityValid(cap, { instanceId: "iid-b", publicKey: A.publicKey }, NOW)).toBe(false);
  });

  test("a capability proof is not a new-family invite proof and vice versa", () => {
    const inv = signPurposeFamily("floka", "invite-pop", ["iid-b", B.publicKey, "floka-sig-v1", String(NOW), String(NOW + 1)], B)!;
    expect(capabilityValid({ ...cap, sig: inv.sig }, pinned, NOW)).toBe(false);
  });
});

describe("[验收线 3] original old signature bytes stay verifiable; off / observe never widen acceptance", () => {
  test("invite proof signed by the existing module verifies as old family and still through checkInviteProof", () => {
    const f = { nonce: "N", join: "J", redeemerFp: "ABCD-ef01", inviterIid: "iid-a", inviteUrl: "https://H.example/x/" };
    const proof = signInviteProof(f, A)!;
    const wire = ["N", "J", "abcd-ef01", "iid-a", "https://h.example/x"];
    const env: PurposeEnvelope = { family: "claudestra", purpose: "claudestra-invite-pop-v1", ...proof };
    for (const m of ["off", "observe", "on"] as const) expect(verifyPurposeFamilies([env], "invite-pop", wire, m)).toMatchObject({ status: "ok" });
    expect(checkInviteProof(proof, f)).toMatchObject({ key: A.publicKey });
  });

  test("review ticket and lend receipt signed with the existing purposes verify unchanged", () => {
    const take = { orderId: "o:1", gen: 3, agent: "w", session: "s", at: 10 };
    const t = issueReviewTicket({ v: 1, orderId: "o:1", gen: 3, taskId: "T", head: "a".repeat(40), specRev: 1, round: 0, family: "c", worker: "w",
      session: "s", payloadSha: "b".repeat(64), take }, (f) => signPurposeFamily("claudestra", "lend-review-ticket", f, A))!;
    const tf = ["o:1", "3", "T", "a".repeat(40), "1", "0", "c", "w", "s", "b".repeat(64), "o:1", "3", "w", "s", "10"];
    expect(verifyPurpose(A.publicKey, REVIEW_TICKET_PURPOSE, tf, t.sig)).toBe(true);
    expect(verifyPurposeFamilies([{ family: "claudestra", purpose: REVIEW_TICKET_PURPOSE, key: t.key, sig: t.sig }], "lend-review-ticket", tf, "off").status).toBe("ok");
    const rf = ["o:1", "c".repeat(64), "7", "T"];
    const r = signPurposeFamily("claudestra", "lend-receipt", rf, A)!;
    expect(verifyPurpose(A.publicKey, "claudestra-lend-receipt-v1", rf, r.sig)).toBe(true);
  });

  test("shared-ledger request signed by the existing signer verifies as old family", () => {
    const s = signSharedLedgerRequest({ method: "POST", path: "/v1/x", body: "{}", bearer: "secret", instanceId: "iid-a", ts: "1800000000",
      attemptNonce: "0".repeat(32) }, A);
    const h = (x: string) => createHash("sha256").update(x).digest("hex");
    const fields = ["POST", "/v1/x", "1800000000", h("{}"), "0".repeat(32), "iid-a", h("secret")];
    const env: PurposeEnvelope = { family: "claudestra", purpose: "claudestra-shared-ledger-v1", key: s.publicKey, sig: s.signature };
    expect(verifyPurposeFamilies([env], "shared-ledger", fields, "off")).toMatchObject({ status: "ok", family: "claudestra" });
  });

  test("off and observe reject new-only requests with the same verdict; observe just reports", () => {
    const neu = signRequestFamily("floka", REQ, A, NOW);
    expect(verifyRequestFamilies(neu, REQ, "off", NOW)).toEqual({ status: "reject", reason: "family_off", family: "floka" });
    expect(verifyRequestFamilies(neu, REQ, "observe", NOW)).toEqual({ status: "reject", reason: "family_off", family: "floka", observed: "ok" });
    expect(verifyRequestFamilies(neu, { ...REQ, body: "x" }, "observe", NOW)).toMatchObject({ status: "reject", reason: "family_off", observed: "bad" });
    const env = signPurposeFamily("floka", "lend-receipt", FIELDS, A)!;
    expect(verifyPurposeFamilies([env], "lend-receipt", FIELDS, "observe")).toEqual({ status: "reject", reason: "family_off", observed: true });
    expect(verifyPurposeFamilies([env], "lend-receipt", ["x"], "observe")).toEqual({ status: "reject", reason: "family_off", observed: false });
  });

  test("off / observe give the same accept set as the old verifier for old-family inputs", () => {
    const old = signRequestFamily("claudestra", REQ, A, NOW);
    for (const m of ["off", "observe"] as const) {
      expect(verifyRequestFamilies(old, REQ, m, NOW).status).toBe("ok");
      expect(verifyRequestFamilies(old, { ...REQ, path: "/z" }, m, NOW).status).toBe("reject");
    }
  });
});
