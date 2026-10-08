/** N9B: N3 team()/updateTeam() over the N9K fixtures with an injected signed transport; no deployed center. */
import { describe, expect, test } from "bun:test";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { SharedLedgerProjectConflict } from "../src/lib/shared-ledger-client-projects.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { createV2ProjectsTeamFixtures } from "../src/lib/shared-ledger-contract-v2-projects-fixtures.js";
import { key, owner, protocol } from "./shared-ledger-client-projects-fixture.test.js";

const t = createV2ProjectsTeamFixtures();
const rename = { rev: t.requests.teamUpdate.rev, name: t.requests.teamUpdate.name };
function client(body: unknown, status = 200, seen: { url: URL; init: RequestInit }[] = []) {
  const fetcher = (async (url: URL, init: RequestInit) => { seen.push({ url, init }); return Response.json(body, { status }); }) as unknown as typeof fetch;
  return new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol });
}
async function failure(action: Promise<unknown>): Promise<Error> {
  try { await action; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error("expected failure");
}

describe("N9B N3 team read and rename", () => {
  test("fixture identities line up with the N3 owner connection", () => {
    expect([t.team.centerId, t.team.teamId, t.self.personId]).toEqual([owner.centerId, owner.teamId, owner.personId]);
  });
  test("team() is a signed GET /v1/team with no body and returns the canonical DTO", async () => {
    const seen: { url: URL; init: RequestInit }[] = [];
    const signingKey = key();
    const fetcher = (async (url: URL, init: RequestInit) => { seen.push({ url, init }); return Response.json(t.responses.team); }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, signingKey, { fetch: fetcher, projectsProtocol: protocol });
    expect(await c.team()).toEqual(t.responses.team);
    const { url, init } = seen[0]!;
    const headers = new Headers(init.headers), h = SHARED_LEDGER_AUTH_HEADERS;
    expect([url.origin, url.pathname, init.method, init.body]).toEqual([owner.baseUrl, "/v1/team", "GET", undefined]);
    expect(verifyPurpose(signingKey.publicKey, "claudestra-shared-ledger-v1", ["GET", "/v1/team", headers.get(h.ts)!,
      sharedLedgerCredentialHash(""), headers.get(h.nonce)!, owner.instanceId, sharedLedgerCredentialHash(owner.bearer)], headers.get(h.sig)!)).toBe(true);
  });
  test("updateTeam() PATCHes /v1/team with only center/team/rev/name; caller cannot add personId or teamRole", async () => {
    const seen: { url: URL; init: RequestInit }[] = [];
    expect(await client(t.responses.teamUpdate, 200, seen).updateTeam(rename)).toEqual(t.responses.teamUpdate);
    expect([seen[0]!.url.pathname, seen[0]!.init.method]).toEqual(["/v1/team", "PATCH"]);
    const payload = JSON.parse(String(seen[0]!.init.body)).payload;
    expect(payload).toEqual({ ...t.team, ...rename });
    for (const extra of [{ personId: t.self.personId }, { teamRole: "owner" }, { name: " " }]) {
      const s: unknown[] = [];
      const error = await failure(client(t.responses.teamUpdate, 200, s as never).updateTeam({ ...rename, ...extra } as typeof rename));
      expect(error.message).toBe("invalid shared ledger team request");
      expect(s).toEqual([]);
    }
  });
  test("self of another person, extra fields and removed rows fail closed as unavailable", async () => {
    const bodies = [
      { ...t.responses.team, self: t.owner },
      { ...t.responses.team, members: [t.owner, { ...t.self, status: "removed" }] },
      { ...t.responses.team, bearer: "DO_NOT_SHOW" },
      ...t.invalidResponses.filter(r => r.endpoint === "team" && r.status === 200).map(r => r.body),
    ];
    for (const body of bodies) {
      const error = await failure(client(body).team());
      expect(error).toBeInstanceOf(SharedLedgerUnavailable);
      expect(String(error)).not.toContain("DO_NOT_SHOW");
    }
  });
  test("old center 404 and 403 reject with status only; no center text retained", async () => {
    for (const [status, body] of [[404, { error: "not found", message: "SECRET_RESPONSE" }], [403, t.errors.forbidden]] as const) {
      const error = await failure(client(body, status).team());
      expect(error).toBeInstanceOf(SharedLedgerRemoteError);
      expect((error as SharedLedgerRemoteError).status).toBe(status);
      expect(JSON.stringify((error as SharedLedgerRemoteError).response)).not.toContain("SECRET_RESPONSE");
    }
    expect(await failure(client({}, 503).team())).toBeInstanceOf(SharedLedgerUnavailable);
  });
  test("teamUpdate 409 carries only the canonical current team record", async () => {
    const error = await failure(client(t.errors.teamConflict, 409).updateTeam(rename));
    expect(error).toBeInstanceOf(SharedLedgerProjectConflict);
    expect((error as SharedLedgerProjectConflict).current).toEqual(t.errors.teamConflict.current);
    const cross = { ...t.errors.teamConflict, current: { ...t.errors.teamConflict.current, teamId: "other-team" } };
    const malformed = await failure(client(cross, 409).updateTeam(rename));
    expect(malformed).not.toBeInstanceOf(SharedLedgerProjectConflict);
    expect((malformed as SharedLedgerRemoteError).status).toBe(409);
  });
  test("team() still requires the owner:self person connection and the fixed producer opt-in", async () => {
    const fetcher = (async () => { throw new Error("must not send"); }) as unknown as typeof fetch;
    const service = new SharedLedgerClient({ ...owner, kind: "service" } as unknown as typeof owner, key(), { fetch: fetcher, projectsProtocol: protocol });
    expect((await failure(service.team())).message).toContain("owner:self person credential");
    const bare = new SharedLedgerClient(owner, key(), { fetch: fetcher });
    expect((await failure(bare.team())).message).toBe("shared ledger projects contract unavailable");
  });
});
