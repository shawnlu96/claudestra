import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { authenticateSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash,
  sharedLedgerCommandDigest, type SharedLedgerSignedRequest } from "../src/lib/shared-ledger-auth.js";
import { SHARED_LEDGER_CAPABILITIES, type SharedLedgerCommandResult, type SharedLedgerFeatureList } from "../src/lib/shared-ledger-contract.js";

export function fakeKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: String(publicKey.export({ format: "jwk" }).x) };
}
export const fakeConnection = { centerId: "fake-center", baseUrl: "http://127.0.0.1/", teamId: "fake-team",
  personId: "fake-member", instanceId: "fake-instance", bearer: "obviously-fake-credential" };
export const fakeCommand = { type: "feature.new" as const, requestId: "fake-request", projectId: "fake-project",
  title: "Plan", description: "Team visible", homeInstanceId: "fake-instance" };
export const fakeSnapshot = (serverSeq: number): SharedLedgerFeatureList => ({ schemaVersion: 1, teamId: "fake-team", serverSeq,
  capabilities: SHARED_LEDGER_CAPABILITIES, features: [] });

describe("shared ledger signed client with isolated fake center", () => {
  test("lost response checks receipt; retries preserve request id and refresh nonce/signature", async () => {
    const key = fakeKey();
    const requests: SharedLedgerSignedRequest[] = [];
    const paths: string[] = [];
    let posts = 0;
    const replay = new Set<string>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const h = SHARED_LEDGER_AUTH_HEADERS;
      const signed = { method: req.method, path: new URL(req.url).pathname, body: await req.text(),
        bearer: req.headers.get("authorization")!.slice(7), publicKey: req.headers.get(h.key)!, instanceId: req.headers.get(h.instance)!,
        ts: req.headers.get(h.ts)!, signature: req.headers.get(h.sig)!, attemptNonce: req.headers.get(h.nonce)! };
      authenticateSharedLedgerRequest(signed, { credentialHash: sharedLedgerCredentialHash(fakeConnection.bearer),
        ...fakeConnection, publicKey: key.publicKey, membershipStatus: "active", revokedAt: null, expiresAt: Date.now() + 60000,
        projects: [{ projectId: "fake-project", role: "member", actions: ["read", "plan"] }] },
      { claim: (id) => { if (replay.has(id)) return false; replay.add(id); return true; } }, Date.now());
      paths.push(signed.path); requests.push(signed);
      if (req.method === "GET") return Response.json({ status: "unknown", requestId: fakeCommand.requestId });
      posts++;
      if (posts === 1) return new Response("lost response", { status: 502 });
      return Response.json({ schemaVersion: 1, requestId: fakeCommand.requestId, commandDigest: sharedLedgerCommandDigest(JSON.parse(signed.body)),
        serverSeq: 1, committedAt: 1, result: { featureId: "fake-feature", rev: 1, version: 0 } });
    } });
    try {
      const client = new SharedLedgerClient({ ...fakeConnection, baseUrl: server.url.origin }, key);
      expect((await client.command(fakeCommand)).result.featureId).toBe("fake-feature");
      expect(paths.map((p) => p.split("/").slice(-2).join("/"))).toEqual(["commands/fake-request", "fake-team/commands",
        "commands/fake-request", "fake-team/commands"]);
      const writes = requests.filter((r) => r.method === "POST");
      expect(writes[0]!.signature).not.toBe(writes[1]!.signature);
      expect(writes[0]!.attemptNonce).not.toBe(writes[1]!.attemptNonce);
      expect(JSON.parse(writes[0]!.body).payload).toEqual(JSON.parse(writes[1]!.body).payload);
    } finally { server.stop(true); }
  });
  test("committed receipt recovers without another POST", async () => {
    const receipt: SharedLedgerCommandResult = { schemaVersion: 1, requestId: fakeCommand.requestId,
      commandDigest: sharedLedgerCommandDigest({ attemptNonce: "00".repeat(16), payload: fakeCommand }),
      serverSeq: 1, committedAt: 1, result: { featureId: "fake-feature", rev: 1, version: 0 } };
    const methods: string[] = [];
    const fetcher = (async (_url, options) => { methods.push(options!.method!); return Response.json({ status: "committed", receipt }); }) as typeof fetch;
    expect(await new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher }).command(fakeCommand)).toEqual(receipt);
    expect(methods).toEqual(["GET"]);
  });
  test("offline and receipt lookup loss cannot report success or submit", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error("fake offline"); }) as unknown as typeof fetch;
    await expect(new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher }).command(fakeCommand)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(calls).toBe(1);
  });
  test("timeout rejects; CAS rejection is never retried", async () => {
    const fetcher = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("fake timeout")));
    })) as typeof fetch;
    await expect(new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher, timeoutMs: 10 }).features()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    let posts = 0;
    const conflict = (async (_url, options) => {
      if (options!.method === "GET") return Response.json({ status: "unknown", requestId: fakeCommand.requestId });
      posts++; return Response.json({ code: "pending_proposal", status: 409, message: "fake conflict" }, { status: 409 });
    }) as typeof fetch;
    await expect(new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: conflict }).command(fakeCommand)).rejects.toBeInstanceOf(SharedLedgerRemoteError);
    expect(posts).toBe(1);
  });
});

