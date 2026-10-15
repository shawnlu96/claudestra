/** rename-floka-LEDGER1: shared ledger + receipt/ticket purposes across both families. Temp ledgers and synthetic Ed25519 keys only; no production state is read. */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signPurpose, verifyPurpose, type InstanceKey } from "../src/lib/instance-signature.js";
import {
  authenticateSharedLedgerRequest as auth, sharedLedgerCredentialHash, signSharedLedgerRequest,
  type SharedLedgerCredential, type SharedLedgerReplayIndex, type SharedLedgerSignedRequest,
} from "../src/lib/shared-ledger-auth.js";
import { SharedLedgerError } from "../src/lib/shared-ledger-contract.js";
import { SHARED_LEDGER_COMMAND_FIXTURES } from "../src/lib/shared-ledger-contract-fixtures.js";
import { formatSharedLedgerJoinCode, SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields } from "../src/lib/shared-ledger-join-protocol.js";
import { signSharedLedgerJoin } from "../src/lib/shared-ledger-join.js";
import { appendReceipt, lendAckFields, verifyLendAck, type LendAck, type LendReceipt } from "../src/lib/lend-receipts.js";
import { issueReviewTicket, parseReviewTicket, REVIEW_TICKET_PURPOSE, ticketProblem, type ReviewTicket } from "../src/lib/pool-review-proof-ticket.js";
import { checkInviteProof, inviteUrlKey, signInviteProof } from "../src/lib/invite-proof.js";
import { ledgerReceive, ledgerSendFamilyFor, ledgerSigner, setLedgerCapabilitySource } from "../src/lib/floka-ledger/config.js";
import { requestSharedLedger } from "../src/lib/shared-ledger-client-transport.js";
import { SHARED_LEDGER_AUTH_HEADERS } from "../src/lib/shared-ledger-auth.js";
import { lendDeps } from "../src/lib/lend-deps.js";
import { lendRequest } from "../src/lib/lend-remote.js";
import { writePeers } from "../src/lib/peers.js";
import { CONFIG_PATH } from "../src/lib/paths.js";
import { issueSignatureCapability } from "../src/lib/floka-compat/signature/capability.js";
import { PURPOSE_MAP, type SignatureFamily, type SignatureUse } from "../src/lib/floka-compat/signature/families.js";
import { parseLedgerRename, type LedgerGear } from "../src/lib/floka-ledger/gear.js";
import { ledgerSendFamily, signLedgerUse, verifyLedgerUse, type LedgerObservation } from "../src/lib/floka-ledger/uses.js";
import { verifySharedLedgerJoin } from "../src/lib/floka-ledger/join.js";
import { LEDGER_PURPOSE_HEADER } from "../src/lib/floka-ledger/request.js";

function synthKey(): InstanceKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}
const A = synthKey();
const B = synthKey();
const NOW = 1_800_000_000_000;
const SECRET = "test-only-ledger-bearer";
const GEARS: LedgerGear[] = ["off", "observe", "on"];
const USES = Object.keys(PURPOSE_MAP) as SignatureUse[];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Fake center: a fresh credential per request, a durable-looking replay index, and a counter of business writes (replay claims). */
function fakeCenter(change: Partial<SharedLedgerCredential> = {}) {
  const rows = new Map<string, number>();
  let claims = 0;
  const replay: SharedLedgerReplayIndex = { claim(k, expiry, now) {
    claims++;
    if ((rows.get(k) ?? 0) > now) return false;
    rows.set(k, expiry);
    return true;
  } };
  const credential: SharedLedgerCredential = { credentialHash: sharedLedgerCredentialHash(SECRET), teamId: "team-a", personId: "person-a",
    instanceId: "instance-a", publicKey: A.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: NOW + 3600_000,
    projects: [{ projectId: "project-a", role: "member", actions: ["read", "plan"] }], ...change };
  const reports: LedgerObservation[] = [];
  return {
    get claims() { return claims; }, reports,
    accept: (req: SharedLedgerSignedRequest, receive: LedgerGear, now = NOW) =>
      auth(req, credential, replay, now, {}, { receive, report: (o) => reports.push(o) }),
  };
}

