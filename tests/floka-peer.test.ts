/** Synthetic identities and in-memory requests only; these tests never contact a peer. */
import { expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { generateEcdh } from "../src/lib/e2e/primitives.js";
import { signE2eKey } from "../src/lib/e2e-machine-key.js";
import { keyFingerprint, type InstanceKey } from "../src/lib/instance-key.js";
import { signRequestFamily } from "../src/lib/floka-compat/signature/request.js";
import { serveE2e, type ServeDeps } from "../src/lib/peer-e2e-serve.js";
import { SessionTable } from "../src/lib/peer-e2e-sessions.js";
import { encodeHello, E2E_HELLO_PATH } from "../src/lib/peer-e2e-wire.js";
import { createE2eOutbound } from "../src/lib/peer-e2e-outbound.js";
import { advertisePeer, PeerCapabilities, pinOf, learnPeerCapabilities } from "../src/lib/floka-peer/capability.js";
import { checkRequest } from "../src/lib/floka-peer/signature.js";
import { signPeerTransport } from "../src/lib/floka-peer/send.js";
import { sealRequest } from "../src/lib/floka-compat/e2e/redeem.js";
import { openRedeemRequest, sealRedeemResponse, readRedeemResponse } from "../src/lib/peer-e2e-redeem.js";
import { makeInboundHandler, verifyPeerSignature } from "../src/bridge/relay-inbound.js";
import { ReplayCache, relayPeerRefusal } from "../src/lib/peer-trust.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { readPeers, writePeers } from "../src/lib/peers.js";
import { readConfig, writeConfig } from "../src/lib/config-store.js";
import { readPrincipals, writePrincipals, newTokenPrincipal } from "../src/lib/principals.js";
import { handlePeerRedeem, resetRedeemLimitsForTest } from "../src/bridge/peer-redeem.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { runPeerInviteCommand } from "../src/manager/peers-invite-cli.js";
import { rawCliFetch } from "../src/manager/relay.js";
import { relayControlRoutes } from "../src/bridge/relay-routes.js";
import { setRelayClientForTest } from "../src/bridge/relay-link.js";
import { peerCapabilities } from "../src/lib/floka-peer/capability.js";
import { checkPeerSignature } from "../src/bridge/peer-signature.js";
import type { RelayClient, RelayRequest } from "../src/lib/relay-client.js";
import { ingressRequest } from "../src/bridge/peer-ingress.js";
import { requestContextOf } from "../src/bridge/request-context.js";
import { relayMark } from "../src/bridge/relay-inbound.js";
import { createE2eRoute } from "../src/bridge/peer-e2e-route.js";

const ON = { rename: { signature: "on", peerRequestSend: "on", peerRelayInbound: "on", e2e: { receive: "on", send: "on" } } };
const OFF = { rename: {} };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function machine() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key: InstanceKey = { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
  const pair = await generateEcdh();
  const fp = keyFingerprint(key.publicKey);
  const signed = signE2eKey(key, pair.pub, 1, Math.floor(Date.now() / 1000));
  return { key, pair, fp, signed };
}

async function network() {
  const nodes = await Promise.all([0, 1, 2].map(async n => {
    const m = await machine();
    const local = { key: m.key, fp: m.fp, machine: { pair: m.pair, ts: 1 }, signed: m.signed };
    const rec: HttpPeer = { name: `node-${n}`, instanceId: `instance-${n}`, fp: m.fp, publicKey: m.key.publicKey,
      baseUrl: `https://node-${n}.invalid`, addedAt: "unchanged", outToken: `synthetic-${n}`, e2e: { idk: m.key.publicKey, ek: m.signed } };
    return { ...m, local, rec, config: structuredClone(OFF) as unknown, cache: new PeerCapabilities(), sessions: new SessionTable() };
  }));
  const seen: string[] = [];
  const inbound = nodes.map(target => makeInboundHandler({
    webBase: "http://unused.invalid", ingressBase: () => target.rec.baseUrl!,
    get rename() { return target.config; }, refusePeer: async (fp, req) => relayPeerRefusal(fp, req, {
      contacts: new Set(nodes.map(n => n.fp)), keyOf: key => nodes.find(n => n.fp === key)?.key.publicKey ?? null,
      bearerOwner: () => null,
    }),
    caches: { peer: new ReplayCache(1000, 0), redeem: new ReplayCache(1000, 0) },
    fetchImpl: (async (url: string, init: RequestInit) => serve(target, new Request(url, init))) as typeof fetch,
  }));
  async function serve(target: typeof nodes[number], req: Request): Promise<Response> {
    const body = new Uint8Array(await req.clone().arrayBuffer()), u = new URL(req.url);
    const auth = checkRequest(req.headers, { method: req.method, path: u.pathname + u.search, body }, target.config);
    if (auth.status !== "ok") return new Response(null, { status: 401 });
    const sender = nodes.find(n => n.key.publicKey === auth.publicKey)!;
    seen.push(auth.family);
    return (await serveE2e(req, u.pathname, {
      rename: target.config, capabilities: () => advertisePeer(target.local, target.config, target.rec.instanceId),
      myFp: target.fp, machine: async () => target.local.machine, mySignedKey: async () => target.signed, sessions: target.sessions,
      peerByFp: fp => { const n = nodes.find(n => n.fp === fp); return n ? { name: n.rec.name, fp, idk: n.key.publicKey, ek: n.signed } : null; },
      outerSigned: () => true, pinNewer: async () => { throw new Error("unexpected pin mutation"); },
      dispatch: async inner => {
        const path = new URL(inner.url).pathname + new URL(inner.url).search;
        const v = checkRequest(inner.headers, { method: inner.method, path, body: await inner.text() }, target.config);
        expect(v.status).toBe("ok");
        return Response.json({ ok: true, target: target.rec.name });
      },
    }, { sender: sender.fp, body }))!;
  }
  const outgoing = nodes.map(from => createE2eOutbound({
    local: async () => from.local, peers: async () => nodes.map(n => n.rec),
    get rename() { return from.config; }, capabilities: from.cache, pin: async () => { throw new Error("unexpected pin mutation"); },
  }));
  async function call(i: number, j: number, relayed: boolean) {
    const from = nodes[i], to = nodes[j], path = "/api/v1/agents", method = "GET";
    const headers = await signPeerTransport(`${to.rec.baseUrl}${path}`, method, "", {}, {
      key: from.key, peers: nodes.map(n => n.rec), config: from.config, capabilities: from.cache,
    });
    const result = await outgoing[i].fetch(`${to.rec.baseUrl}${path}`, { method, headers }, async (url, init) => {
      if (!relayed) return serve(to, new Request(url, init));
      const r = await inbound[j]({ method: init.method, path: new URL(url).pathname, headers: init.headers,
        body: new Response(init.body).body! }, { from: from.fp, signal: new AbortController().signal });
      return new Response(r.body, { status: r.status, headers: r.headers });
    });
    expect(await result!.json()).toEqual({ ok: true, target: to.rec.name });
  }
  async function redeem(i: number, j: number) {
    const from = nodes[i], to = nodes[j], pin = pinOf(to.rec)!;
    const family = from.cache.family(pin, from.config, true), path = "/api/v1/peers/redeem";
    const payload = { join: "unchanged-old-invite-secret", iid: from.rec.instanceId, token: "unchanged-token" };
    const sealed = await sealRequest(family, to.pair.pub, to.fp, payload);
    const req = { method: "POST", path, body: JSON.stringify(sealed.body) };
    const headers = signRequestFamily(family, req, from.key);
    expect(verifyPeerSignature(from.fp, { ...req, body: new TextEncoder().encode(req.body), headers }, Date.now(), to.config)).toBeNull();
    const authenticated = checkRequest(headers, req, to.config);
    expect(authenticated.status).toBe("ok");
    if (authenticated.status !== "ok") throw new Error("signature rejected");
    const opened = await openRedeemRequest(to.pair, to.fp, sealed.body, authenticated.family);
    expect(opened?.payload).toEqual(payload);
    const response = await sealRedeemResponse(opened!.session, { ok: true, token: payload.token });
    expect(await readRedeemResponse(sealed.session, 200, response)).toEqual({ ok: true, value: { ok: true, token: payload.token } });
  }
  return { nodes, call, redeem, seen };
}

for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
  test(`[验收线 1] three-instance direct/relay rolling upgrade ${order.join("→")}`, async () => {
    const net = await network(), before = hash(net.nodes.map(n => [n.rec, n.signed]));
    for (const step of [-1, ...order]) {
      if (step >= 0) {
        net.nodes[step].config = structuredClone(ON);
        for (const sender of net.nodes) net.nodes[step].sessions.dropPeer(sender.fp); // receiver process restarts on upgrade
      }
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) {
          await net.call(i, j, round === 1);
          await net.redeem(i, j);
        }
      }
      if (step === -1) expect(new Set(net.seen)).toEqual(new Set(["claudestra"]));
    }
    expect(net.seen).toContain("floka");
    expect(hash(net.nodes.map(n => [n.rec, n.signed]))).toBe(before);
  });
}