test("malformed CAS response never retries or changes expectedRev", async () => {
  let posts = 0;
  const command = { type: "feature.set" as const, projectId: "fake-project", featureId: "fake-feature", requestId: "fake-cas",
    expectedRev: 7, patch: { title: "Team plan" } };
  const fetcher = (async (_url, init) => {
    if (init!.method === "GET") return Response.json({ status: "unknown", requestId: command.requestId });
    posts++;
    expect(JSON.parse(init!.body as string).payload.expectedRev).toBe(7);
    return new Response("fake malformed conflict", { status: 409 });
  }) as typeof fetch;
  await expect(new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher }).command(command)).rejects.toBeInstanceOf(SharedLedgerRemoteError);
  expect(posts).toBe(1);
});

test("every upload goes through sensitive gate before any network request", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher });
  await expect(client.command({ ...fakeCommand, description: "fake@example.invalid" })).rejects.toThrow("$.description");
  expect(calls).toBe(0);
});

test("poll stop aborts network request and cannot populate cache", async () => {
  const { SharedLedgerCache } = await import("../src/lib/shared-ledger-cache.js");
  const cache = new SharedLedgerCache<SharedLedgerFeatureList>();
  let signal: AbortSignal | undefined;
  let errors = 0;
  const fetcher = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    signal = init!.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new Error("fake cancelled")));
  })) as typeof fetch;
  const stop = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher }).poll(cache,
    { centerId: "fake-center", teamId: "fake-team", personId: "fake-member", projectId: "fake-project" }, () => { errors++; });
  stop();
  await Promise.resolve(); await Promise.resolve();
  expect(signal!.aborted).toBe(true);
  expect(cache.read()).toBeNull(); expect(errors).toBe(0);
});

test("valid CAS conflict returns the frozen latest DTO without auto resubmission", async () => {
  const { SHARED_LEDGER_CONFLICT_FIXTURE } = await import("../src/lib/shared-ledger-contract-fixtures.js");
  const command = { type: "feature.set" as const, projectId: "project-a", featureId: "feature-a", requestId: "fake-conflict",
    expectedRev: 6, patch: { title: "Team plan" } };
  let posts = 0;
  const fetcher = (async (_url, init) => {
    if (init!.method === "GET") return Response.json({ status: "unknown", requestId: command.requestId });
    posts++; return Response.json(SHARED_LEDGER_CONFLICT_FIXTURE, { status: 409 });
  }) as typeof fetch;
  try { await new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher }).command(command); throw new Error("should reject"); }
  catch (error) { expect((error as SharedLedgerRemoteError).response).toEqual(SHARED_LEDGER_CONFLICT_FIXTURE); }
  expect(posts).toBe(1); expect(command.expectedRev).toBe(6);
});