function request(family: SignatureFamily = "claudestra", change: Partial<SharedLedgerSignedRequest> = {}, key = A): SharedLedgerSignedRequest {
  const attemptNonce = randomBytes(16).toString("hex");
  return signSharedLedgerRequest({ method: "POST", path: "/v1/teams/team-a/commands", bearer: SECRET, instanceId: "instance-a",
    ts: String(NOW / 1000), attemptNonce, body: JSON.stringify({ ...SHARED_LEDGER_COMMAND_FIXTURES[0], attemptNonce }), ...change }, key, family);
}

function refused(fn: () => unknown): string {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(SharedLedgerError); return (e as SharedLedgerError).code; }
  throw new Error("unexpected acceptance");
}

const pinnedA = { instanceId: "instance-a", publicKey: A.publicKey };
const capA = issueSignatureCapability("instance-a", A, NOW)!;

describe("gears", () => {
  test("rename.ledgerReceive / ledgerSend default off; unknown values fall back to off; send on needs receive on", () => {
    expect(parseLedgerRename(undefined)).toEqual({ rename: { receive: "off", send: "off" }, problems: [] });
    expect(parseLedgerRename({ ledgerReceive: "observe" }).rename).toEqual({ receive: "observe", send: "off" });
    expect(parseLedgerRename({ ledgerReceive: "ON", ledgerSend: true }).rename).toEqual({ receive: "off", send: "off" });
    const bad = parseLedgerRename({ ledgerReceive: "observe", ledgerSend: "on" });
    expect(bad.rename).toEqual({ receive: "observe", send: "observe" });
    expect(bad.problems).toHaveLength(1);
    expect(parseLedgerRename({ ledgerReceive: "on", ledgerSend: "on" }).rename).toEqual({ receive: "on", send: "on" });
    expect(parseLedgerRename("on").rename).toEqual({ receive: "off", send: "off" });
  });

  test("new sends default to the old family; on switches only with a valid capability from the pinned peer", () => {
    expect(ledgerSendFamily("off", { capability: capA, pinned: pinnedA }, NOW)).toEqual({ family: "claudestra" });
    expect(ledgerSendFamily("observe", { capability: capA, pinned: pinnedA }, NOW)).toEqual({ family: "claudestra", observed: "floka" });
    expect(ledgerSendFamily("on", { capability: capA, pinned: pinnedA }, NOW)).toEqual({ family: "floka" });
    expect(ledgerSendFamily("on", { pinned: pinnedA }, NOW)).toEqual({ family: "claudestra" });
  });
});