test("[验收线 2] relay rejects conflicting signatures and keeps replay protection for the new family", async () => {
  const a = await machine(), request = { method: "POST", path: "/api/v1/agents/a/messages", body: "{}" };
  const headers = signRequestFamily("floka", request, a.key), bytes = new TextEncoder().encode(request.body);
  const old = signRequestFamily("claudestra", request, a.key);
  expect(verifyPeerSignature(a.fp, { ...request, body: bytes, headers: { ...headers, ...old } }, Date.now(), ON)?.code).toBe("bad_signature");
  for (const mode of ["off", "observe"]) {
    expect(verifyPeerSignature(a.fp, { ...request, body: bytes, headers }, Date.now(), {
      rename: { ...ON.rename, peerRelayInbound: mode },
    })?.code).toBe("bad_signature");
  }
  let calls = 0;
  const inbound = makeInboundHandler({ rename: ON, webBase: "http://unused.invalid", ingressBase: () => "http://ingress.invalid",
    refusePeer: async () => null, caches: { peer: new ReplayCache(10, 0), redeem: new ReplayCache(10, 0) },
    fetchImpl: (async () => { calls++; return Response.json({ ok: true }); }) as unknown as typeof fetch });
  const send = () => inbound({ ...request, headers, body: new Response(bytes).body! }, { from: a.fp, signal: new AbortController().signal });
  expect((await send()).status).toBe(200);
  await expect(send()).rejects.toMatchObject({ code: "replay" });
  expect(calls).toBe(1);
});

