import { testChildEnv } from "./test-env.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production offer E2E transport signs the decrypted inner request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jn3-e2e-"));
  try {
    // A fresh process loads the production transport with only temporary configuration.
    const script = `
      const { localE2e } = await import("./src/lib/peer-e2e-local.ts");
      const { writePeers } = await import("./src/lib/peers.ts");
      const { SIG_HEADERS, verifySigned } = await import("./src/lib/instance-key.ts");
      const { serveE2e } = await import("./src/lib/peer-e2e-serve.ts");
      const { SessionTable } = await import("./src/lib/peer-e2e-sessions.ts");
      const { writeFileSync } = await import("node:fs");
      const a = await localE2e(process.env.CLAUDESTRA_STATE_DIR);
      const b = await localE2e(process.env.CLAUDESTRA_STATE_DIR + "/peer-a");
      const peer = { name: "peer-a", baseUrl: "http://peer-a.example", outToken: "test-peer-a", addedAt: "",
        fp: b.fp, e2e: { idk: b.key.publicKey, ek: b.signed } };
      await writePeers({ httpPeers: [peer] });
      let handled = 0, valid = false, encrypted = 0;
      const check = (req, body, key) => verifySigned(key, { method: req.method,
        path: new URL(req.url).pathname, ts: req.headers.get(SIG_HEADERS.ts) ?? "",
        sig: req.headers.get(SIG_HEADERS.sig) ?? "", body }) === "ok";
      const deps = { myFp: b.fp, machine: async () => b.machine, mySignedKey: async () => b.signed,
        sessions: new SessionTable(), peerByFp: fp => fp === a.fp ?
          { name: "本机", fp: a.fp, idk: a.key.publicKey, ek: a.signed } : null,
        pinNewer: async () => { throw new Error("unexpected rotation"); }, outerSigned: check,
        dispatch: async req => {
          handled++;
          const body = await req.text();
          valid = req.headers.get(SIG_HEADERS.key) === a.key.publicKey && check(req, body, a.key.publicKey);
          return Response.json({ ok: valid }, { status: valid ? 202 : 403 });
        } };
      globalThis.fetch = async (url, init) => {
        const req = new Request(url, init);
        encrypted++;
        return await serveE2e(req, new URL(req.url).pathname, deps, { sender: a.fp });
      };
      const file = process.env.CLAUDESTRA_STATE_DIR + "/code";
      writeFileSync(file, "sljoin1.center-" + "a".repeat(32) + "." + "b".repeat(32) + "." + "M".repeat(43), { mode: 0o600 });
      const { cmdSharedLedgerOffer } = await import("./src/manager/shared-ledger-offer.ts");
      await cmdSharedLedgerOffer(["--peer", "peer-a", "--url", "https://ledger-a.example/", "--code-file", file], {
        callerProject: async () => "local", projectExists: async () => true });
      console.log(JSON.stringify({ handled, valid, encrypted }));
    `;
    const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: process.cwd(), env: testChildEnv({ HOME: dir, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime"), DISCORD_CHANNEL_ID: "" }), stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ handled: 1, valid: true, encrypted: 2 });
    expect(lines[0]).toMatchObject({ ok: true, accepted: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
