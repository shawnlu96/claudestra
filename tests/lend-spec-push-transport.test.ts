import { expect, test } from "bun:test";
import { peerFetch } from "../src/bridge/relay-link.js";
import { sendLendRelay } from "../src/bridge/lend-relay-send.js";
import type { HttpPeer } from "../src/lib/peers.js";
const peer = { name: "fixture", baseUrl: "https://fixture.invalid", outToken: "placeholder",
  publicKey: "placeholder", e2e: {} } as HttpPeer;

test("relay-early-ack: pending HTTP cannot acknowledge delivery", async () => {
  let release!: (r: Response) => void;
  let settled = false;
  const pending = sendLendRelay(peer, "lend-0123456789", "fixture supplement", {
    fetch: () => new Promise<Response>((r) => { release = r; }), authenticated: () => true,
  }).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 20));
  expect(settled).toBe(false);
  release(Response.json({ ok: false }, { status: 503 }));
  expect(await pending).toEqual({ ok: false, error: "远端回执 503", maybeSent: false });
});

test("relay-e2e-required: legacy peer cannot receive plaintext supplement", async () => {
  let calls = 0;
  const result = await sendLendRelay({ ...peer, e2e: undefined }, "lend-0123456789", "fixture supplement", {
    fetch: async () => { calls++; return Response.json({ ok: true }, { status: 202 }); }, authenticated: () => true,
  });
  expect(calls).toBe(0);
  expect(result.ok).toBe(false);
});

test("relay-e2e-required: final transport receives e2eOnly even after target changes", async () => {
  const result = await sendLendRelay(peer, "lend-0123456789", "fixture supplement", {
    fetch: async (_url, _init, opts) => {
      expect(opts?.e2eOnly).toBe(true);
      throw new Error("target changed; E2E refused");
    }, authenticated: () => true,
  });
  expect(result).toMatchObject({ ok: false, maybeSent: true });
});

test("relay-early-ack: authenticated acceptance succeeds; unreadable or unauthenticated receipt is unknown", async () => {
  for (const authenticated of [true, false]) {
    const result = await sendLendRelay(peer, "lend-0123456789", "fixture supplement", {
      fetch: async () => Response.json({ ok: true }, { status: 202 }), authenticated: () => authenticated,
    });
    expect(result).toMatchObject(authenticated ? { ok: true } : { ok: false, maybeSent: true });
  }
  expect(await sendLendRelay(peer, "lend-0123456789", "fixture supplement", {
    fetch: async () => new Response("invalid", { status: 202 }), authenticated: () => true,
  })).toMatchObject({ ok: false, maybeSent: true });
});

test("relay-e2e-required: real peerFetch refuses removed E2E record before raw fetch", async () => {
  let plaintext = false;
  const result = await sendLendRelay(peer, "lend-0123456789", "fixture supplement", {
    fetch: (url, init, opts) => peerFetch(url, init, { ...opts,
      fetchImpl: (async () => { plaintext = true; return Response.json({ ok: true }); }) as unknown as typeof fetch }),
    authenticated: () => true,
  });
  expect(plaintext).toBe(false);
  expect(result).toMatchObject({ ok: false, maybeSent: true });
});
