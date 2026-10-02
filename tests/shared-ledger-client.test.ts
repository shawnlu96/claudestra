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

test("absolute paths after all non-path delimiters are blocked before signing", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher,
    scrub: { identity: { username: "fake-user", hostname: "fake-host" } } });
  for (const prefix of ["", "artifact=", ",", ";", "|", "<", "[", "{", "\n"]) {
    for (const path of ["/srv/private/file", "~/private/file"]) {
      await expect(client.command({ ...fakeCommand, description: prefix + path })).rejects.toThrow("$.description");
    }
  }
  expect(calls).toBe(0);
});

test("missing scrub context derives fresh local identity for all upload methods and fails closed", async () => {
  const { spyOn } = await import("bun:test");
  const os = await import("node:os");
  const { SHARED_LEDGER_IMPORT_FIXTURE, SHARED_LEDGER_PROJECTION_FIXTURE } = await import("../src/lib/shared-ledger-contract-fixtures.js");
  const user = spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), username: "alice" });
  const host = spyOn(os, "hostname").mockReturnValue("fake-alice-host");
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
  try {
    const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher });
    await expect(client.command({ ...fakeCommand, description: "owner alice" })).rejects.toThrow("$.description");
    const imported = structuredClone(SHARED_LEDGER_IMPORT_FIXTURE.payload);
    imported.manifest.features[0]!.description = "owner alice";
    await expect(client.import(imported)).rejects.toThrow("$.manifest.features[0].description");
    const projection = structuredClone(SHARED_LEDGER_PROJECTION_FIXTURE.payload);
    projection.tasks[0]!.specSummary = "owner alice";
    await expect(client.projection(projection)).rejects.toThrow("$.tasks[0].specSummary");
    user.mockImplementation(() => { throw new Error("fake identity lookup failure"); });
    await expect(client.command(fakeCommand)).rejects.toThrow("identity unavailable");
    expect(calls).toBe(0);
  } finally { user.mockRestore(); host.mockRestore(); }
});

test("snapshot regression rebuilds cache and poll warns once", async () => {
  const { SharedLedgerCache } = await import("../src/lib/shared-ledger-cache.js");
  const { SharedLedgerRollback } = await import("../src/lib/shared-ledger-client.js");
  const cache = new SharedLedgerCache<SharedLedgerFeatureList>();
  const identity = { centerId: "fake-center", teamId: "fake-team", personId: "fake-member", projectId: "fake-project" };
  cache.store(cache.select(identity), fakeSnapshot(10), 10);
  const warnings: unknown[] = [];
  const fetcher = (async () => Response.json(fakeSnapshot(9))) as unknown as typeof fetch;
  const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher });
  let stop = client.poll(cache, identity, (warning) => warnings.push(warning));
  await new Promise((resolve) => setTimeout(resolve, 1));
  stop();
  expect(cache.read()?.serverSeq).toBe(9);
  expect(cache.read()?.rollback).toBe(true);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toBeInstanceOf(SharedLedgerRollback);
  stop = client.poll(cache, identity, (warning) => warnings.push(warning));
  await new Promise((resolve) => setTimeout(resolve, 1));
  stop();
  expect(cache.read()?.rollback).toBe(false);
  expect(warnings).toHaveLength(1);
});

test("import upload blocks Unicode absolute paths and permits prose, URLs and relative globs", async () => {
  const { SHARED_LEDGER_IMPORT_FIXTURE } = await import("../src/lib/shared-ledger-contract-fixtures.js");
  const { sharedLedgerManifestDigest } = await import("../src/lib/shared-ledger-contract-transfer.js");
  let uploads = 0;
  const fetcher = (async (_url, init) => {
    uploads++;
    const payload = JSON.parse(init!.body as string).payload;
    return Response.json({ schemaVersion: 1, mode: payload.mode, batchId: payload.batchId,
      manifestDigest: payload.manifestDigest, serverSeq: 1, mappings: [] });
  }) as typeof fetch;
  const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher,
    scrub: { identity: { username: "fake-user", hostname: "fake-host" } } });
  const imported = (description: string) => {
    const payload = structuredClone(SHARED_LEDGER_IMPORT_FIXTURE.payload);
    payload.manifest.features[0]!.description = description;
    payload.manifestDigest = sharedLedgerManifestDigest(payload.manifest);
    return payload;
  };
  for (const description of ["artifact=/秘密", "「/秘密/x」", "/données/a", "x=~/私人"]) {
    await expect(client.import(imported(description))).rejects.toThrow("$.manifest.features[0].description");
  }
  expect(uploads).toBe(0);
  for (const description of ["and/or", "1/2", "https://example.com/a/b", "src/lib/*.ts"]) {
    expect((await client.import(imported(description))).mode).toBe("dry-run");
  }
  expect(uploads).toBe(4);
});

test("import globs use strict relative syntax and cannot carry embedded absolute paths", async () => {
  const { SHARED_LEDGER_IMPORT_FIXTURE } = await import("../src/lib/shared-ledger-contract-fixtures.js");
  const { createHash } = await import("node:crypto");
  const { canonicalJson } = await import("../src/lib/ask-bind.js");
  let uploads = 0;
  const fetcher = (async (_url, init) => {
    uploads++;
    const payload = JSON.parse(init!.body as string).payload;
    return Response.json({ schemaVersion: 1, mode: payload.mode, batchId: payload.batchId,
      manifestDigest: payload.manifestDigest, serverSeq: 1, mappings: [] });
  }) as typeof fetch;
  const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher,
    scrub: { identity: { username: "fake-user", hostname: "fake-host" } } });
  const imported = (glob: string) => {
    const payload = structuredClone(SHARED_LEDGER_IMPORT_FIXTURE.payload);
    payload.manifest.features[0]!.versions[0]!.nodes[0]!.fileGlobs = [glob];
    payload.manifestDigest = createHash("sha256").update(canonicalJson(payload.manifest)).digest("hex");
    return payload;
  };
  for (const glob of ["src/**,/秘密", "src/**,/srv/x", "{/srv,src}/x", "src/../etc", "~/x", "/abs",
    "src//x", "src/[/srv]/x", "src/{a,../etc}"]) {
    await expect(client.import(imported(glob))).rejects.toThrow("$.manifest.features[0].versions[0].nodes[0].fileGlobs[0]");
  }
  expect(uploads).toBe(0);
  for (const glob of ["src/lib/*.ts", "src/**/file.ts", "src/{a,b}/x.ts", "tests/[ab]*.test.ts"]) {
    expect((await client.import(imported(glob))).mode).toBe("dry-run");
  }
  expect(uploads).toBe(4);
});
