import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["plain", "e2e"]) {
  test(`real authenticated ${mode} ingress accepts offer and receipt`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "jn3-ingress-"));
    try {
      const cert = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.crt")], { stdout: "ignore", stderr: "ignore" });
      expect(await cert.exited).toBe(0);
      const script = `
        import assert from "node:assert/strict";
        import { writeFileSync, statSync } from "node:fs";
        import { localE2e } from "./src/lib/peer-e2e-local.ts";
        import { writePeers } from "./src/lib/peers.ts";
        import { newTokenPrincipal, writePrincipals } from "./src/lib/principals.ts";
        import { authenticateApi } from "./src/bridge/api-auth.ts";
        import { createE2eRoute } from "./src/bridge/peer-e2e-route.ts";
        import { setRequestContext } from "./src/bridge/request-context.ts";
        import { handleJoinOfferApi } from "./src/bridge/local-api/shared-ledger-join-offer.ts";
        import { joinOfferLiveDeps } from "./src/bridge/shared-ledger-join-offer.ts";
        import { pendingOfferDir, saveSentOffer } from "./src/lib/shared-ledger-join-offer.ts";
        import { cmdSharedLedgerOffer } from "./src/manager/shared-ledger-offer.ts";
        import { peerCliFetch, peerE2eOnlyFetch } from "./src/manager/relay.ts";
        const dir = process.env.CLAUDESTRA_STATE_DIR, encrypted = process.env.JN3_MODE === "e2e";
        const a = await localE2e(dir), b = await localE2e(dir + "/peer-a");
        const token = newTokenPrincipal("本机", [], { peer: "local" });
        await writePrincipals({ principals: [token] });
        const inbound = { name: "local", baseUrl: "https://local.example", outToken: "fixture", addedAt: "",
          fp: a.fp, publicKey: a.key.publicKey, ...(encrypted ? { e2e: { idk: a.key.publicKey, ek: a.signed } } : {}) };
        const asks = [], notes = [];
        const deps = { ...joinOfferLiveDeps, stateDir: () => dir + "/receiver", peers: async () => [inbound],
          projects: async () => [{ id: "local", name: "local", lastActivityAt: 0 }],
          auth: (req, url) => authenticateApi(req, url, { rateLimit: true }),
          openAsk: input => {
            const a = { ...input, id: "ask_1", state: "open", answer: null, extra: input.extra };
            asks.push(a); return a;
          }, writeNote: async (sent, text) => { notes.push(text); } };
        const route = createE2eRoute({ local: async () => b, peers: async () => [inbound],
          projects: async () => [{ id: "local", name: "local", lastActivityAt: 0 }],
          pin: async () => { throw new Error("unexpected rotation"); } });
        const handle = async req => {
          const url = new URL(req.url);
          return await route.route(req, url, handle) ?? await handleJoinOfferApi(req, url, deps) ?? new Response(null, { status: 404 });
        };
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
          tls: { key: Bun.file(dir + "/tls.key"), cert: Bun.file(dir + "/tls.crt") },
          fetch: req => {
            setRequestContext(req, { source: "loopback", clientIp: "127.0.0.1", https: true });
            return handle(req);
          } });
        try {
          const baseUrl = "https://127.0.0.1:" + server.port;
          const outbound = { name: "peer-a", baseUrl, outToken: token.secret, addedAt: "",
            fp: b.fp, publicKey: b.key.publicKey, ...(encrypted ? { e2e: { idk: b.key.publicKey, ek: b.signed } } : {}) };
          await writePeers({ httpPeers: [outbound, inbound], pendingInvites: [] });
          const code = "sljoin1.center-" + "a".repeat(32) + "." + "b".repeat(32) + "." + "M".repeat(43);
          writeFileSync(dir + "/code", code, { mode: 0o600 });
          const logs = [], log = console.log;
          console.log = (...args) => logs.push(args.map(String).join(" "));
          await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", dir + "/code"], {
            callerProject: async () => "local", projectExists: async () => true });
          console.log = log;
          const result = JSON.parse(logs.at(-1));
          assert.equal(result.status ?? 202, 202);
          assert.equal(result.accepted, true);
          assert.equal(asks.length, 1);
          assert.equal(asks[0].kind, "authorize");
          assert.equal(statSync(pendingOfferDir(dir + "/receiver") + "/" + result.offerId + ".json").mode & 511, 384);
          await saveSentOffer(dir + "/receiver", { offerId: result.offerId, peer: "local", host: "ledger-a.example",
            centerId: "center-" + "a".repeat(32), project: "local", target: "", sentAt: Date.now(), expiresAt: Date.now() + 60000 });
          const url = baseUrl + "/api/v1/shared-ledger-join-offer/receipt";
          const body = JSON.stringify({ v: 1, offerId: result.offerId, status: "joined" });
          const { signedFor } = await import("./src/lib/instance-key.ts");
          const res = await (encrypted ? peerE2eOnlyFetch : peerCliFetch)(url, { method: "POST",
            headers: { Authorization: "Bearer " + token.secret, "Content-Type": "application/json", ...signedFor("POST", url, body) }, body });
          assert.equal(res.status, 200);
          assert.equal(notes.length, 1);
          const visible = JSON.stringify([logs, asks, notes, await res.json()]);
          assert.equal(visible.includes(code), false);
          assert.equal(visible.includes(token.secret), false);
          console.log("passed");
        } finally { server.stop(true); }
      `;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        cwd: process.cwd(), env: { ...process.env, CLAUDESTRA_STATE_DIR: dir, JN3_MODE: mode, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(stdout).toContain("passed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