test("[验收线 3] both CLI signing exits use one family; unknown, expired and restarted capabilities use legacy", async () => {
  const net = await network(), [a, b] = net.nodes, now = Date.now();
  const args = { key: a.key, peers: [b.rec], config: ON, now, capabilities: a.cache };
  const req = { method: "POST", path: "/api/v1/agents/a/messages", body: "{}" };
  const old = signRequestFamily("claudestra", req, a.key, now);
  expect(await signPeerTransport(`${b.rec.baseUrl}${req.path}`, req.method, req.body, {}, args)).toEqual(old);
  const cap = advertisePeer(b.local, ON, b.rec.instanceId, now);
  expect(a.cache.admit(cap, pinOf(b.rec)!, now)).toBe(true);
  for (const scheme of [b.rec.baseUrl!, `relay://${b.fp}`]) {
    const sent = await signPeerTransport(`${scheme}${req.path}`, req.method, req.body, old, args);
    expect(Object.keys(sent).sort()).toEqual(["x-floka-key", "x-floka-sig", "x-floka-ts"]);
    expect(checkRequest(sent, req, ON, now)).toMatchObject({ status: "ok", family: "floka" });
    expect(await signPeerTransport(`${scheme}${req.path}`, req.method, req.body, old, { ...args, config: OFF })).toEqual(old);
  }
  expect(a.cache.family(pinOf(b.rec), ON, true, now + 8 * 86400_000)).toBe("claudestra");
  expect(new PeerCapabilities().family(pinOf(b.rec), ON, true, now)).toBe("claudestra");
  expect(a.cache.admit(cap, pinOf(a.rec)!, now)).toBe(false);
  const conflict = { ...old, ...signRequestFamily("floka", req, a.key, now) };
  await expect(signPeerTransport(`${b.rec.baseUrl}${req.path}`, req.method, req.body, conflict, args)).rejects.toThrow("Invalid outgoing signature family");
});

