/** Real synthetic Ed25519/P-256 keys and in-memory transport; no host credentials or peer files. */
import { describe, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { generateEcdh } from "../src/lib/e2e/primitives.js";
import { utf8 } from "../src/lib/e2e/encoding.js";
import { respond, finish } from "../src/lib/e2e/handshake.js";
import { sealMessage, openAll, DIR_REQ, DIR_RES } from "../src/lib/e2e/records.js";
import { ReplayWindow } from "../src/lib/e2e/replay-window.js";
import { signE2eKey } from "../src/lib/e2e-machine-key.js";
import { keyFingerprint } from "../src/lib/instance-key.js";
import { signedHeaders, type InstanceKey } from "../src/lib/instance-signature.js";
import { signInviteProof } from "../src/lib/invite-proof.js";
import { parsePeerInviteV2, type PeerInviteV2, type PendingInvite } from "../src/lib/peers.js";
import * as legacy from "../src/lib/peer-e2e-redeem.js";
import { encodeHello } from "../src/lib/peer-e2e-wire.js";
import { signRequestFamily } from "../src/lib/floka-compat/signature/request.js";
import { E2E_LABELS, parseE2eRename, type E2eFamily } from "../src/lib/floka-compat/e2e/families.js";
import { E2E_PROTOCOL, E2E_CAPABILITY_TTL, issueE2eCapability, e2eCapabilityValid, planE2eSend, type E2ePin } from "../src/lib/floka-compat/e2e/capability.js";
import { authenticateE2eRequest } from "../src/lib/floka-compat/e2e/context.js";
import { sealRequest, openRequest, sealResponse, openResponse } from "../src/lib/floka-compat/e2e/redeem.js";
import { respondPeer, finishPeer } from "../src/lib/floka-compat/e2e/peer.js";
import { joinInvite, receiveRedeem, type RedeemState } from "../src/lib/floka-compat/e2e/exchange.js";

const NOW = 1_800_000_000_000;
const PATH = "/api/v1/peers/redeem";
function identity(): InstanceKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}
async function machine(iid: string) {
  const key = identity(), pair = await generateEcdh();
  const fp = keyFingerprint(key.publicKey);
  const pin: E2ePin = { instanceId: iid, idk: key.publicKey, ek: signE2eKey(key, pair.pub, 1, NOW / 1000) };
  return { key, pair, fp, pin };
}
const A = await machine("11111111-1111-4111-8111-111111111111");
const B = await machine("22222222-2222-4222-8222-222222222222");
const INVITE: PeerInviteV2 = {
  v: 2, name: "synthetic-A", url: "https://invite.example", token: "synthetic-token-123456789", join: "synthetic-join-123456789",
  iid: A.pin.instanceId, fp: A.fp, idk: A.pin.idk, ek: A.pin.ek,
};
const CODE = Buffer.from(JSON.stringify(INVITE)).toString("base64url");
const PENDING: PendingInvite = {
  id: "inv_synthetic", joinSecret: INVITE.join, inTokenId: "tok_synthetic", agents: ["synthetic"], url: INVITE.url,
  createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 24 * 3600_000).toISOString(), e2e: true,
};
const ON = { receive: "on", send: "off" } as const;
const hashIdentity = () => createHash("sha256").update(JSON.stringify([A.pin, B.pin])).digest("hex");
function auth(family: E2eFamily, body: unknown, sender = B, path = PATH) {
  const req = { method: "POST", path, body: JSON.stringify(body) };
  return authenticateE2eRequest(signRequestFamily(family, req, sender.key, NOW), req, sender.pin, NOW);
}

