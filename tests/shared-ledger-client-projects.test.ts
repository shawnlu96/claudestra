import { describe, expect, spyOn, test } from "bun:test";
import { inspect } from "node:util";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { SharedLedgerProjectConflict } from "../src/lib/shared-ledger-client-projects.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { envelope, invitationCode, key, owner, project, protocol } from "./shared-ledger-client-projects-fixture.test.js";

const create = { operationId: "fixture-operation", name: "Team Project", id: "project-b" };
const recover = { operationId: create.operationId, fixtureVersion: 1 };
const receipt = { operationId: create.operationId, fixtureVersion: 2, project, code: invitationCode };
function client(body: unknown, status = 200) {
  let calls = 0;
  const fetcher = (async () => { calls++; return Response.json(body, { status }); }) as unknown as typeof fetch;
  return { client: new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol }), calls: () => calls };
}
async function failure(action: Promise<unknown>): Promise<Error> {
  try { await action; } catch (error) { expect(error).toBeInstanceOf(Error); return error as Error; }
  throw new Error("expected failure");
}

describe("N3 project client injection boundary (not N1C wire integration)", () => {
  test("all eight routes sign with the owner person credential and a fresh nonce", async () => {
    const signingKey = key();
    const cases = [
      ["GET", "/v1/projects", envelope([project])],
      ["POST", "/v1/projects", envelope(receipt)],
      ["PATCH", "/v1/projects/project-b", envelope(project, { projectId: "project-b" })],
      ["GET", "/v1/projects/project-b/members", envelope([], { projectId: "project-b" })],
      ["POST", "/v1/projects/project-b/invites", envelope({ code: invitationCode }, { projectId: "project-b" })],
      ["POST", "/v1/projects/project-b/members/fixture-member/remove",
        envelope({ status: "removed" }, { projectId: "project-b", targetPersonId: "fixture-member" })],
      ["GET", "/v1/projects/operations/fixture-operation", envelope({ fixtureVersion: 2, project }, { operationId: create.operationId })],
      ["POST", "/v1/projects/project-b/creator-credential", envelope(receipt, { projectId: "project-b" })],
    ] as const;
    const nonces = new Set<string>();
    const bodies: unknown[] = [];
    let calls = 0;
    const fetcher = (async (url: URL, init: RequestInit) => {
      const [method, path, response] = cases[calls++]!;
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
      else { expect(JSON.parse(body!).fixtureNonce).toBe(nonce); bodies.push(JSON.parse(body!)); }
      return Response.json(response);
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, signingKey, { fetch: fetcher, projectsProtocol: protocol });
    expect(await c.projects()).toEqual([project]);
    expect(await c.createProject(create)).toEqual(receipt);
    expect(await c.updateProject("project-b", { rev: 1, name: "Team Project" })).toEqual(project);
    expect(await c.projectMembers("project-b")).toEqual([]);
    expect(await c.inviteProjectMember("project-b", { personId: "fixture-member" })).toEqual({ code: invitationCode });
    expect(await c.removeProjectMember("project-b", "fixture-member")).toEqual({ status: "removed" });
    expect(await c.projectOperation(create.operationId)).toEqual({ fixtureVersion: 2, project });
    expect(await c.recoverProjectCreatorCredential("project-b", recover)).toEqual(receipt);
    expect(calls).toBe(8);
    expect((bodies[0] as { fixtureInput: unknown }).fixtureInput).toEqual(create);
    expect((bodies[4] as { fixtureInput: unknown }).fixtureInput).toEqual(recover);
  });

  test("service grants, other local subjects and untagged connections never authorize project calls", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    for (const change of [{ kind: "service", projects: [{ projectId: "project-b", actions: ["project", "import"] }] },
      { localSubject: "person:another" }, { kind: undefined }, { localSubject: undefined }]) {
      const c = new SharedLedgerClient({ ...owner, ...change }, key(), { fetch: fetcher, projectsProtocol: protocol });
      for (const request of [() => c.projects(), () => c.createProject(create), () => c.updateProject("project-b", { rev: 1 }),
        () => c.projectMembers("project-b"), () => c.inviteProjectMember("project-b", { personId: "fixture-member" }),
        () => c.removeProjectMember("project-b", "fixture-member"), () => c.projectOperation(create.operationId),
        () => c.recoverProjectCreatorCredential("project-b", recover)]) {
        await expect(request()).rejects.toThrow("shared ledger projects require owner:self person credential");
      }
    }
    await expect(new SharedLedgerClient(owner, key(), { fetch: fetcher }).projects()).rejects.toThrow("shared ledger projects contract unavailable");
    expect(calls).toBe(0);
  });

  test("bad route ids and rejected encoder input fail before fetch", async () => {
    const c = client({});
    for (const projectId of ["../other", "project?x=1", "A", "a".repeat(33), "a/b"]) {
      await expect(c.client.projectMembers(projectId)).rejects.toThrow("invalid shared ledger project request");
    }
    await expect(c.client.projectOperation("../operation")).rejects.toThrow("invalid shared ledger project request");
    await expect(c.client.removeProjectMember("project-b", "person/other")).rejects.toThrow("invalid shared ledger project request");
    await expect(c.client.updateProject("project-b", { rev: -1 })).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(c.calls()).toBe(0);
  });

  test("409 exposes validated current privately; malformed conflicts stay 409 and never retry", async () => {
    const c = client(envelope({ current: project }, { projectId: "project-b" }), 409);
    const error = await failure(c.client.updateProject("project-b", { rev: 1 }));
    expect(error).toBeInstanceOf(SharedLedgerProjectConflict);
    expect((error as SharedLedgerProjectConflict).current).toEqual(project);
    expect(JSON.stringify(error)).not.toContain(project.name);
    expect(inspect(error)).not.toContain(project.name);
    expect(c.calls()).toBe(1);
    for (const body of [{ code: invitationCode }, envelope({ current: { ...project, codeSecret: invitationCode } }, { projectId: "project-b" }),
      envelope({ current: project }, { projectId: "other" })]) {
      const bad = client(body, 409);
      const rejected = await failure(bad.client.updateProject("project-b", { rev: 1 }));
      expect(rejected).toBeInstanceOf(SharedLedgerRemoteError);
      expect((rejected as SharedLedgerRemoteError).status).toBe(409);
      expect(rejected).not.toBeInstanceOf(SharedLedgerProjectConflict);
      expect(inspect(rejected)).not.toContain(invitationCode);
      expect(bad.calls()).toBe(1);
    }
  });

  test("invite codes appear only in successful return values, not logs or exceptions", async () => {
    const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "info"), spyOn(console, "debug")];
    try {
      const success = client(envelope({ code: invitationCode }, { projectId: "project-b" }));
      expect(await success.client.inviteProjectMember("project-b", { personId: "fixture-member" })).toEqual({ code: invitationCode });
      for (const status of [200, 400, 401, 403, 404, 409, 500, 503]) {
        const c = client({ error: invitationCode, bearer: owner.bearer }, status);
        const error = await failure(c.client.inviteProjectMember("project-b", { personId: "fixture-member" }));
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

  test("403/404 bodies are never decoded; rejected parser text is discarded", async () => {
    for (const status of [403, 404]) {
      const response = Response.json({ code: invitationCode }, { status });
      const json = spyOn(response, "json");
      const c = new SharedLedgerClient(owner, key(), { projectsProtocol: protocol, fetch: (async () => response) as unknown as typeof fetch });
      await expect(c.projects()).rejects.toThrow(`shared ledger rejected (${status})`);
      expect(json).not.toHaveBeenCalled();
    }
    const c = new SharedLedgerClient(owner, key(), { projectsProtocol: { ...protocol, responses: { ...protocol.responses,
      invite: () => { throw new Error(invitationCode); } } }, fetch: (async () => Response.json({})) as unknown as typeof fetch });
    expect(inspect(await failure(c.inviteProjectMember("project-b", { personId: "fixture-member" })))).not.toContain(invitationCode);
  });

  test("response scope mismatch, extra bearer, and operation mismatch fail closed", async () => {
    for (const selected of [{ centerId: "other" }, { teamId: "other" }, { personId: "other" }, { instanceId: "other" }]) {
      await expect(client(envelope([project], selected)).client.projects()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    }
    await expect(client(envelope([{ ...project, teamId: "other" }])).client.projects()).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client(envelope({ ...project, id: "other" }, { projectId: "project-b" })).client.updateProject("project-b", { rev: 1 }))
      .rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client(envelope({ fixtureVersion: 2, project, bearer: owner.bearer }, { operationId: create.operationId }))
      .client.projectOperation(create.operationId)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client(envelope({ ...receipt, operationId: "other" })).client.createProject(create)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    await expect(client(envelope(receipt, { projectId: "other" })).client.recoverProjectCreatorCredential("project-b", recover))
      .rejects.toBeInstanceOf(SharedLedgerUnavailable);
  });

  test("lost mutation outcomes make one attempt; explicit retry preserves operation and refreshes nonce", async () => {
    const nonces: string[] = [];
    const inputs: unknown[] = [];
    const fetcher = (async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      nonces.push(body.fixtureNonce); inputs.push(body.fixtureInput);
      throw new Error(invitationCode);
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol, attempts: 9 });
    for (let i = 0; i < 2; i++) await expect(c.createProject(create)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(inputs).toEqual([create, create]);
    expect(new Set(nonces).size).toBe(2);
    await expect(c.recoverProjectCreatorCredential("project-b", recover)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(inputs).toEqual([create, create, recover]);
  });

  test("a mutable caller draft cannot change the operation used to validate a pending response", async () => {
    const draft = { ...create };
    const fetcher = (async () => {
      draft.operationId = "other";
      return Response.json(envelope(receipt));
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol });
    expect((await c.createProject(draft)).operationId).toBe(create.operationId);
  });

  test("transport and encoder errors cannot smuggle arbitrary RemoteError response fields", async () => {
    const secretError = () => { throw new SharedLedgerRemoteError(403, { code: invitationCode, bearer: owner.bearer }); };
    const fetcher = (async () => secretError()) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol });
    expect(inspect(await failure(c.projects()))).not.toContain(invitationCode);
    const encoder = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: { ...protocol,
      requests: { ...protocol.requests, create: secretError } } });
    const error = await failure(encoder.createProject(create));
    expect(error).toBeInstanceOf(SharedLedgerUnavailable);
    expect(inspect(error)).not.toContain(invitationCode);
  });

  test("abort and timeout release listeners and never retry a write", async () => {
    let calls = 0;
    const fetcher = (async (_url: URL, init: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error(invitationCode)), { once: true }));
    }) as unknown as typeof fetch;
    const c = new SharedLedgerClient(owner, key(), { fetch: fetcher, projectsProtocol: protocol, timeoutMs: 10 });
    const controller = new AbortController();
    controller.abort();
    await expect(c.createProject(create, controller.signal)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(calls).toBe(0);
    const active = new AbortController();
    const remove = spyOn(active.signal, "removeEventListener");
    await expect(c.createProject(create, active.signal)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
    expect(calls).toBe(1);
    expect(remove).toHaveBeenCalled();
  });
});
