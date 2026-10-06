import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { requestSharedLedger } from "../src/lib/shared-ledger-client-transport.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { fixtures, invitationCode, key, owner, protocol } from "./shared-ledger-client-projects-fixture.test.js";

const f = fixtures();

describe("N3 signed transport security with public synthetic fixtures", () => {
  test("body decoding errors cannot retain invitation codes as remote error fields", async () => {
    const response = Response.json({});
    Object.defineProperty(response, "json", { value: async () => {
      throw new SharedLedgerRemoteError(403, { code: invitationCode, bearer: owner.bearer });
    } });
    const client = new SharedLedgerClient(owner, key(), {
      fetch: (async () => response) as unknown as typeof fetch, projectsProtocol: protocol,
    });
    let error: unknown;
    try { await client.projects(); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SharedLedgerUnavailable);
    expect(inspect(error, { showHidden: true })).not.toContain(invitationCode);
    expect(inspect(error, { showHidden: true })).not.toContain(owner.bearer);
  });

  test("malformed center URLs cannot expose their secret through constructor errors", () => {
    for (const baseUrl of [`https://${invitationCode}:private@`, `https://center.invalid/${invitationCode}`,
      `https://center.invalid/?code=${invitationCode}`, `https://center.invalid/#${invitationCode}`]) {
      let error: unknown;
      try { new SharedLedgerClient({ ...owner, baseUrl }, key()); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("invalid center URL");
      expect(inspect(error, { showHidden: true })).not.toContain(invitationCode);
      expect(JSON.stringify(error)).not.toContain(invitationCode);
    }
  });

  test("changing a connection after construction cannot bypass the HTTPS boundary", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json(f.responses.list); }) as unknown as typeof fetch;
    const connection = { ...owner };
    const client = new SharedLedgerClient(connection, key(), { fetch: fetcher, projectsProtocol: protocol });
    for (const baseUrl of ["http://center.invalid", "ftp://center.invalid", `https://${invitationCode}@center.invalid/`,
      "https://center.invalid/private", "https://center.invalid?scope=other"]) {
      connection.baseUrl = baseUrl;
      await expect(client.projects()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    }
    expect(calls).toBe(0);
  });

  test("transport rejects paths that change origin or normalize the signed route", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    for (const path of ["//other.invalid/v1/projects", "https://other.invalid/v1/projects", "/v1/../projects",
      "/v1/projects?other=1", "/v1/projects#other", "/v1/projects/./other", "/v1/projects/\\other"]) {
      await expect(requestSharedLedger(owner, key(), { fetch: fetcher }, "GET", path)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    }
    expect(calls).toBe(0);
  });

  test("clock callbacks cannot change the destination or headers after signing", async () => {
    const connection = { ...owner };
    const signingKey = key();
    let calls = 0;
    const fetcher = (async (url: URL, init: RequestInit) => {
      calls++;
      const h = SHARED_LEDGER_AUTH_HEADERS;
      const headers = new Headers(init.headers);
      expect(url.origin).toBe(owner.baseUrl);
      expect(headers.get("authorization")).toBe(`Bearer ${owner.bearer}`);
      expect(headers.get(h.instance)).toBe(owner.instanceId);
      expect(verifyPurpose(signingKey.publicKey, "claudestra-shared-ledger-v1", ["GET", "/v1/projects", headers.get(h.ts)!,
        sharedLedgerCredentialHash(""), headers.get(h.nonce)!, owner.instanceId, sharedLedgerCredentialHash(owner.bearer)],
      headers.get(h.sig)!)).toBe(true);
      return Response.json(f.responses.list);
    }) as unknown as typeof fetch;
    const client = new SharedLedgerClient(connection, signingKey, { fetch: fetcher, projectsProtocol: protocol, now: () => {
      connection.baseUrl = "http://other.invalid";
      connection.bearer = invitationCode;
      connection.instanceId = "other-instance";
      return Date.now();
    } });
    expect(await client.projects()).toEqual(f.responses.list);
    expect(calls).toBe(1);
  });

  test("transport encoder callbacks cannot substitute destination, credentials, key or fetch port", async () => {
    const connection = { ...owner };
    const signingKey = key();
    const publicKey = signingKey.publicKey;
    let calls = 0, otherCalls = 0;
    const options = { fetch: (async (url: URL, init: RequestInit) => {
      calls++;
      const headers = new Headers(init.headers);
      expect(url.origin).toBe(owner.baseUrl);
      expect(headers.get("authorization")).toBe(`Bearer ${owner.bearer}`);
      expect(headers.get(SHARED_LEDGER_AUTH_HEADERS.instance)).toBe(owner.instanceId);
      expect(headers.get(SHARED_LEDGER_AUTH_HEADERS.key)).toBe(publicKey);
      return Response.json(f.responses.create, { status: 201 });
    }) as unknown as typeof fetch };
    const encode = (nonce: string) => {
      connection.baseUrl = "http://other.invalid";
      connection.bearer = invitationCode;
      connection.personId = "other-person";
      connection.instanceId = "other-instance";
      Object.assign(signingKey, key());
      options.fetch = (async () => { otherCalls++; return Response.json({}); }) as unknown as typeof fetch;
      return JSON.stringify({ attemptNonce: nonce, payload: f.requests.create });
    };
    expect(await requestSharedLedger(connection, signingKey, options, "POST", "/v1/projects", undefined,
      undefined, undefined, encode)).toEqual(f.responses.create);
    expect(calls).toBe(1);
    expect(otherCalls).toBe(0);
  });

  test("a pending response is checked against the original connection, not later caller mutations", async () => {
    const connection = { ...owner };
    const client = new SharedLedgerClient(connection, key(), { projectsProtocol: protocol, fetch: (async () => {
      connection.centerId = "other-center";
      connection.teamId = "other-team";
      connection.personId = "other-person";
      connection.instanceId = "other-instance";
      return Response.json(f.responses.create, { status: 201 });
    }) as unknown as typeof fetch });
    expect(await client.createProject({ operationId: f.operation.operationId, name: f.project.name })).toEqual(f.responses.create);
  });
});
