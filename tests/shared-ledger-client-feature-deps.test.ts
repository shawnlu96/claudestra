import { expect, test } from "bun:test";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { SharedLedgerScrubError } from "../src/lib/shared-ledger-scrub.js";
import { FEATURE_DEPS_UPLOAD_FIXTURE } from "../src/lib/shared-ledger-contract-feature-deps-fixtures.js";
import { fakeKey, fakeConnection } from "./shared-ledger-client.test.js";

const connection = { ...fakeConnection, teamId: "team-a", instanceId: "instance-a" };
const scrub = { identity: { username: "synthetic-user", hostname: "synthetic-host" } };
const body = () => structuredClone(FEATURE_DEPS_UPLOAD_FIXTURE);

test("[验收线 2] upload uses standalone signed POST, canonical payload and a matching receipt", async () => {
  const key = fakeKey(); let calls = 0;
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls++;
    expect(url.pathname).toBe("/v1/teams/team-a/feature-deps"); expect(init.method).toBe("POST");
    const headers = new Headers(init.headers), h = SHARED_LEDGER_AUTH_HEADERS, encoded = String(init.body);
    const wire = JSON.parse(encoded);
    expect(wire.payload).toEqual(body());
    expect(headers.get("authorization")).toBe(`Bearer ${connection.bearer}`);
    expect(verifyPurpose(headers.get(h.key)!, "claudestra-shared-ledger-v1", ["POST", url.pathname, headers.get(h.ts)!,
      sharedLedgerCredentialHash(encoded), wire.attemptNonce, connection.instanceId, sharedLedgerCredentialHash(connection.bearer)], headers.get(h.sig)!)).toBe(true);
    return Response.json({ schemaVersion: 1, accepted: wire.payload.edges.length });
  }) as unknown as typeof fetch;
  const client = new SharedLedgerClient({ ...connection, baseUrl: `https://${crypto.randomUUID()}.invalid` }, key, { fetch: fetcher, scrub });
  expect(await client.uploadFeatureDeps(body())).toEqual({ schemaVersion: 1, accepted: 3 }); expect(calls).toBe(1);
});
test("[验收线 2] wrong team/instance, extra fields and secret values are refused before network", async () => {
  let calls = 0;
  const client = new SharedLedgerClient({ ...connection, baseUrl: `https://${crypto.randomUUID()}.invalid` }, fakeKey(), { scrub,
    fetch: (async () => { calls++; return Response.json({ schemaVersion: 1, accepted: 3 }); }) as unknown as typeof fetch });
  for (const patch of [{ teamId: "other-team" }, { sourceInstanceId: "other-instance" }]) {
    await expect(client.uploadFeatureDeps({ ...body(), ...patch })).rejects.toBeInstanceOf(SharedLedgerUnavailable);
  }
  const extra = { ...body(), edges: [{ ...body().edges[0]!, note: "private" }] };
  await expect(client.uploadFeatureDeps(extra)).rejects.toThrow();
  for (const secret of [connection.bearer, scrub.identity.username, scrub.identity.hostname, "ghp_" + "A".repeat(36)]) {
    const value = body(); value.edges[0]!.from = secret;
    await expect(client.uploadFeatureDeps(value)).rejects.toBeInstanceOf(SharedLedgerScrubError);
  }
  expect(calls).toBe(0);
});
test("[验收线 2] rejects partial/malformed receipts; 403/404/429 remain typed remote errors", async () => {
  for (const answer of [{ schemaVersion: 1, accepted: 2 }, { schemaVersion: 1, accepted: 3, note: "private" }]) {
    const client = new SharedLedgerClient({ ...connection, baseUrl: `https://${crypto.randomUUID()}.invalid` }, fakeKey(), { scrub, fetch: (async () => Response.json(answer)) as unknown as typeof fetch });
    await expect(client.uploadFeatureDeps(body())).rejects.toThrow();
  }
  for (const status of [403, 404, 429]) {
    let calls = 0;
    const client = new SharedLedgerClient({ ...connection, baseUrl: `https://${crypto.randomUUID()}.invalid` }, fakeKey(), { scrub, fetch: (async () => {
      calls++; return new Response("forbidden", { status, headers: { "retry-after": "5" } });
    }) as unknown as typeof fetch });
    try { await client.uploadFeatureDeps(body()); throw new Error("unexpected success"); }
    catch (e) { expect(e).toBeInstanceOf(SharedLedgerRemoteError); expect((e as SharedLedgerRemoteError).status).toBe(status); }
    expect(calls).toBe(1);
  }
});