describe("[验收线 1] four-direction encrypted exchange", () => {
  for (const [name, family] of [
    ["old→old", "claudestra"], ["old→new", "claudestra"], ["new→old uses default legacy", "claudestra"], ["new→new", "floka"],
  ] as const) {
    test(name, async () => {
      const request = await sealRequest(family, A.pair.pub, A.fp, { join: INVITE.join, idk: B.pin.idk });
      const received = family === "claudestra" && name === "new→old uses default legacy"
        ? await legacy.openRedeemRequest(A.pair, A.fp, request.body)
        : await openRequest((await auth(family, request.body))!, A.pair, A.fp);
      expect(received?.payload).toEqual({ join: INVITE.join, idk: B.pin.idk });
      const response = "family" in received!.session
        ? await sealResponse(received!.session as Parameters<typeof sealResponse>[0], { ok: true, token: INVITE.token })
        : await legacy.sealRedeemResponse(received!.session, { ok: true, token: INVITE.token });
      expect(await openResponse(request.session, response)).toEqual({ ok: true, token: INVITE.token });
    });
  }

  test("a canonical old sealed request and response interoperate in both directions", async () => {
    const old = await legacy.sealRedeemRequest(A.pair.pub, A.fp, { join: INVITE.join });
    const got = await openRequest((await auth("claudestra", old.body))!, A.pair, A.fp);
    expect(got?.payload).toEqual({ join: INVITE.join });
    const response = await sealResponse(got!.session, { ok: true });
    expect(await legacy.openRedeemResponse(old.session, response)).toEqual({ ok: true });
    expect(parsePeerInviteV2(CODE)).toEqual(INVITE);
  });

  for (const family of ["claudestra", "floka"] as const) {
    test(`${family} peer handshake and encrypted records, bound to authenticated family`, async () => {
      const ephemeral = await generateEcdh();
      const hello = JSON.parse(encodeHello({ from: B.fp, to: A.fp, ce: ephemeral.pub, key: B.pin.ek }));
      const ctx = (await auth(family, hello, B, "/api/v1/e2e/hello"))!;
      const r = await respondPeer(ctx, A.pair, A.fp);
      expect(r).not.toBeNull();
      const keys = await finishPeer(family, B.pair, ephemeral, A.pin, A.fp, B.fp, { ...r!, key: A.pin.ek });
      expect(keys).not.toBeNull();
      const scope = { key: keys!.c2b, sid: r!.sid, dir: DIR_REQ, rid: 1n, label: E2E_LABELS[family].peer } as const;
      const wire = await sealMessage(scope, utf8("head"), utf8("secret"));
      expect(await openAll({ ...scope, key: r!.keys.c2b }, wire)).toEqual([utf8("head"), utf8("secret")]);
      const resScope = { ...scope, key: r!.keys.b2c, dir: DIR_RES } as const;
      const res = await sealMessage(resScope, utf8("reply"));
      expect(await openAll({ ...resScope, key: keys!.b2c }, res)).toEqual([utf8("reply")]);
      const other = family === "floka" ? "claudestra" : "floka";
      await expect(openAll({ ...scope, label: E2E_LABELS[other].peer }, wire)).rejects.toThrow();
      expect(await finishPeer(other, B.pair, ephemeral, A.pin, A.fp, B.fp, { ...r!, key: A.pin.ek })).toBeNull();
      if (family === "claudestra") {
        expect(await finish({ fp: A.fp, devId: utf8(B.fp), label: E2E_LABELS.claudestra.peer }, {
          local: B.pair, ephemeral, remoteStatic: A.pair.pub, be: r!.be, sid: r!.sid, confirm: r!.confirm,
        })).not.toBeNull();
        const old = await respond({ fp: A.fp, devId: utf8(B.fp), label: E2E_LABELS.claudestra.peer }, {
          local: A.pair, remoteStatic: B.pair.pub, ce: ephemeral.pub,
        });
        expect(await finishPeer(family, B.pair, ephemeral, A.pin, A.fp, B.fp, { ...old, key: A.pin.ek })).not.toBeNull();
      }
      const window = new ReplayWindow();
      expect(window.accept(1n)).toBe(true);
      expect(window.accept(1n)).toBe(false);
    });
  }
});