test("[验收线 2] production redemption rejects wrong labels, conflicting signatures, revoked and expired old invites without retry", async () => {
  const config = await readConfig(), peers = await readPeers(), principals = await readPrincipals();
  const net = await network(), [a, b] = net.nodes;
  const path = "/api/v1/peers/redeem", secret = "old-invite-secret-unchanged-123456789";
  const invitation = { id: "inv_floka_test", joinSecret: secret, inTokenId: "tok_floka_test", agents: ["synthetic"],
    url: b.rec.baseUrl!, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), e2e: true };
  let executions = 0;
  async function manager(...args: string[]) {
    executions++;
    const output: string[] = [], original = console.log;
    console.log = (value: unknown) => { output.push(String(value)); };
    try { await runPeerInviteCommand(args[0], args.slice(1)); }
    finally { console.log = original; }
    return JSON.parse(output.at(-1) ?? "null");
  }
  async function send(wireFamily: "claudestra" | "floka", conflict = false, success = false) {
    const payload = { join: secret, name: a.rec.name, idk: a.key.publicKey, key: a.signed, iid: a.rec.instanceId };
    const sealed = await sealRequest(wireFamily, b.pair.pub, b.fp, payload);
    const input = { method: "POST", path, body: JSON.stringify(sealed.body) };
    const headers = signRequestFamily("floka", input, a.key);
    if (conflict) Object.assign(headers, signRequestFamily("claudestra", input, a.key));
    const req = new Request(`${b.rec.baseUrl}${path}`, { method: input.method, headers, body: input.body });
    setRequestContext(req, { source: "peer-ingress", clientIp: "192.0.2.1", https: true });
    const response = await handlePeerRedeem(req, { runManager: manager, local: async () => b.local });
    if (success) expect(response.status).toBe(200); else expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await readRedeemResponse(sealed.session, response.status, await response.json())).ok).toBe(success);
  }
  try {
    await writeConfig({ ...config, ...ON });
    await writePeers({ httpPeers: [], pendingInvites: [invitation] });
    resetRedeemLimitsForTest();
    await send("claudestra"); // authentic new signature over ciphertext encrypted with the wrong label
    await send("floka", true);
    expect(executions).toBe(0);
    expect((await readPeers()).pendingInvites).toEqual([invitation]);
    await writePeers({ httpPeers: [], pendingInvites: [] }); // canonical revocation removes the pending invitation
    await send("floka");
    expect(executions).toBe(0);
    await writePeers({ httpPeers: [], pendingInvites: [{ ...invitation, expiresAt: new Date(Date.now() - 1000).toISOString() }] });
    await send("floka");
    expect(executions).toBe(1); // canonical manager checks TTL and refuses; no alternate label or plaintext attempt
    expect((await readPeers()).httpPeers).toEqual([]);
    const token = { ...newTokenPrincipal("synthetic-peer", ["synthetic"], { peer: `invite:${invitation.id}` }), id: `token:${invitation.inTokenId}` };
    await writePrincipals({ ...principals, principals: [token] });
    await writePeers({ httpPeers: [], pendingInvites: [invitation] });
    await send("floka", false, true);
    expect(executions).toBe(2);
    expect((await readPeers()).httpPeers?.[0]).toMatchObject({
      fp: a.fp, publicKey: a.key.publicKey, inTokenId: invitation.inTokenId, e2e: a.rec.e2e,
    });
    expect((await readPrincipals()).principals[0].secret).toBe(token.secret);
    expect((await readPeers()).pendingInvites).toEqual([]);
    await send("floka");
    expect(executions).toBe(2);
  } finally {
    await writeConfig(config); await writePeers(peers); await writePrincipals(principals);
    resetRedeemLimitsForTest();
  }
});