describe("[验收线 1] fake center, four directions", () => {
  test("old→old, old→new, new→new accepted; a new sender facing an old center falls back to old", () => {
    const c = fakeCenter();
    expect(c.accept(request("claudestra"), "off").principal.instanceId).toBe("instance-a");
    expect(c.accept(request("claudestra"), "on").principal.instanceId).toBe("instance-a");
    const neu = request("floka");
    expect(neu.purpose).toBe("floka-shared-ledger-v1");
    expect(c.accept(neu, "on").payload).not.toBeNull();
    // Old center: no capability was issued, so the sender stays on the old family and is accepted.
    const fallback = ledgerSendFamily("on", { pinned: pinnedA }, NOW).family;
    expect(c.accept(request(fallback), "off").principal.personId).toBe("person-a");
    expect(LEDGER_PURPOSE_HEADER).toBe("x-shared-ledger-purpose");
  });

  test("old request bytes are unchanged and an old request signed before the switch still authenticates under on", () => {
    const old = request("claudestra");
    expect("purpose" in old).toBe(false);
    const fields = [old.method, old.path, old.ts, sha(old.body), old.attemptNonce, old.instanceId, sha(old.bearer)];
    expect(signPurpose("claudestra-shared-ledger-v1", fields, A)?.sig).toBe(old.signature);
    const before = JSON.stringify(old);
    expect(fakeCenter().accept(old, "on").principal.teamId).toBe("team-a");
    expect(JSON.stringify(old)).toBe(before);
  });

  test("join proofs: old proof verifies on every gear with unchanged bytes; floka proof only on", () => {
    const code = formatSharedLedgerJoinCode({ centerId: `center-${"a".repeat(32)}`, codeId: "b".repeat(32), secret: "c".repeat(43) });
    const centerId = `center-${"a".repeat(32)}`;
    const old = signSharedLedgerJoin(code, "instance-a", A);
    expect(Object.keys(old)).toEqual(["code", "publicKey", "instanceId", "signature"]);
    expect(verifyPurpose(A.publicKey, SHARED_LEDGER_JOIN_PURPOSE, sharedLedgerJoinFields(centerId, code, A.publicKey, "instance-a"), old.signature)).toBe(true);
    const neu = signSharedLedgerJoin(code, "instance-a", A, "floka");
    expect(neu.purpose).toBe("floka-shared-ledger-v1");
    for (const g of GEARS) {
      expect(verifySharedLedgerJoin(old, centerId, { receive: g })).toBe(true);
      expect(verifySharedLedgerJoin(neu, centerId, { receive: g })).toBe(g === "on");
    }
    expect(verifySharedLedgerJoin(neu, `center-${"d".repeat(32)}`, { receive: "on" })).toBe(false);
  });

  test("lend receipts, review tickets and invite proofs: old payloads still valid, new family accepted only on", () => {
    const ack: LendAck = { orderId: "lend:x:s1:r0:a0", sha256: "e".repeat(64), eventSeq: 7, taskId: "t1", ...signLedgerUse("lend-receipt", ["lend:x:s1:r0:a0", "e".repeat(64), "7", "t1"], A)! };
    const ackNew: LendAck = { ...ack, ...signLedgerUse("lend-receipt", lendAckFields(ack), A, "floka")! };
    for (const g of GEARS) {
      expect(verifyLendAck(ack, A.publicKey, { receive: g })).toBe(true);
      expect(verifyLendAck(ackNew, A.publicKey, { receive: g })).toBe(g === "on");
    }
    // Ticket: the old signer path is untouched; the floka family signs the very same fields.
    let fields: string[] = [];
    const take = { orderId: "o1", gen: 1, agent: "w", session: "s", at: 5 };
    const base = { v: 1 as const, orderId: "o1", gen: 1, taskId: "t", head: "f".repeat(40), specRev: 1, round: 0, family: "claude",
      worker: "w", session: "s", payloadSha: "a".repeat(64), take };
    const ticket = issueReviewTicket(base, (f) => { fields = f; return signLedgerUse("lend-review-ticket", f, A); })!;
    const { key: _k, sig: _s, take: _t, ...want } = ticket;
    expect(ticketProblem(ticket, want, A.publicKey)).toBeNull();
    expect(signPurpose(REVIEW_TICKET_PURPOSE, fields, A)?.sig).toBe(ticket.sig);
    const neuTicket = signLedgerUse("lend-review-ticket", fields, A, "floka")!;
    expect(verifyLedgerUse("lend-review-ticket", neuTicket, fields, "on", A.publicKey)).toEqual({ ok: true, family: "floka" });
    expect(verifyLedgerUse("lend-review-ticket", ticket, fields, "on", A.publicKey)).toEqual({ ok: true, family: "claudestra" });
    // Invite proof
    const f = { nonce: "n0", join: "j", redeemerFp: "abcd", inviterIid: "iid", inviteUrl: "https://h.example/" };
    const invFields = [f.nonce, f.join, f.redeemerFp, f.inviterIid, inviteUrlKey(f.inviteUrl)];
    const inv = signInviteProof(f, A)!;
    for (const g of GEARS) expect(verifyLedgerUse("invite-pop", inv, invFields, g, A.publicKey).ok).toBe(true);
    expect(verifyLedgerUse("invite-pop", signLedgerUse("invite-pop", invFields, A, "floka")!, invFields, "on").ok).toBe(true);
  });
});