describe("[验收线 2] authenticated family and pin gates", () => {
  test("mixed request labels, pin mismatch, unsigned input and modified body fail", async () => {
    const request = await sealRequest("floka", A.pair.pub, A.fp, { join: INVITE.join });
    const wrong = await auth("claudestra", request.body);
    expect(await openRequest(wrong!, A.pair, A.fp)).toBeNull();
    expect(await openRequest({ family: "floka", pin: B.pin, path: PATH }, A.pair, A.fp)).toBeNull();
    const req = { method: "POST", path: PATH, body: JSON.stringify(request.body) };
    const old = signedHeaders(req.method, req.path, req.body, B.key, NOW);
    const neu = signRequestFamily("floka", req, B.key, NOW);
    expect(await authenticateE2eRequest({ ...old, ...neu }, req, B.pin, NOW)).toBeNull();
    expect(await authenticateE2eRequest({}, req, B.pin, NOW)).toBeNull();
    expect(await authenticateE2eRequest(neu, req, A.pin, NOW)).toBeNull();
    expect(await authenticateE2eRequest(neu, { ...req, body: "{}" }, B.pin, NOW)).toBeNull();
    expect(await authenticateE2eRequest(neu, req, B.pin, NOW + 301_000)).toBeNull();
    expect(await openRequest((await auth("floka", request.body))!, B.pair, A.fp)).toBeNull();
    expect(await openRequest((await auth("floka", request.body))!, A.pair, B.fp)).toBeNull();
  });

  test("response labels cannot be swapped; malformed or plaintext success is refused", async () => {
    const request = await sealRequest("floka", A.pair.pub, A.fp, { join: INVITE.join });
    const got = (await openRequest((await auth("floka", request.body))!, A.pair, A.fp))!;
    const response = await sealResponse(got.session, { ok: true });
    expect(await legacy.openRedeemRequest(A.pair, A.fp, request.body)).toBeNull();
    expect(await legacy.openRedeemResponse(request.session, response)).toBeNull();
    expect(await openResponse({ ...request.session, family: "claudestra" }, response)).toBeNull();
    expect(await openResponse(request.session, { ok: true, token: "evil" })).toBeNull();
    expect(await openResponse(request.session, { ...response, ct: "AA" })).toBeNull();
    expect(await openRequest((await auth("floka", { ...request.body, suite: {} }))!, A.pair, A.fp)).toBeNull();
  });

  test("peer hello identity, signed encryption key, target and ephemeral point must match", async () => {
    const e = await generateEcdh();
    const base = { from: B.fp, to: A.fp, ce: e.pub, key: B.pin.ek };
    for (const change of [{ from: A.fp }, { to: B.fp }, { key: A.pin.ek }, { ce: new Uint8Array(65) }]) {
      const hello = JSON.parse(encodeHello({ ...base, ...change }));
      const ctx = (await auth("floka", hello, B, "/api/v1/e2e/hello"))!;
      expect(await respondPeer(ctx, A.pair, A.fp)).toBeNull();
    }
    const response = await respond({ fp: A.fp, devId: utf8(B.fp), label: E2E_LABELS.floka.peer }, {
      local: A.pair, remoteStatic: B.pair.pub, ce: e.pub,
    });
    expect(await finishPeer("floka", B.pair, e, A.pin, A.fp, B.fp, { ...response, key: B.pin.ek })).toBeNull();
    expect(await finishPeer("floka", B.pair, e, B.pin, A.fp, B.fp, { ...response, key: A.pin.ek })).toBeNull();
  });

  test("capability is bound to identity, instance, encryption key, version, protocol and time", () => {
    const cap = issueE2eCapability(A.pin, A.key, NOW)!;
    expect(cap.protocol).toBe(E2E_PROTOCOL);
    const enabled = { receive: "on", send: "on" } as const;
    expect(e2eCapabilityValid(cap, A.pin, NOW)).toBe(true);
    expect(planE2eSend(enabled, A.pin, cap, NOW)).toBe("floka");
    expect(planE2eSend(ON, A.pin, cap, NOW)).toBe("claudestra");
    expect(planE2eSend(enabled, A.pin, undefined, NOW)).toBe("claudestra");
    for (const change of [{ sig: "AA" }, { instanceId: B.pin.instanceId }, { idk: B.pin.idk }, { ek: B.pin.ek.pub },
      { version: 2 }, { protocol: "floka-sig-v1" }, { expiresAt: NOW }, { issuedAt: NOW + 301_000 }]) {
      expect(e2eCapabilityValid({ ...cap, ...change }, A.pin, NOW)).toBe(false);
      expect(planE2eSend(enabled, A.pin, { ...cap, ...change }, NOW)).toBe("claudestra");
    }
    expect(e2eCapabilityValid(cap, B.pin, NOW)).toBe(false);
    expect(e2eCapabilityValid(cap, A.pin, cap.expiresAt)).toBe(false);
    expect(issueE2eCapability(A.pin, A.key, NOW, -1)).toBeNull();
    expect(issueE2eCapability(A.pin, A.key, NOW, 0)).toBeNull();
    expect(issueE2eCapability(A.pin, A.key, NOW, E2E_CAPABILITY_TTL + 1)).toBeNull();
  });
});