test("[验收线 2] invalid signatures never use the unsigned invitation-token exception", async () => {
  const a = await machine(), input = { method: "GET", path: "/api/v1/agents", body: "" };
  const headers = { ...signRequestFamily("claudestra", input, a.key), ...signRequestFamily("floka", input, a.key) };
  const req = new Request(`https://synthetic.invalid${input.path}`, { headers });
  expect((await checkPeerSignature(req, new URL(req.url), "invite:synthetic")).allow).toBe(false);
});

test("[验收线 2] conflicting source marks cannot acquire the loopback cookie exception", async () => {
  const config = await readConfig(), a = await machine();
  let called = 0;
  try {
    await writeConfig({ ...config, ...ON });
    for (const headers of [
      { "x-floka-relay-mark": "forged", "x-floka-relay-from": a.fp },
      { "x-floka-relay-mark": relayMark(), "x-floka-relay-from": a.fp, "x-claudestra-relay-from": a.fp },
      { "x-floka-tunnel-mark": "forged" },
    ] as Record<string, string>[]) {
      const req = new Request("http://127.0.0.1/api/v1/agents", { headers: { ...headers, cookie: "synthetic-device-cookie" } });
      const r = await ingressRequest(req, async () => { called++; return Response.json({ ok: true }); }, "127.0.0.1");
      expect(r.status).toBe(403);
    }
    expect(called).toBe(0);
    const req = new Request("http://127.0.0.1/api/v1/peers/redeem", { method: "POST", body: "{}",
      headers: { "x-floka-relay-mark": relayMark(), "x-floka-relay-from": a.fp } });
    await ingressRequest(req, async inner => {
      expect(requestContextOf(inner).relayFrom).toBe(a.fp);
      expect(inner.headers.has("x-floka-relay-mark")).toBe(false);
      return Response.json({ ok: true });
    }, "127.0.0.1");
  } finally { await writeConfig(config); }
});

test("[验收线 3] off and observe never retain capabilities or mutate identity/peer records", async () => {
  const net = await network(), [a, b] = net.nodes, pin = pinOf(b.rec)!;
  const before = hash([a.rec, b.rec, a.signed, b.signed]);
  const capability = advertisePeer(b.local, ON, b.rec.instanceId);
  for (const mode of ["off", "observe"] as const) {
    const config = { rename: { ...ON.rename, e2e: { receive: mode, send: "on" } } };
    learnPeerCapabilities(capability, pin, a.cache, config);
    expect(a.cache.family(pin, ON, true)).toBe("claudestra");
    expect(a.cache.family(pin, ON)).toBe("claudestra");
  }
  expect(hash([a.rec, b.rec, a.signed, b.signed])).toBe(before);
});

test("[验收线 2] production E2E route applies both live config gates before creating a session", async () => {
  const config = await readConfig(), net = await network(), [a, b] = net.nodes;
  try {
    for (const receive of ["off", "observe", "on"]) for (const signature of ["off", "observe", "on"]) {
      await writeConfig({ ...config, rename: { ...ON.rename, signature, e2e: { receive, send: "off" } } });
      const route = createE2eRoute({ local: async () => b.local, peers: async () => [a.rec],
        pin: async () => { throw new Error("unexpected pin update"); } });
      const ephemeral = await generateEcdh(), path = E2E_HELLO_PATH;
      const body = encodeHello({ from: a.fp, to: b.fp, ce: ephemeral.pub, key: a.signed });
      const headers = signRequestFamily("floka", { method: "POST", path, body }, a.key);
      const req = new Request(`${b.rec.baseUrl}${path}`, { method: "POST", headers, body });
      setRequestContext(req, { source: "peer-ingress", clientIp: "192.0.2.1", https: true });
      const response = await route.route(req, new URL(req.url), async () => { throw new Error("hello cannot dispatch"); });
      expect(response?.status).toBe(receive === "on" && signature === "on" ? 200 : 401);
    }
  } finally { await writeConfig(config); }
});