describe("[验收线 2] rejections", () => {
  const fields = ["f1", "f2", "f3"];

  test("cross-use replay and mixed families are refused", () => {
    for (const from of USES) for (const to of USES) {
      if (from === to) continue;
      for (const family of ["claudestra", "floka"] as const) {
        const s = signLedgerUse(from, fields, A, family)!;
        expect(verifyLedgerUse(to, s, fields, "on").ok).toBe(false);
        // Relabelled as the target use: the signature covers the source use only.
        const relabel = { ...s, purpose: family === "floka" ? PURPOSE_MAP[to].floka : undefined };
        expect(verifyLedgerUse(to, relabel, fields, "on").ok).toBe(false);
      }
    }
    const old = signLedgerUse("shared-ledger", fields, A)!;
    const neu = signLedgerUse("shared-ledger", fields, A, "floka")!;
    expect(verifyLedgerUse("shared-ledger", { ...old, purpose: "floka-shared-ledger-v1" }, fields, "on")).toMatchObject({ ok: false, reason: "bad" });
    expect(verifyLedgerUse("shared-ledger", { key: neu.key, sig: neu.sig }, fields, "on")).toMatchObject({ ok: false, reason: "bad" });
    expect(verifyLedgerUse("shared-ledger", { ...neu, purpose: "floka-lend-receipt-v1" }, fields, "on")).toMatchObject({ ok: false, reason: "wrong_use" });
    expect(verifyLedgerUse("shared-ledger", { ...neu, purpose: "floka-shared-ledger-v2" }, fields, "on")).toMatchObject({ ok: false, reason: "unknown_purpose" });
    expect(verifyLedgerUse("shared-ledger", { ...neu, purpose: 1 as unknown as string }, fields, "on").ok).toBe(false);
    // A join proof is not a request signature and vice versa.
    const c = fakeCenter();
    const req = request("floka");
    const proof = signLedgerUse("shared-ledger", ["JOIN", "/v1/join", "c", "h", A.publicKey, "instance-a"], A, "floka")!;
    expect(refused(() => c.accept({ ...req, signature: proof.sig }, "on"))).toBe("bad_signature");
    // Family relabelled on the wire.
    expect(refused(() => c.accept({ ...request("claudestra"), purpose: "floka-shared-ledger-v1" }, "on"))).toBe("bad_signature");
    const { purpose: _p, ...stripped } = request("floka");
    expect(refused(() => c.accept(stripped, "on"))).toBe("bad_signature");
  });

  test("wrong key, expiry and revocation are refused in the new family too", () => {
    expect(verifyLedgerUse("lend-receipt", signLedgerUse("lend-receipt", fields, B, "floka")!, fields, "on", A.publicKey)).toEqual({ ok: false, reason: "wrong_key" });
    expect(refused(() => fakeCenter().accept({ ...request("floka", {}, B), publicKey: A.publicKey }, "on"))).toBe("bad_signature");
    expect(refused(() => fakeCenter().accept(request("floka", {}, B), "on"))).toBe("forbidden");
    expect(refused(() => fakeCenter().accept(request("floka"), "on", NOW + 3600_000))).toBe("expired");
    expect(refused(() => fakeCenter({ expiresAt: NOW }).accept(request("floka"), "on"))).toBe("expired");
    expect(refused(() => fakeCenter({ revokedAt: NOW - 1 }).accept(request("floka"), "on"))).toBe("not_member");
    expect(refused(() => fakeCenter({ membershipStatus: "removed" }).accept(request("floka"), "on"))).toBe("not_member");
    // Capability expired or peer unpinned (revoked): sends fall back to the old family.
    expect(ledgerSendFamily("on", { capability: capA, pinned: pinnedA }, capA.expiresAt).family).toBe("claudestra");
    expect(ledgerSendFamily("on", { capability: capA, pinned: null }, NOW).family).toBe("claudestra");
  });

  test("a nonce spent in one family cannot be replayed in the other", () => {
    const c = fakeCenter();
    const old = request("claudestra");
    c.accept(old, "on");
    const again = signSharedLedgerRequest({ method: old.method, path: old.path, bearer: SECRET, instanceId: "instance-a", ts: old.ts,
      attemptNonce: old.attemptNonce, body: old.body }, A, "floka");
    expect(refused(() => c.accept(again, "on"))).toBe("replayed");
    expect(refused(() => c.accept(old, "on"))).toBe("replayed");
  });
});

