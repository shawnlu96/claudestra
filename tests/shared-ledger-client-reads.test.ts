import { describe, expect, test } from "bun:test";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { EXT_CAPABILITIES_OFF } from "../src/lib/shared-ledger-contract-reads.js";
import {
  SHARED_LEDGER_ACTIVITY_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, SHARED_LEDGER_VERSIONS_FIXTURE,
} from "../src/lib/shared-ledger-contract-fixtures.js";
import { fakeConnection, fakeKey } from "./shared-ledger-client.test.js";

const connection = { ...fakeConnection, teamId: "team-a" };
function client(status: number, body: unknown, paths: string[] = []) {
  const fetcher = (async (url: URL) => { paths.push(url.pathname); return Response.json(body, { status }); }) as unknown as typeof fetch;
  return new SharedLedgerClient(connection, fakeKey(), { fetch: fetcher });
}

describe("SharedLedgerClient add-only reads", () => {
  test("extCapabilities: only 404 maps to all-off; 401/403/409/5xx and bad bodies still fail", async () => {
    expect(await client(404, { error: "not found" }).extCapabilities()).toEqual({ ...EXT_CAPABILITIES_OFF, teamId: "team-a" });
    for (const status of [400, 401, 403, 409]) {
      await expect(client(status, { error: "x" }).extCapabilities()).rejects.toBeInstanceOf(SharedLedgerRemoteError);
    }
    await expect(client(503, {}).extCapabilities()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client(200, { ...SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, uploads: undefined }).extCapabilities()).rejects.toThrow("invalid_field");
    await expect(client(200, { ...SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, teamId: "team-b" }).extCapabilities()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    const paths: string[] = [];
    expect(await client(200, SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, paths).extCapabilities()).toEqual(SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE);
    expect(paths).toEqual(["/v1/teams/team-a/ext-capabilities"]);
  });

  test("the returned all-off value is a copy: callers cannot flip the shared constant", async () => {
    const off = await client(404, {}).extCapabilities();
    off.uploads.projectionExt1 = true;
    expect(EXT_CAPABILITIES_OFF.uploads.projectionExt1).toBe(false);
  });

  test("versions/activity parse strictly; 404 on a data read is not downgraded", async () => {
    const paths: string[] = [];
    expect(await client(200, SHARED_LEDGER_VERSIONS_FIXTURE, paths).versions("feature-a")).toEqual(SHARED_LEDGER_VERSIONS_FIXTURE);
    expect(await client(200, SHARED_LEDGER_ACTIVITY_FIXTURE, paths).activity("feature-a", 5)).toEqual(SHARED_LEDGER_ACTIVITY_FIXTURE);
    expect(paths).toEqual(["/v1/teams/team-a/features/feature-a/versions", "/v1/teams/team-a/features/feature-a/activity/5"]);
    await expect(client(404, {}).versions("feature-a")).rejects.toBeInstanceOf(SharedLedgerRemoteError);
    await expect(client(200, { ...SHARED_LEDGER_ACTIVITY_FIXTURE, items: [{ ...SHARED_LEDGER_ACTIVITY_FIXTURE.items[0]!, text: "原文" }] })
      .activity("feature-a", 0)).rejects.toThrow("invalid_field");
    // A center item at or before the cursor means the center ignored the cursor; do not hand back stale rows.
    await expect(client(200, SHARED_LEDGER_ACTIVITY_FIXTURE).activity("feature-a", 39)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
  });

  test("ids and cursors are validated before any request", async () => {
    const paths: string[] = [];
    const c = client(200, SHARED_LEDGER_ACTIVITY_FIXTURE, paths);
    for (const after of [-1, 1.5, Number.NaN, 2 ** 53]) await expect(c.activity("feature-a", after)).rejects.toThrow("invalid activity cursor");
    await expect(c.versions("../x")).rejects.toThrow("invalid feature id");
    await expect(c.activity("a/b", 0)).rejects.toThrow("invalid feature id");
    expect(paths).toEqual([]);
  });
});
