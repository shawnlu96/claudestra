/** SIGCOMP1 uses synthetic keys and the test preload's private state only. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { openLedger } from "../src/lib/ledger-store.js";
import * as ledgerStore from "../src/lib/ledger-store.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";

// Keep real sample writes out of the shared preload ledger so later suites see their own fixtures only.
let restoreLedger: () => void;
beforeAll(() => {
  const path = tempLedgerPath("signature-contract-"), original = ledgerStore.openLedger, db = original(path);
  const opener = spyOn(ledgerStore, "openLedger").mockImplementation(p => p ? original(p) : db);
  restoreLedger = () => { opener.mockRestore(); ledgerStore.closeLedger(path); };
});
afterAll(() => restoreLedger?.());

// This runs on the unchanged baseline: an unregistered key is forced off instead of observe.
test("[验收线 1] signature contract is registered as a high-risk observe-default mechanism", () => {
  const key = "peerSignatureContract" as Parameters<typeof recoveryPolicy>[1];
  expect(recoveryPolicy("claude-orchestrator", key).mode).toBe("observe");
  expect(highRiskRecoveryKey(key)).toBe(true);
});

test("[验收线 1/2] explicit compatibility matrix preserves the pre-deadline old-family exception", async () => {
  const { signatureContractVerdict } = await import("../src/lib/floka-peer/signature-contract.js");
  expect(signatureContractVerdict({ family: "claudestra", result: "bad", signatureMode: "off", legacy: { allow: true, legacy: true } }))
    .toEqual({ allow: true, legacy: true });
  expect(signatureContractVerdict({ family: "mixed", result: "bad", signatureMode: "off", legacy: { allow: true, legacy: true } }))
    .toEqual({ allow: false, reason: "bad" });
});

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { readConfig, writeConfig } from "../src/lib/config-store.js";
import { LEGACY_PEER_DEADLINE, peerSigVerdict } from "../src/lib/peer-trust.js";
import { signRequestFamily } from "../src/lib/floka-compat/signature/request.js";
import { REQUEST_HEADERS } from "../src/lib/floka-compat/signature/families.js";
import { checkRequest, e2eReceiveFamily, peerHeaders, peerSignatureVerdict } from "../src/lib/floka-peer/signature.js";
import { applySignatureContract, signatureContractVerdict, signatureFamily } from "../src/lib/floka-peer/signature-contract.js";
import { signPeerTransport } from "../src/lib/floka-peer/send.js";
import { recoverPeerSend } from "../src/lib/floka-peer/recovery.js";
import { checkPeerSignature } from "../src/bridge/peer-signature.js";
import { verifyPeerSignature, makeInboundHandler } from "../src/bridge/relay-inbound.js";
import { readPeers, writePeers } from "../src/lib/peers.js";
import { keyFingerprint } from "../src/lib/instance-key.js";
import type { Mode } from "../src/lib/floka-peer/policy.js";

const modes = ["off", "observe", "on"] as const;
const families = ["claudestra", "floka", "mixed"] as const;
const results = ["ok", "bad", "stale", "partial"] as const;
const { privateKey } = generateKeyPairSync("ed25519");
const key = { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
const deadline = Date.parse(LEGACY_PEER_DEADLINE);
const request = { method: "GET", path: "/api/v1/agents", body: "" };
const config = (signature: Mode, relay: Mode = "on", receive: Mode = "on") => ({
  rename: { signature, peerRelayInbound: relay, e2e: { receive, send: "on" } },
});

function headersFor(family: typeof families[number], result: typeof results[number], now: number, req = request) {
  const selected = family === "mixed" ? "claudestra" : family;
  const headers = signRequestFamily(selected, req, key, result === "stale" ? now - 600_000 : now);
  if (result === "bad") headers[REQUEST_HEADERS[selected].sig] = "invalid";
  if (family === "mixed") {
    for (const field of ["key", "ts", "sig"] as const) headers[REQUEST_HEADERS.floka[field]] = headers[REQUEST_HEADERS.claudestra[field]]!;
  }
  if (result === "partial") delete headers[REQUEST_HEADERS[selected].ts];
  return headers;
}

function setMode(mode: Mode) {
  mkdirSync(dirname(RECOVERY_POLICY_PATH), { recursive: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { "claude-orchestrator": { keys: { peerSignatureContract: mode } } } }));
}

async function withRecovery(run: () => void | Promise<void>) {
  const previous = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  try { await run(); }
  finally {
    if (previous) writeFileSync(RECOVERY_POLICY_PATH, previous);
    else rmSync(RECOVERY_POLICY_PATH, { force: true });
  }
}

for (const family of families) for (const signature of modes) for (const recovery of modes) {
  test(`[验收线 2/4] ${family} signature=${signature} contract=${recovery}: crypto, anchors, exact cutoff`, async () => {
    await withRecovery(() => {
      setMode(recovery);
      for (const result of results) for (const now of [deadline - 1, deadline, deadline + 1]) for (const anchored of [false, true]) {
        const headers = headersFor(family, result, now), meta = peerHeaders(headers);
        expect(signatureFamily(meta)).toBe(family);
        const verified = checkRequest(headers, request, config(signature), now);
        const valid = result === "ok" && (family !== "floka" || signature === "on");
        expect(verified.status).toBe(valid ? "ok" : "reject");
        const judgment = verified.status === "ok" ? "ok" : verified.status === "reject" ? verified.reason : "unsigned";
        const trust = peerSigVerdict(judgment, anchored, now, LEGACY_PEER_DEADLINE);
        const input = { family, result: judgment, signatureMode: signature, legacy: trust };
        const allowed = (valid || family === "claudestra" && signature !== "on") && (anchored ? valid : now < deadline);
        const target = signatureContractVerdict(input);
        expect(target.allow).toBe(allowed);
        const actual = peerSignatureVerdict(judgment, meta, anchored, now, config(signature));
        expect(actual).toEqual(target);
        if (actual.allow && !valid) expect(actual.legacy).toBe(true);
      }
    });
  });
}

test("[验收线 2] unsigned requests defer to anchors/deadline and never acquire verified status", async () => {
  await withRecovery(() => {
    for (const mode of modes) {
      setMode(mode);
      for (const anchored of [false, true]) for (const now of [deadline - 1, deadline, deadline + 1]) {
        const actual = peerSignatureVerdict("unsigned", peerHeaders({}), anchored, now, config("on"));
        expect(actual).toEqual(peerSigVerdict("unsigned", anchored, now, LEGACY_PEER_DEADLINE));
        if (actual.allow) expect(actual.legacy).toBe(true);
      }
    }
  });
});

test("[验收线 4] observe reports only decision differences; on intersects baseline; off returns baseline", () => {
  const input = { family: "mixed" as const, result: "bad [synthetic-secret]", signatureMode: "off" as const,
    legacy: { allow: true as const, legacy: true } };
  const observations: string[] = [];
  const observe = (area: string, text: string) => observations.push(`${area}:${text}`);
  expect(applySignatureContract(input, input.legacy, "off", observe)).toBe(input.legacy);
  expect(observations).toHaveLength(0);
  expect(applySignatureContract(input, input.legacy, "observe", observe)).toBe(input.legacy);
  expect(observations).toEqual(["peerSignatureContract:mixed:off:legacy->reject"]);
  expect(applySignatureContract(input, input.legacy, "on", observe).allow).toBe(false);
  const denied = { allow: false as const, reason: "outer gate" };
  for (const mode of modes) {
    expect(applySignatureContract({ ...input, family: "claudestra", result: "ok" }, denied, mode, observe)).toBe(denied);
  }
  // Equal decisions do not produce a misleading tightening sample.
  applySignatureContract(input, denied, "observe", observe);
  expect(observations).toHaveLength(1);
});

test("[验收线 4] one running process rereads contract changes and corrupt-file rollback", async () => {
  await withRecovery(() => {
    const input = { family: "floka" as const, result: "bad", signatureMode: "off" as const, legacy: { allow: true as const, legacy: true } };
    for (const mode of ["observe", "on", "off", "on", "observe"] as const) {
      setMode(mode);
      expect(recoveryPolicy("claude-orchestrator", "peerSignatureContract").mode).toBe(mode);
      expect(applySignatureContract(input, input.legacy).allow).toBe(mode !== "on");
    }
    writeFileSync(RECOVERY_POLICY_PATH, "invalid-json");
    expect(applySignatureContract(input, input.legacy)).toBe(input.legacy);
  });
});

for (const recovery of modes) {
  test(`[验收线 3/4] contract=${recovery}: direct/invite gates retain permissions and unsigned restrictions`, async () => {
    const originalConfig = await readConfig(), originalPeers = await readPeers();
    await withRecovery(async () => {
      try {
        setMode(recovery);
        await writePeers({ httpPeers: [{ name: "contract-peer", fp: keyFingerprint(key.publicKey), publicKey: key.publicKey,
          baseUrl: "https://signature.invalid", addedAt: "2026-01-01" }], pendingInvites: [
          { id: "live", joinSecret: "synthetic", inTokenId: "synthetic", agents: [], url: "https://signature.invalid",
            createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
          { id: "expired", joinSecret: "synthetic", inTokenId: "synthetic", agents: [], url: "https://signature.invalid",
            createdAt: "2020-01-01", expiresAt: "2020-01-02" },
        ] });
        for (const signature of modes) {
          const cfg = await readConfig(); cfg.rename = config(signature).rename; await writeConfig(cfg);
          for (const family of families) for (const result of results) {
            const req = new Request(`https://signature.invalid${request.path}`, { headers: headersFor(family, result, Date.now()) });
            const valid = result === "ok" && (family !== "floka" || signature === "on");
            expect((await checkPeerSignature(req, new URL(req.url), "contract-peer")).allow).toBe(valid);
            const preview = await checkPeerSignature(req, new URL(req.url), "invite:live");
            expect(preview.allow).toBe(valid || family === "claudestra" && signature !== "on");
            expect((await checkPeerSignature(req, new URL(req.url), "invite:expired")).allow).toBe(false);
          }
          for (const method of ["GET", "HEAD", "POST"]) {
            const req = new Request("https://signature.invalid/api/v1/agents", { method });
            expect((await checkPeerSignature(req, new URL(req.url), "invite:live")).allow).toBe(method !== "POST");
            expect((await checkPeerSignature(req, new URL(req.url), "contract-peer")).allow).toBe(false);
          }
        }
      } finally {
        const cfg = await readConfig(); cfg.rename = originalConfig.rename; await writeConfig(cfg); await writePeers(originalPeers);
      }
    });
  });

  test(`[验收线 3/4] contract=${recovery}: relay and E2E failures never reach transport or select an anonymous family`, async () => {
    await withRecovery(async () => {
      setMode(recovery);
      let forwards = 0;
      for (const signature of modes) for (const relay of modes) for (const receive of modes) {
        const cfg = config(signature, relay, receive), now = Date.now();
        for (const family of families) for (const result of results) {
          const headers = headersFor(family, result, now);
          const frame = { ...request, headers, body: new Uint8Array() };
          const valid = result === "ok" && (family !== "floka" || signature === "on" && relay === "on");
          expect(verifyPeerSignature(keyFingerprint(key.publicKey), frame, now, cfg) === null).toBe(valid);
          const req = new Request(`https://signature.invalid${request.path}`, { headers });
          const e2e = e2eReceiveFamily(req, frame.body, cfg);
          expect(e2e !== null).toBe(result === "ok" && (family !== "floka" || signature === "on" && receive === "on"));
          if (valid) continue;
          const inbound = makeInboundHandler({ rename: cfg, webBase: "https://unused.invalid", ingressBase: () => "https://unused.invalid",
            now: () => now, refusePeer: async () => { throw new Error("invalid signature reached permission check"); },
            fetchImpl: (async () => { forwards++; return new Response(); }) as unknown as typeof fetch });
          await expect(inbound({ ...request, headers, body: new Response("").body! }, { from: keyFingerprint(key.publicKey), signal: new AbortController().signal }))
            .rejects.toMatchObject({ code: "bad_signature" });
        }
      }
      expect(forwards).toBe(0);
    });
  });

  test(`[验收线 3] contract=${recovery}: outgoing failures cannot be stripped, re-signed, retried or sent as plaintext`, async () => {
    await withRecovery(async () => {
      setMode(recovery);
      for (const family of families) for (const result of ["bad", "stale", "partial"] as const) {
        const now = Date.now(), headers = headersFor(family, result, now), before = { ...headers };
        for (const base of ["https://signature.invalid", `relay://${keyFingerprint(key.publicKey)}`]) {
          for (const path of [request.path, "/api/v1/peers/redeem", "/api/v1/e2e/hello"]) {
            await expect(signPeerTransport(`${base}${path}`, request.method, request.body, headers,
              { key, now, config: config("on"), peers: [] })).rejects.toThrow("Invalid outgoing signature family");
            expect(headers).toEqual(before);
          }
        }
        for (const code of ["peer_signature", "bad_signature", "e2e_signature"]) {
          let sends = 0;
          const response = await recoverPeerSend("https://signature.invalid", headers, async () => {
            sends++; expect(headers).toEqual(before); return Response.json({ code, reason: "bad" }, { status: 401 });
          }, { pin: null });
          expect(response.status).toBe(401); expect(sends).toBe(1); expect(headers).toEqual(before);
        }
      }
    });
  });
}

import { generateEcdh } from "../src/lib/e2e/primitives.js";
import { signE2eKey } from "../src/lib/e2e-machine-key.js";
import { createE2eOutbound } from "../src/lib/peer-e2e-outbound.js";
import { PeerCapabilities, advertisePeer, pinOf } from "../src/lib/floka-peer/capability.js";
import type { HttpPeer } from "../src/lib/peers.js";

async function identity() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const key = { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
  const pair = await generateEcdh(), fp = keyFingerprint(key.publicKey);
  return { key, fp, machine: { pair, ts: 1 }, signed: signE2eKey(key, pair.pub, 1, Math.floor(Date.now() / 1000)) };
}

test("[验收线 3] real E2E outbound signature rejection makes exactly one encrypted hello attempt", async () => {
  const [local, remote] = await Promise.all([identity(), identity()]);
  await withRecovery(async () => {
    for (const mode of modes) for (const family of ["claudestra", "floka"] as const) for (const scheme of ["https", "relay"]) {
      setMode(mode);
      const cfg = { rename: { ...config("on").rename, peerRequestSend: "on" } };
      const peer: HttpPeer = { name: "remote", fp: remote.fp, instanceId: "remote-instance", publicKey: remote.key.publicKey,
        addedAt: "2026-01-01", baseUrl: scheme === "relay" ? `relay://${remote.fp}` : "https://signature.invalid",
        e2e: { idk: remote.key.publicKey, ek: remote.signed } };
      const capabilities = new PeerCapabilities();
      if (family === "floka") expect(capabilities.admit(advertisePeer(remote, cfg, peer.instanceId), pinOf(peer)!)).toBe(true);
      const outbound = createE2eOutbound({ local: async () => local, peers: async () => [peer], rename: cfg, capabilities,
        pin: async () => { throw new Error("rejection must not pin"); } });
      const attempts: string[] = [];
      await expect(outbound.fetch(`${peer.baseUrl}/api/v1/agents`, { method: "GET", headers: { authorization: "Bearer synthetic" } },
        async (url, init) => {
          attempts.push(url);
          expect(url).toEndWith("/api/v1/e2e/hello");
          expect(signatureFamily(peerHeaders(init.headers))).toBe(family);
          return Response.json({ code: "e2e_signature" }, { status: 401 });
        })).rejects.toBeDefined();
      expect(attempts).toHaveLength(1);
    }
  });
});

test("[验收线 2] mixed conflicts, split headers and empty values remain failures in every mode", async () => {
  await withRecovery(() => {
    const now = deadline - 1, good = headersFor("mixed", "ok", now);
    for (const mode of modes) for (const upstream of modes) {
      setMode(mode);
      for (const field of ["key", "ts", "sig"] as const) {
        const conflict = { ...good, [REQUEST_HEADERS.floka[field]]: "conflict" };
        const empty = { [REQUEST_HEADERS.floka[field]]: "" };
        const split = { [REQUEST_HEADERS.claudestra.key]: key.publicKey, [REQUEST_HEADERS.floka.sig]: good[REQUEST_HEADERS.floka.sig]! };
        for (const headers of [conflict, empty, split]) {
          expect(checkRequest(headers, request, config(upstream), now).status).toBe("reject");
          expect(peerSignatureVerdict("bad", peerHeaders(headers), false, now, config(upstream)).allow).toBe(false);
        }
      }
    }
  });
});

const contractSamples = () => openLedger().query<{ data: string }, []>(
  "SELECT data FROM events WHERE kind='note' AND json_extract(data, '$.mechanism')='peerSignatureContract' ORDER BY seq",
).all().map(row => JSON.parse(row.data));

test("[PM 补] the default sink persists only observe differences, with bounded data and deduplication", () => {
  const input = { family: "mixed" as const, result: "bad synthetic-secret", signatureMode: "observe" as const,
    legacy: { allow: true as const, legacy: true } };
  const before = contractSamples().length;
  expect(applySignatureContract(input, input.legacy, "off")).toBe(input.legacy);
  expect(applySignatureContract(input, input.legacy, "on")).toEqual({ allow: false, reason: input.result });
  const denied = { allow: false as const, reason: "outer gate" };
  expect(applySignatureContract(input, denied, "observe")).toBe(denied);
  expect(contractSamples()).toHaveLength(before);
  for (let n = 0; n < 2; n++) expect(applySignatureContract(input, input.legacy, "observe")).toBe(input.legacy);
  const samples = contractSamples().slice(before);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ op: "recovery_observe", mechanism: "peerSignatureContract", verdict: "mixed:observe:legacy->reject" });
  expect(JSON.stringify(samples)).not.toContain("synthetic-secret");
});

test("[PM 补] a failed real ledger write preserves the exact authentication verdict and emits a safe diagnostic", () => {
  const db = openLedger(), before = contractSamples().length;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const input = { family: "floka" as const, result: "bad synthetic-secret", signatureMode: "on" as const,
    legacy: { allow: true as const, legacy: true } };
  db.exec("PRAGMA query_only = ON");
  try {
    expect(applySignatureContract(input, input.legacy, "observe")).toBe(input.legacy);
    expect(applySignatureContract(input, input.legacy, "on")).toEqual({ allow: false, reason: input.result });
    expect(applySignatureContract(input, input.legacy, "off")).toBe(input.legacy);
    expect(contractSamples()).toHaveLength(before);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]).toEqual(["[floka-peer] peerSignatureContract sample write failed; authentication unchanged"]);
  } finally { db.exec("PRAGMA query_only = OFF"); warning.mockRestore(); }
});

test("[PM 补] the persistent sink and the pre-fix log-only sink produce identical authentication judgments", () => {
  for (const family of [...families, "none"] as const) for (const result of results) for (const signatureMode of modes) {
    for (const mode of modes) for (const legacy of [
      { allow: true as const, legacy: true }, { allow: true as const, legacy: false }, { allow: false as const, reason: "outer gate" },
    ]) {
      const input = { family, result, signatureMode, legacy };
      const persisted = applySignatureContract(input, legacy, mode);
      const logOnly = applySignatureContract(input, legacy, mode, () => {});
      expect(persisted).toEqual(logOnly);
      if (mode !== "on") expect(persisted).toBe(legacy);
      if (!legacy.allow) expect(persisted).toBe(legacy);
    }
  }
});