describe("[验收线 3] off / observe write nothing and keep history byte-identical", () => {
  test("floka requests are refused before any replay claim; observe only reports", () => {
    for (const g of ["off", "observe"] as const) {
      const c = fakeCenter();
      expect(refused(() => c.accept(request("floka"), g))).toBe("bad_signature");
      expect(c.claims).toBe(0);
      expect(c.reports).toEqual(g === "observe" ? [{ use: "shared-ledger", family: "floka", wouldAccept: true }] : []);
      expect(c.accept(request("claudestra"), g).principal.instanceId).toBe("instance-a");
      expect(c.claims).toBe(1);
    }
    const c = fakeCenter();
    expect(refused(() => c.accept({ ...request("floka"), signature: request("floka").signature }, "observe"))).toBe("bad_signature");
    expect(c.reports).toEqual([{ use: "shared-ledger", family: "floka", wouldAccept: false }]);
  });

  test("historical receipts are appended and re-verified without rewriting ackSig", () => {
    const dir = mkdtempSync(join(tmpdir(), "floka-ledger-"));
    try {
      const path = join(dir, "receipts.jsonl");
      const ack = { orderId: "lend:y:s1:r0:a0", sha256: "1".repeat(64), eventSeq: 3, taskId: "t2" };
      const ackSig = { ...ack, ...signLedgerUse("lend-receipt", lendAckFields({ ...ack, key: "", sig: "" }), A)! };
      const r: LendReceipt = { orderId: ack.orderId, peer: "p", fp: null, taskId: "t2", step: null, repo: null, pr: null, head: null, family: "claude",
        agent: null, sessionId: null, outcome: "acked" as LendReceipt["outcome"], reason: null, startedAt: "x", endedAt: "y", tokens: "未知", ackSig };
      expect(appendReceipt(r, path)).toBe(true);
      const line = readFileSync(path, "utf8");
      expect(line).toBe(`${JSON.stringify(r)}\n`);
      const stored = JSON.parse(line).ackSig as LendAck;
      for (const g of GEARS) expect(verifyLendAck(stored, A.publicKey, { receive: g })).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(line);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** Real entry points read rename.* from config.json in the test's temp state dir; each case restores the file and the capability source. */
function withRename<T>(rename: Record<string, string> | null, fn: () => T): T {
  const before = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  writeFileSync(CONFIG_PATH, JSON.stringify(rename ? { rename } : {}));
  const restore = () => { if (before === null) rmSync(CONFIG_PATH, { force: true }); else writeFileSync(CONFIG_PATH, before); };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore) as T;
    restore();
    return r;
  } catch (e) { restore(); throw e; }
}
const ON = { ledgerReceive: "on", ledgerSend: "on" };
/** Entry points pick the family at wall-clock time, so their capability is issued now (capA is pinned to NOW for the pure cases). */
const capable = () => { const capability = issueSignatureCapability("instance-a", A); setLedgerCapabilitySource(() => ({ capability, pinned: pinnedA })); };

describe("[验收线 1] real entry points", () => {
  afterEach(() => setLedgerCapabilitySource(null));
  const take = { orderId: "o1", gen: 1, agent: "w", session: "s", at: 5 };
  const base = { v: 1 as const, orderId: "o1", gen: 1, taskId: "t", head: "f".repeat(40), specRev: 1, round: 0, family: "claude",
    worker: "w", session: "s", payloadSha: "a".repeat(64), take };
  const want = { orderId: "o1", gen: 1, taskId: "t", head: "f".repeat(40), specRev: 1, round: 0, family: "claude", worker: "w", session: "s", payloadSha: "a".repeat(64) };
  const legacyTicket = (f: string[]) => signPurpose(REVIEW_TICKET_PURPOSE, f, A);
  const wire = (t: ReviewTicket | null) => parseReviewTicket(JSON.parse(JSON.stringify(t)));

  test("review ticket: issue → parse → ticketProblem; floka only with on + capability; old tickets unchanged", () => {
    const neu = withRename(ON, () => { capable(); return issueReviewTicket(base, ledgerSigner("lend-review-ticket", "pa", legacyTicket, () => A)); })!;
    expect(neu.purpose).toBe("floka-lend-review-ticket-v1");
    const parsed = wire(neu)!;
    expect(parsed).not.toBeNull();
    expect(ticketProblem(parsed, want, A.publicKey, { receive: "on" })).toBeNull();
    expect(withRename(ON, () => ticketProblem(parsed, want, A.publicKey, ledgerReceive()))).toBeNull();
    expect(ticketProblem(parsed, want, A.publicKey)).toBe("票据签名不对");
    const reports: LedgerObservation[] = [];
    expect(ticketProblem(parsed, want, A.publicKey, { receive: "observe", report: (o) => reports.push(o) })).toBe("票据签名不对");
    expect(reports).toEqual([{ use: "lend-review-ticket", family: "floka", wouldAccept: true }]);
    // No capability (the default source): the very same old ticket, byte for byte, whatever the gear.
    setLedgerCapabilitySource(null);
    const old = withRename(ON, () => issueReviewTicket(base, ledgerSigner("lend-review-ticket", "pa", legacyTicket, () => A)))!;
    expect(JSON.stringify(old)).toBe(JSON.stringify(issueReviewTicket(base, legacyTicket)));
    for (const g of GEARS) expect(ticketProblem(wire(old)!, want, A.publicKey, { receive: g })).toBeNull();
    // Purpose must be this use's floka name; relabelled or stripped tickets fail the signature.
    expect(wire({ ...neu, purpose: "claudestra-lend-review-ticket-v1" })).toBeNull();
    expect(wire({ ...neu, purpose: "floka-lend-receipt-v1" })).toBeNull();
    expect(ticketProblem(wire({ ...old, purpose: "floka-lend-review-ticket-v1" })!, want, A.publicKey, { receive: "on" })).toBe("票据签名不对");
    const { purpose: _p, ...stripped } = neu;
    expect(ticketProblem(wire(stripped)!, want, A.publicKey, { receive: "on" })).toBe("票据签名不对");
    expect(ticketProblem(parsed, want, B.publicKey, { receive: "on" })).toBe("票据不是用钉住的对方钥匙签的");
  });

  test("invite proof: floka proof passes checkInviteProof only under receive on; old proofs pass on every gear", () => {
    const f = { nonce: "n0", join: "j", redeemerFp: "abcd", inviterIid: "iid", inviteUrl: "https://h.example/" };
    const neu = signInviteProof(f, A, "floka")!;
    expect(neu.purpose).toBe("floka-invite-pop-v1");
    const wireNeu = JSON.parse(JSON.stringify(neu));
    expect(checkInviteProof(wireNeu, f, { receive: "on" })).toMatchObject({ key: A.publicKey });
    expect(withRename(ON, () => checkInviteProof(wireNeu, f, ledgerReceive()))).toMatchObject({ key: A.publicKey });
    expect(checkInviteProof(wireNeu, f)).toBe("bad");
    expect(checkInviteProof(wireNeu, f, { receive: "observe" })).toBe("bad");
    const old = signInviteProof(f, A)!;
    expect(Object.keys(old)).toEqual(["key", "sig"]);
    for (const g of GEARS) expect(checkInviteProof(old, f, { receive: g })).toMatchObject({ key: A.publicKey });
    expect(checkInviteProof({ ...neu, purpose: "floka-lend-receipt-v1" }, f, { receive: "on" })).toBe("bad");
    expect(checkInviteProof({ ...old, purpose: "floka-invite-pop-v1" }, f, { receive: "on" })).toBe("bad");
    const otherUse = signLedgerUse("lend-receipt", [f.nonce, f.join, f.redeemerFp, f.inviterIid, inviteUrlKey(f.inviteUrl)], A, "floka")!;
    expect(checkInviteProof({ ...otherUse, purpose: "floka-invite-pop-v1" }, f, { receive: "on" })).toBe("bad");
    expect(checkInviteProof({ ...neu, sig: signInviteProof({ ...f, nonce: "n1" }, A, "floka")!.sig }, f, { receive: "on" })).toBe("bad");
  });

  test("lend receipts: A signs floka only with on + capability; B parses and lend-deps verifies by ledgerReceive", async () => {
    const fields = ["lend:x:s1:r0:a0", "e".repeat(64), "7", "t1"];
    const base = { orderId: fields[0]!, sha256: fields[1]!, eventSeq: 7, taskId: "t1" };
    const legacy = (f: string[]) => signPurpose("claudestra-lend-receipt-v1", f, A);
    // A side, no capability: exactly deps.sign's output, so an old B's exact-key parser still takes it.
    const old = withRename(ON, () => ledgerSigner("lend-receipt", "pb", legacy, () => A)(fields))!;
    expect(old).toEqual(legacy(fields)!);
    const neu = withRename(ON, () => { capable(); return ledgerSigner("lend-receipt", "pb", legacy, () => A)(fields); })!;
    expect(neu.purpose).toBe("floka-lend-receipt-v1");
    const reply = (receipt: unknown) => async () => ({ status: 200, body: { ok: true, v: 1, receipt } });
    const parsedOld = await lendRequest(reply({ ...base, ...old }), "pa", "result", {});
    const parsedNeu = await lendRequest(reply({ ...base, ...neu }), "pa", "result", {});
    expect(parsedOld).toMatchObject({ ok: true });
    expect(parsedOld.ok && "purpose" in parsedOld.value).toBe(false);
    expect(parsedNeu).toMatchObject({ ok: true, value: { purpose: "floka-lend-receipt-v1" } });
    expect(await lendRequest(reply({ ...base, ...neu, purpose: "floka-invite-pop-v1" }), "pa", "result", {})).toMatchObject({ ok: false, code: "bad_response" });
    expect(await lendRequest(reply({ ...base, ...old, purpose: "claudestra-lend-receipt-v1" }), "pa", "result", {})).toMatchObject({ ok: false, code: "bad_response" });
    // B side: lend-deps verifyReceipt against the peer's recorded key.
    await writePeers({ httpPeers: [{ name: "pa", baseUrl: "https://pa.invalid", publicKey: A.publicKey, addedAt: new Date(NOW).toISOString() }] } as never);
    const dir = mkdtempSync(join(tmpdir(), "floka-ledger-deps-"));
    const db = new Database(join(dir, "journal.db"));
    try {
      const verify = lendDeps(db, { get: () => null } as never, () => {}, undefined).verifyReceipt;
      const rOld = parsedOld.ok ? parsedOld.value : null, rNeu = parsedNeu.ok ? parsedNeu.value : null;
      for (const rename of [null, { ledgerReceive: "observe" }, { ledgerReceive: "on" }]) {
        expect(await withRename(rename, () => verify("pa", rOld!))).toBe(true);
        expect(await withRename(rename, () => verify("pa", rNeu!))).toBe(rename?.ledgerReceive === "on");
      }
      expect(await withRename({ ledgerReceive: "on" }, () => verify("nobody", rNeu!))).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); await writePeers({ httpPeers: [] } as never); }
  });

  test("shared-ledger send: floka + purpose header only with on + capability; otherwise the old request, header for header", async () => {
    const connection = { centerId: "c", baseUrl: "https://center.invalid", teamId: "team-a", personId: "person-a", instanceId: "instance-a", bearer: SECRET };
    const send = async () => {
      let seen: Headers | null = null;
      const fetcher = (async (_u: URL, init: RequestInit) => { seen = new Headers(init.headers); return Response.json({}); }) as unknown as typeof fetch;
      await requestSharedLedger(connection, A, { fetch: fetcher, now: () => NOW }, "GET", "/v1/teams/team-a/features");
      const h = seen! as Headers, H = SHARED_LEDGER_AUTH_HEADERS;
      const req: SharedLedgerSignedRequest = { method: "GET", path: "/v1/teams/team-a/features", body: "", bearer: SECRET, publicKey: h.get(H.key)!, instanceId: h.get(H.instance)!,
        ts: h.get(H.ts)!, signature: h.get(H.sig)!, attemptNonce: h.get(H.nonce)!, ...(h.has(LEDGER_PURPOSE_HEADER) ? { purpose: h.get(LEDGER_PURPOSE_HEADER)! } : {}) };
      return { names: [...h.keys()].sort(), req };
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const off = await withRename(null, send);
      expect(off.names).not.toContain(LEDGER_PURPOSE_HEADER);
      expect(fakeCenter().accept(off.req, "off").principal.instanceId).toBe("instance-a");
      const noCap = await withRename(ON, send);
      expect(noCap.names).toEqual(off.names);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("没有能力证明"))).toBe(true);
      const neu = await withRename(ON, () => { capable(); return send(); });
      expect(neu.names).toEqual([...off.names, LEDGER_PURPOSE_HEADER].sort());
      expect(neu.req.purpose).toBe("floka-shared-ledger-v1");
      expect(fakeCenter().accept(neu.req, "on").principal.instanceId).toBe("instance-a");
      expect(refused(() => fakeCenter().accept(neu.req, "off"))).toBe("bad_signature");
      // observe sends old and only reports what on would pick.
      expect(withRename({ ledgerReceive: "on", ledgerSend: "observe" }, () => { capable(); return ledgerSendFamilyFor("shared-ledger", "https://center.invalid"); })).toBe("claudestra");
    } finally { warn.mockRestore(); }
  });
});