test("[验收线 1] real rawCliFetch and relayControlRoutes keep exactly one signature family", async () => {
  const config = await readConfig(), peers = await readPeers(), originalFetch = globalThis.fetch;
  const net = await network(), remote = net.nodes[1], path = "/api/v1/agents", captured: Record<string, string>[] = [];
  const fake = {
    info: () => ({ connected: true, state: "online", fp: "synthetic", slug: "unchanged", base: "unchanged" }),
    peers: () => [], request: async (_to: string, req: RelayRequest) => {
      captured.push(req.headers); return { status: 200, headers: {}, body: new Response("{}").body! };
    },
  } as unknown as RelayClient;
  try {
    await writePeers({ httpPeers: [remote.rec] });
    peerCapabilities.admit(advertisePeer(remote.local, ON, remote.rec.instanceId), pinOf(remote.rec)!);
    setRelayClientForTest(fake);
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/relay/request") return relayControlRoutes(new Request(url, init), new URL(url));
      captured.push(Object.fromEntries(new Headers(init.headers)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    for (const mode of ["off", "observe", "on"] as const) {
      await writeConfig({ ...config, rename: { ...ON.rename, peerRequestSend: mode } });
      for (const url of [`${remote.rec.baseUrl}${path}`, `relay://${remote.fp}${path}`]) {
        expect((await rawCliFetch(url, { method: "GET" })).status).toBe(200);
        const headers = captured.at(-1)!;
        expect(checkRequest(headers, { method: "GET", path, body: "" }, ON)).toMatchObject({ status: "ok", family: mode === "on" ? "floka" : "claudestra" });
        expect(Object.keys(headers).filter(k => /-(key|ts|sig)$/.test(k))).toHaveLength(3);
      }
    }
  } finally {
    globalThis.fetch = originalFetch; setRelayClientForTest(null);
    await writeConfig(config); await writePeers(peers);
  }
});

for (const receive of ["off", "observe", "on"] as const) {
  for (const signature of ["off", "observe", "on"] as const) {
    test(`[验收线 2] hello requires receive=${receive} and signature=${signature}`, async () => {
      const [a, b] = await Promise.all([machine(), machine()]);
      const ephemeral = await generateEcdh();
      const body = encodeHello({ from: a.fp, to: b.fp, ce: ephemeral.pub, key: a.signed });
      const request = { method: "POST", path: E2E_HELLO_PATH, body };
      const req = new Request(`https://synthetic.invalid${request.path}`, {
        method: request.method, body, headers: signRequestFamily("floka", request, a.key),
      });
      const sessions = new SessionTable();
      const deps: ServeDeps & { rename: unknown } = {
        rename: { rename: { signature, e2e: { receive, send: "off" } } },
        myFp: b.fp, machine: async () => ({ pair: b.pair, ts: 1 }), mySignedKey: async () => b.signed,
        sessions, peerByFp: fp => fp === a.fp ? { name: "a", fp, idk: a.key.publicKey, ek: a.signed } : null,
        outerSigned: () => true, pinNewer: async () => { throw new Error("same key must not write a pin"); },
        dispatch: async () => { throw new Error("hello cannot dispatch"); },
      };
      const result = await serveE2e(req, request.path, deps, { sender: a.fp });
      const allowed = receive === "on" && signature === "on";
      expect(result?.status).toBe(allowed ? 200 : 401);
      expect(sessions.size).toBe(allowed ? 1 : 0);
    });
  }
}