function receiver(state: RedeemState) {
  let writes = 0;
  const deps = {
    lookup: async (_join: string) => state,
    redeemAtomic: async (expected: RedeemState, payload: Record<string, unknown>, _ctx: unknown, now: number) => {
      if (expected !== state || state.used || state.revoked || Date.parse(state.invite.expiresAt) <= now) return null;
      state.used = true; writes++;
      return { ok: true, iid: A.pin.instanceId, proof: signInviteProof({
        nonce: payload.nonce as string, join: INVITE.join, redeemerFp: B.fp, inviterIid: A.pin.instanceId, inviteUrl: INVITE.url,
      }, A.key) };
    },
  };
  return { deps, writes: () => writes };
}
function state(): RedeemState { return { invite: structuredClone(PENDING), revoked: false, used: false }; }
function joining(post: Parameters<typeof joinInvite>[1]["post"]) {
  let writes = 0, tokens = 0;
  const deps = { local: () => { tokens++; return B; }, post, savePeer: async (_invite: PeerInviteV2, _value: unknown) => { writes++; } };
  return { deps, writes: () => writes, tokens: () => tokens };
}

describe("[验收线 1、2、3] fake transport, original invite lifecycle and mode effects", () => {
  test("old invite joins without replacement and retains every original field", async () => {
    const before = hashIdentity(), r = receiver(state());
    let posts = 0;
    const j = joining(async (body, headers) => {
      posts++;
      const ctx = await authenticateE2eRequest(headers, { method: "POST", path: PATH, body }, B.pin, NOW);
      const answer = await receiveRedeem(ON, ctx!, A.pair, A.fp, r.deps, NOW);
      return answer.ok ? { status: 200, body: answer.body } : { status: 400, body: {} };
    });
    expect(await joinInvite({ code: CODE, rename: ON, pin: A.pin, now: NOW }, j.deps)).toMatchObject({ ok: true, family: "claudestra" });
    expect(posts).toBe(1); expect(r.writes()).toBe(1); expect(j.writes()).toBe(1);
    expect(parsePeerInviteV2(CODE)).toEqual(INVITE); expect(hashIdentity()).toBe(before);
  });

  test("enabled new-family join requires authenticated capability", async () => {
    const r = receiver(state());
    const j = joining(async (body, headers) => {
      const ctx = await authenticateE2eRequest(headers, { method: "POST", path: PATH, body }, B.pin, NOW);
      expect(ctx?.family).toBe("floka");
      const answer = await receiveRedeem(ON, ctx!, A.pair, A.fp, r.deps, NOW);
      return { status: answer.ok ? 200 : 400, body: answer.ok ? answer.body : {} };
    });
    const result = await joinInvite({ code: CODE, rename: { receive: "on", send: "on" }, pin: A.pin,
      capability: issueE2eCapability(A.pin, A.key, NOW), now: NOW }, j.deps);
    expect(result).toMatchObject({ ok: true, family: "floka" });
    expect(r.writes()).toBe(1); expect(j.writes()).toBe(1);
  });

  test("an invitation URL prefix is preserved and covered by both request signature and proof", async () => {
    const url = "https://invite.example/prefix";
    const s = state(); s.invite.url = url;
    const r = receiver(s);
    const j = joining(async (body, headers, base) => {
      expect(base).toBe(url);
      const req = { method: "POST", path: `/prefix${PATH}`, route: PATH, body };
      const ctx = await authenticateE2eRequest(headers, req, B.pin, NOW);
      expect(ctx).not.toBeNull();
      expect(await authenticateE2eRequest(headers, { ...req, path: PATH }, B.pin, NOW)).toBeNull();
      const opened = (await openRequest(ctx!, A.pair, A.fp))!;
      const payload = opened.payload as { nonce: string };
      const deps = { ...r.deps, redeemAtomic: async (...args: Parameters<typeof r.deps.redeemAtomic>) => {
        const result = await r.deps.redeemAtomic(...args);
        return result ? { ...result, proof: signInviteProof({ nonce: payload.nonce, join: INVITE.join,
          redeemerFp: B.fp, inviterIid: A.pin.instanceId, inviteUrl: url }, A.key) } : null;
      } };
      const answer = await receiveRedeem(ON, ctx!, A.pair, A.fp, deps, NOW);
      return { status: answer.ok ? 200 : 400, body: answer.ok ? answer.body : {} };
    });
    const code = Buffer.from(JSON.stringify({ ...INVITE, url })).toString("base64url");
    expect((await joinInvite({ code, rename: ON, pin: A.pin, now: NOW }, j.deps)).ok).toBe(true);
    expect(r.writes()).toBe(1); expect(j.writes()).toBe(1);
  });

  test("off/observe: no post, redemption, local-key/token generation or peer writes; stable identity hash", async () => {
    const before = hashIdentity();
    for (const mode of ["off", "observe"] as const) {
      const unchanged = state(), beforeState = JSON.stringify(unchanged);
      const r = receiver(unchanged), j = joining(async () => { throw new Error("must not send"); });
      const request = await sealRequest("floka", A.pair.pub, A.fp, {
        join: INVITE.join, iid: B.pin.instanceId, idk: B.pin.idk, ek: B.pin.ek, inviteUrl: INVITE.url,
      });
      const ctx = (await auth("floka", request.body))!;
      const result = await receiveRedeem({ receive: mode, send: "off" }, ctx, A.pair, A.fp, r.deps, NOW);
      expect(result.ok).toBe(false);
      if (mode === "observe") expect(result).toMatchObject({ observed: { family: "floka", wouldAccept: true } });
      expect((await joinInvite({ code: CODE, rename: { receive: mode, send: "on" }, pin: A.pin, now: NOW }, j.deps)).ok).toBe(false);
      expect(r.writes()).toBe(0); expect(j.writes()).toBe(0); expect(j.tokens()).toBe(0);
      expect(JSON.stringify(unchanged)).toBe(beforeState);
    }
    expect(hashIdentity()).toBe(before);
    expect(parseE2eRename(undefined)).toEqual({ receive: "off", send: "off" });
    expect(parseE2eRename({ rename: { e2e: "on" } })).toEqual(ON);
    expect(parseE2eRename({ rename: { e2e: { receive: "observe", send: "on" } } })).toEqual({ receive: "observe", send: "off" });
    for (const e2e of [true, "ON", {}, { receive: true, send: "on" }]) {
      expect(parseE2eRename({ rename: { e2e } })).toEqual({ receive: "off", send: "off" });
    }
  });

  test("expired, revoked, used, mismatched secret, identity and E2E pin reject before any write", async () => {
    for (const scenario of ["expired", "revoked", "used", "secret", "idk", "ek", "iid", "url"] as const) {
      const s = state();
      if (scenario === "expired") s.invite.expiresAt = new Date(NOW).toISOString();
      if (scenario === "revoked") s.revoked = true;
      if (scenario === "used") s.used = true;
      const payload = { join: scenario === "secret" ? "wrong" : INVITE.join, iid: B.pin.instanceId, idk: B.pin.idk,
        ek: B.pin.ek, inviteUrl: INVITE.url };
      if (scenario === "idk") payload.idk = A.pin.idk;
      if (scenario === "ek") payload.ek = A.pin.ek;
      if (scenario === "iid") payload.iid = A.pin.instanceId;
      if (scenario === "url") payload.inviteUrl = "https://changed.example";
      const request = await sealRequest("claudestra", A.pair.pub, A.fp, payload), r = receiver(s);
      expect((await receiveRedeem(ON, (await auth("claudestra", request.body))!, A.pair, A.fp, r.deps, NOW)).ok).toBe(false);
      expect(r.writes()).toBe(0);
    }
  });

  test("concurrent replay is consumed once; revoked state rechecked atomically", async () => {
    const request = await sealRequest("floka", A.pair.pub, A.fp, {
      join: INVITE.join, iid: B.pin.instanceId, idk: B.pin.idk, ek: B.pin.ek, inviteUrl: INVITE.url,
    });
    const ctx = (await auth("floka", request.body))!, r = receiver(state());
    const results = await Promise.all([1, 2].map(() => receiveRedeem(ON, ctx, A.pair, A.fp, r.deps, NOW)));
    expect(results.filter(x => x.ok)).toHaveLength(1); expect(r.writes()).toBe(1);
    const s = state(), raced = receiver(s);
    const deps = { ...raced.deps, redeemAtomic: async (...args: Parameters<typeof raced.deps.redeemAtomic>) => {
      s.revoked = true; return raced.deps.redeemAtomic(...args);
    } };
    expect((await receiveRedeem(ON, ctx, A.pair, A.fp, deps, NOW)).ok).toBe(false); expect(raced.writes()).toBe(0);
  });

  test("decrypt/transport failure never retries plaintext; bad invitation and pin do not send", async () => {
    for (const response of [{ status: 200, body: { ok: true, token: "evil" } }, { status: 200, body: { v: 1, ct: "AA", nonce: "AA" } },
      { status: 401, body: { code: "retry_plaintext" } }]) {
      let calls = 0;
      const j = joining(async body => { calls++; expect(JSON.parse(body)).toHaveProperty("ct"); return response; });
      expect((await joinInvite({ code: CODE, rename: ON, pin: A.pin, now: NOW }, j.deps)).ok).toBe(false);
      expect(calls).toBe(1); expect(j.writes()).toBe(0);
    }
    let calls = 0;
    const j = joining(async () => { calls++; throw new Error("transport failed"); });
    expect((await joinInvite({ code: CODE, rename: ON, pin: A.pin, now: NOW }, j.deps)).ok).toBe(false);
    expect(calls).toBe(1); expect(j.writes()).toBe(0);
    for (const code of [CODE, Buffer.from(JSON.stringify({ ...INVITE, ek: { ...INVITE.ek!, sig: "AA" } })).toString("base64url")]) {
      const bad = joining(async () => { throw new Error("must not send"); });
      expect((await joinInvite({ code, rename: ON, pin: B.pin, now: NOW }, bad.deps)).ok).toBe(false);
      expect(bad.tokens()).toBe(0); expect(bad.writes()).toBe(0);
    }
  });

  test("encrypted success still requires the original inviter identity proof, instance id and nonce", async () => {
    for (const problem of ["proof_key", "iid", "nonce", "proof_missing"] as const) {
      let calls = 0;
      const j = joining(async (body, headers) => {
        calls++;
        const ctx = (await authenticateE2eRequest(headers, { method: "POST", path: PATH, body }, B.pin, NOW))!;
        const opened = (await openRequest(ctx, A.pair, A.fp))!;
        const p = opened.payload as { nonce: string };
        const fields = { nonce: problem === "nonce" ? "wrong" : p.nonce, join: INVITE.join, redeemerFp: B.fp,
          inviterIid: A.pin.instanceId, inviteUrl: INVITE.url };
        const proof = problem === "proof_missing" ? undefined : signInviteProof(fields, problem === "proof_key" ? B.key : A.key);
        const response = await sealResponse(opened.session, { ok: true, proof, iid: problem === "iid" ? B.pin.instanceId : A.pin.instanceId });
        return { status: 200, body: response };
      });
      expect((await joinInvite({ code: CODE, rename: ON, pin: A.pin, now: NOW }, j.deps)).ok).toBe(false);
      expect(calls).toBe(1); expect(j.writes()).toBe(0);
    }
  });
});
