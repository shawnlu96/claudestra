import { describe, expect, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { SharedLedgerProjectConflict } from "../src/lib/shared-ledger-client-projects.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { V2_PROJECTS_SUCCESS_STATUS } from "../src/lib/shared-ledger-contract-v2-projects.js";
import { fixtures, invitationCode, key, owner, protocol } from "./shared-ledger-client-projects-fixture.test.js";

const f = fixtures();
const create = { operationId: f.operation.operationId, name: f.project.name, id: f.identity.projectId };
const recover = { operationId: create.operationId, rev: f.operation.rev };
const update = { rev: f.project.rev, name: f.requests.update.name, status: "archived" as const };
const invite = { personId: f.invite.personId };
function client(body: unknown, status = 200) {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json(body, { status }); }) as unknown as typeof fetch;
  return { client: new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol }), calls: () => calls };
}
async function failure(action: Promise<unknown>): Promise<Error> {
  try { await action; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error("expected failure");
}
function requests(c: SharedLedgerClient<typeof protocol>) {
  return [() => c.projects(), () => c.createProject(create), () => c.updateProject(f.identity.projectId, update),
    () => c.projectMembers(f.identity.projectId), () => c.inviteProjectMember(f.identity.projectId, invite),
    () => c.removeProjectMember(f.identity.projectId, invite.personId), () => c.projectOperation(create.operationId),
    () => c.recoverProjectCreatorCredential(f.identity.projectId, recover)];
}

describe("N3 fixed public N1C producer with injected signed transport", () => {
  test("all eight methods round-trip producer DTOs, HTTP statuses, signatures and fresh nonces", async () => {
    const signingKey = key();
    const root = `/v1/projects/${f.identity.projectId}`;
    const cases = [
      ["list", "GET", "/v1/projects"], ["create", "POST", "/v1/projects"], ["update", "PATCH", root],
      ["members", "GET", `${root}/members`], ["invite", "POST", `${root}/invites`],
      ["removeMember", "POST", `${root}/members/${invite.personId}/remove`],
      ["operation", "GET", `/v1/projects/operations/${create.operationId}`], ["creatorCredential", "POST", `${root}/creator-credential`],
    ] as const;
    const nonces = new Set<string>();
    let calls = 0;
    const fetcher = (async (url: URL, init: RequestInit) => {
      const [endpoint, method, path] = cases[calls++]!;
      const headers = new Headers(init.headers);
      const h = SHARED_LEDGER_AUTH_HEADERS;
      expect(url.origin).toBe(owner.baseUrl);
      expect(url.pathname).toBe(path);
      expect(init.method).toBe(method);
      expect(init.redirect).toBe("error");
      expect(headers.get("authorization")).toBe(`Bearer ${owner.bearer}`);
      expect(headers.get(h.instance)).toBe(owner.instanceId);
      const nonce = headers.get(h.nonce)!;
      expect(nonce).toMatch(/^[a-f0-9]{48}$/);
      expect(nonces.has(nonce)).toBe(false);
      nonces.add(nonce);
      const body = init.body as string | undefined;
      expect(verifyPurpose(signingKey.publicKey, "claudestra-shared-ledger-v1", [method, path, headers.get(h.ts)!,
        sharedLedgerCredentialHash(body ?? ""), nonce, owner.instanceId, sharedLedgerCredentialHash(owner.bearer)], headers.get(h.sig)!)).toBe(true);
      if (method === "GET") expect(body).toBeUndefined();
      else expect(JSON.parse(body!)).toEqual({ attemptNonce: nonce, payload: f.requests[endpoint] });
      return Response.json(f.responses[endpoint], { status: V2_PROJECTS_SUCCESS_STATUS[endpoint] });
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, signingKey, { fetch: fetcher, projectsProtocol: protocol });
    for (const [index, request] of requests(c).entries()) expect(await request()).toEqual(f.responses[cases[index]![0]]);
    expect(calls).toBe(8);
  });

  test("selection tags reject service/other subjects; missing or replacement protocols make no requests", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    for (const change of [{ kind: "service", projects: [{ projectId: f.identity.projectId, actions: ["project", "import"] }] },
      { localSubject: "person:another" }, { kind: undefined }, { localSubject: undefined }]) {
      const c = new SharedLedgerClient({ ...owner, ...change }, key(), { fetch: fetcher, projectsProtocol: protocol });
      for (const request of requests(c)) await expect(request()).rejects.toThrow("shared ledger projects require owner:self person credential");
    }
    for (const projectsProtocol of [undefined, { ...protocol, parseV2ProjectsResponse: (() => f.responses.list) as typeof protocol.parseV2ProjectsResponse }]) {
      const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol });
      for (const request of requests(c)) await expect(request()).rejects.toThrow("shared ledger projects contract unavailable");
    }
    expect(calls).toBe(0);
  });

  test("producer validates route ids, inputs and scope declarations before fetching", async () => {
    const c = client({});
    for (const projectId of ["../other", "project?x=1", "A", "a".repeat(33), "a/b"]) {
      await expect(c.client.projectMembers(projectId)).rejects.toThrow("invalid shared ledger project request");
    }
    for (const body of [{ ...update, rev: -1 }, { rev: 1 }, { ...update, teamId: "other" },
      { ...update, projectId: "other" }, { ...update, bearer: owner.bearer }]) {
      await expect(c.client.updateProject(f.identity.projectId, body)).rejects.toThrow("invalid shared ledger project request");
    }
    await expect(c.client.projectOperation("../operation")).rejects.toThrow("invalid shared ledger project request");
    await expect(c.client.removeProjectMember(f.identity.projectId, "person/other")).rejects.toThrow("invalid shared ledger project request");
    await expect(c.client.inviteProjectMember(f.identity.projectId, { ...invite, code: "another" }))
      .rejects.toThrow("invalid shared ledger project request");
    for (const declaration of [{ subject: "owner:self" }, { personId: "another" }, { instanceId: "another" }]) {
      await expect(c.client.createProject({ ...create, ...declaration })).rejects.toThrow("invalid shared ledger project request");
      await expect(c.client.recoverProjectCreatorCredential(f.identity.projectId, { ...recover, ...declaration }))
        .rejects.toThrow("invalid shared ledger project request");
    }
    expect(c.calls()).toBe(0);
  });

  test("inviting by code binds the returned member to the requested code", async () => {
    const input = { code: f.responses.invite.member.code };
    expect(await client(f.responses.invite, 201).client.inviteProjectMember(f.identity.projectId, input)).toEqual(f.responses.invite);
    await expect(client(f.responses.invite, 201).client.inviteProjectMember(f.identity.projectId, { code: "other-member" }))
      .rejects.toBeInstanceOf(SharedLedgerUnavailable);
  });

  test("a recovered creation can already have issued its credential; operation queries return no invitations", async () => {
    const operation = { ...f.operation, state: "credential_issued" as const, rev: 2 };
    const response = { ...f.responses.create, operation, creatorInvite: null };
    expect(await client(response, 201).client.createProject(create)).toEqual(response);
    const query = { ...f.responses.operation, operation };
    expect(await client(query).client.projectOperation(create.operationId)).toEqual(query);
    await expect(client({ ...f.responses.creatorCredential, operation }).client.recoverProjectCreatorCredential(f.identity.projectId, recover))
      .rejects.toBeInstanceOf(SharedLedgerUnavailable);
  });

  test("409 retains only typed current records; malformed conflicts keep fixed 409 and do not retry", async () => {
    for (const [body, action] of [[f.errors.projectConflict, (c: SharedLedgerClient<typeof protocol>) => c.updateProject(f.identity.projectId, update)],
      [f.errors.dedupMismatch, (c: SharedLedgerClient<typeof protocol>) => c.createProject(create)],
      [f.errors.operationConflict, (c: SharedLedgerClient<typeof protocol>) => c.recoverProjectCreatorCredential(f.identity.projectId, recover)]] as const) {
      const c = client(body, 409);
      const error = await failure(action(c.client));
      expect(error).toBeInstanceOf(SharedLedgerProjectConflict);
      expect((error as SharedLedgerProjectConflict).current).toEqual(body.current);
      expect(JSON.stringify(error)).not.toContain("current");
      expect(inspect(error)).not.toContain("paramsDigest");
      expect(c.calls()).toBe(1);
    }
    for (const body of [{ code: invitationCode }, { ...f.errors.projectConflict, current: "untyped" },
      { ...f.errors.projectConflict, current: { ...f.project, bearer: owner.bearer } },
      { ...f.errors.projectConflict, current: { ...f.project, projectId: "other" } },
      { ...f.errors.projectConflict, current: { ...f.project, teamId: "other" } }]) {
      const c = client(body, 409);
      const error = await failure(c.client.updateProject(f.identity.projectId, update));
      expect(error).toBeInstanceOf(SharedLedgerRemoteError);
      expect(error).not.toBeInstanceOf(SharedLedgerProjectConflict);
      expect((error as SharedLedgerRemoteError).status).toBe(409);
      expect(inspect(error, { showHidden: true })).not.toContain(invitationCode);
      expect(c.calls()).toBe(1);
    }
  });

  test("invitation codes are memory return values and never logs or exception fields", async () => {
    const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "info"), spyOn(console, "debug")];
    try {
      expect(await client(f.responses.invite, 201).client.inviteProjectMember(f.identity.projectId, invite)).toEqual(f.responses.invite);
      for (const status of [200, 400, 401, 403, 404, 409, 500, 503]) {
        const c = client({ error: invitationCode, bearer: owner.bearer }, status);
        const error = await failure(c.client.inviteProjectMember(f.identity.projectId, invite));
        for (const output of [String(error), error.stack!, JSON.stringify(error), inspect(error, { showHidden: true })]) {
          expect(output).not.toContain(invitationCode);
          expect(output).not.toContain(owner.bearer);
        }
        if ([403, 404].includes(status)) expect(error.message).toBe(`shared ledger rejected (${status})`);
        expect(c.calls()).toBe(1);
      }
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    } finally { for (const log of logs) log.mockRestore(); }
  });

  test("403/404 never decode raw bodies; successful envelopes must have the producer's exact HTTP status", async () => {
    for (const status of [403, 404]) {
      const response = Response.json({ code: invitationCode }, { status });
      const json = spyOn(response, "json");
      const c = new SharedLedgerClient(owner, key(), { projectsProtocol: protocol, fetch: (async () => response) as unknown as typeof fetch });
      await expect(c.projects()).rejects.toThrow(`shared ledger rejected (${status})`);
      expect(json).not.toHaveBeenCalled();
    }
    await expect(client(f.responses.create, 200).client.createProject(create)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client(f.responses.list, 201).client.projects()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
  });

  test("create, recovery and operation queries bind center/team/project/operation/person/instance", async () => {
    for (const field of ["centerId", "teamId", "projectId", "operationId", "personId", "instanceId"] as const) {
      for (const [response, status, action] of [
        [f.responses.create, 201, (c: SharedLedgerClient<typeof protocol>) => c.createProject(create)],
        [f.responses.creatorCredential, 200, (c: SharedLedgerClient<typeof protocol>) => c.recoverProjectCreatorCredential(f.identity.projectId, recover)],
        [f.responses.operation, 200, (c: SharedLedgerClient<typeof protocol>) => c.projectOperation(create.operationId)],
      ] as const) {
        const changed = { ...response, operation: { ...response.operation, [field]: "other" } };
        await expect(action(client(changed, status).client)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
      }
    }
    await expect(client({ ...f.responses.operation, creatorInvite: f.creatorInvite }).client.projectOperation(create.operationId))
      .rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client({ ...f.responses.create, project: { ...f.project, projectId: "other" },
      operation: { ...f.operation, projectId: "other" }, creatorInvite: { ...f.creatorInvite, projectId: "other" } }, 201).client.createProject(create))
      .rejects.toBeInstanceOf(SharedLedgerUnavailable);
  });

  test("all public fixture negative responses reject through the client", async () => {
    for (const probe of fixtures().invalidResponses) {
      const c = client(probe.body, probe.status);
      const index = ["list", "create", "update", "members", "invite", "removeMember", "operation", "creatorCredential"].indexOf(probe.endpoint);
      const error = await failure(requests(c.client)[index]!());
      expect(inspect(error, { showHidden: true })).not.toContain(invitationCode);
      expect(c.calls()).toBe(1);
    }
  });

  test("lost writes make one attempt; explicit retries preserve operation and refresh nonce", async () => {
    const nonces: string[] = [], inputs: unknown[] = [];
    const fetcher = (async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      nonces.push(body.attemptNonce); inputs.push(body.payload);
      throw new Error(invitationCode);
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol, attempts: 9 });
    for (let i = 0; i < 2; i++) await expect(c.createProject(create)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(inputs).toEqual([f.requests.create, f.requests.create]);
    expect(new Set(nonces).size).toBe(2);
    await expect(c.recoverProjectCreatorCredential(f.identity.projectId, recover)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(inputs).toEqual([f.requests.create, f.requests.create, f.requests.creatorCredential]);
  });

  test("a mutable draft cannot change the operation while its response is pending", async () => {
    const draft = { ...create };
    const c = new SharedLedgerClient(owner, key(), { projectsProtocol: protocol, fetch: (async () => {
      draft.operationId = "other"; return Response.json(f.responses.create, { status: 201 });
    }) as unknown as typeof fetch });
    expect((await c.createProject(draft)).operation.operationId).toBe(create.operationId);
  });

  test("transport errors cannot smuggle RemoteError fields", async () => {
    const fetcher = (async () => { throw new SharedLedgerRemoteError(403, { code: invitationCode, bearer: owner.bearer }); }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol });
    expect(inspect(await failure(c.projects()), { showHidden: true })).not.toContain(invitationCode);
  });

  test("abort/timeout release listeners and never retry a write", async () => {
    let calls = 0;
    const fetcher = (async (_url: URL, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error(invitationCode)), { once: true }));
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol, timeoutMs: 10 });
    const controller = new AbortController(); controller.abort();
    await expect(c.createProject(create, controller.signal)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(calls).toBe(0);
    const active = new AbortController(), remove = spyOn(active.signal, "removeEventListener");
    await expect(c.createProject(create, active.signal)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(calls).toBe(1);
    expect(remove).toHaveBeenCalled();
  });
});
