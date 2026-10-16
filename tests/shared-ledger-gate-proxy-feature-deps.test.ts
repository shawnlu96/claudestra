/** TEAMDEPS1b [验收线 3]: the feature-deps read through the real bridge proxy and client against a synthetic loopback center. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSharedLedgerApi, type SharedLedgerProxyDeps } from "../src/bridge/local-api/shared-ledger.js";
import { sharedLedgerGateProxy, SHARED_LEDGER_PROJECT_HEADER } from "../src/lib/shared-ledger-gate-proxy.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCredentialHash } from "../src/lib/shared-ledger-auth.js";
import { verifyPurpose } from "../src/lib/instance-signature.js";
import { SharedLedgerClient, SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { FEATURE_DEPS_INVALID_UPLOADS, FEATURE_DEPS_OLD_CENTER_STATUS, FEATURE_DEPS_READ_FIXTURE } from "../src/lib/shared-ledger-contract-feature-deps-fixtures.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import type { Principal } from "../src/lib/principals.js";

const pair = generateKeyPairSync("ed25519");
const key: InstanceKey = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const bearer = "synthetic-feature-deps-bearer";
const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-10-04T00:00:00Z" } as Principal;
const planner = { ...owner, id: "guest:planner", role: "external" } as Principal;
const otherProject = { ...owner, id: "guest:project-b", role: "external" } as Principal;
const OTHER = { projectId: "project-b", from: "feature-x", to: "feature-y", kind: "declared" as const, satisfied: true, count: 1 };
const MIXED = { ...FEATURE_DEPS_READ_FIXTURE, edges: [...FEATURE_DEPS_READ_FIXTURE.edges, OTHER] };
type Mode = "new" | "old403" | "old404";
const center = { mode: "new" as Mode, body: MIXED as unknown, paths: [] as string[] };
let root: string, server: ReturnType<typeof Bun.serve>, deps: SharedLedgerProxyDeps;

function authentic(req: Request, path: string): boolean {
  const h = SHARED_LEDGER_AUTH_HEADERS, auth = req.headers.get("authorization") ?? "";
  const fields = [req.method, path, req.headers.get(h.ts)!, sharedLedgerCredentialHash(""), req.headers.get(h.nonce)!,
    req.headers.get(h.instance)!, sharedLedgerCredentialHash(auth.slice(7))];
  return auth === `Bearer ${bearer}` && req.headers.get(h.key) === key.publicKey
    && verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", fields, req.headers.get(h.sig) ?? "");
}
function answer(resource: string): Response {
  if (resource !== "feature-deps") return Response.json({ error: "not found" }, { status: 404 });
  // The deployed center falls through to forbidden; one measured after SUBDAG9a answers 404 for unimplemented reads.
  if (center.mode === "old403") return Response.json({ code: "forbidden", status: 403, message: "forbidden" }, { status: FEATURE_DEPS_OLD_CENTER_STATUS });
  if (center.mode === "old404") return Response.json({ code: "not_found", status: 404, message: "not found" }, { status: 404 });
  return Response.json(center.body);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-gate-feature-deps-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    center.paths.push(`${req.method} ${path}`);
    if (!authentic(req, path)) return Response.json({ code: "bad_signature", status: 401, message: "bad signature" }, { status: 401 });
    return answer(path.replace(/^\/v1\/teams\/team-a\//, ""));
  } });
  const base = { centerId: "center-a", baseUrl: server.url.origin, teamId: "team-a", personId: "alice", instanceId: "instance-alice", bearer, kind: "person" as const };
  await writeSharedLedgerCredential({ ...base, localSubject: owner.id, projects: [{ projectId: "project-a", actions: ["read"] }] }, root);
  await writeSharedLedgerCredential({ ...base, localSubject: planner.id, projects: [{ projectId: "project-a", actions: ["plan"] }] }, root);
  await writeSharedLedgerCredential({ ...base, localSubject: otherProject.id, projects: [{ projectId: "project-b", actions: ["read"] }] }, root);
  writeFileSync(join(root, "shared-ledger-bindings.json"), JSON.stringify([{ centerId: "center-a", teamId: "team-a", projectId: "project-a" }]), { mode: 0o600 });
  deps = { stateDir: root, centerId: "center-a", teamId: "team-a", projectId: "project-a", key,
    scrub: { identity: { username: "nobody-local", hostname: "nobody-host" } } };
});
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

const PATH = "/shared-ledger/feature-deps";
const call = (path: string, principal = owner, query = "", init: RequestInit = {}) =>
  handleSharedLedgerApi(new Request(`http://127.0.0.1/api/v1${path}${query}`, init), path, principal, deps);
const read = async (path = PATH, principal = owner, query = "", init: RequestInit = {}) => {
  const r = (await call(path, principal, query, init))!;
  return { status: r.status, body: await r.json() as unknown };
};
const reset = (mode: Mode, body: unknown = MIXED) => { center.mode = mode; center.body = body; center.paths.length = 0; };

describe("feature-deps read through the bridge proxy", () => {
  test("[验收线 3] GET feature-deps reaches the center once and keeps only this binding's project edges", async () => {
    reset("new");
    expect(await read()).toEqual({ status: 200, body: FEATURE_DEPS_READ_FIXTURE });
    expect(center.paths).toEqual(["GET /v1/teams/team-a/feature-deps"]);
  });

  test("[验收线 3] old center 403 and 404 pass through as that status, never as an empty edge list", async () => {
    reset("old403");
    expect(await read()).toEqual({ status: 403, body: { code: "forbidden", status: 403, message: "forbidden" } });
    reset("old404");
    expect((await read()).status).toBe(404);
  });

  test("[验收线 3] a body outside the closed contract or for another team is 503, not passed through", async () => {
    const edge = FEATURE_DEPS_READ_FIXTURE.edges[0]!;
    const bad = [{ ...FEATURE_DEPS_READ_FIXTURE, teamId: "team-b" }, { ...FEATURE_DEPS_READ_FIXTURE, extra: true },
      { ...FEATURE_DEPS_READ_FIXTURE, edges: [{ ...edge, note: "repo:org/x" }] }, { ...FEATURE_DEPS_READ_FIXTURE, edges: [{ ...edge, kind: "lock" }] }];
    for (const body of bad) {
      reset("new", body);
      expect(await read()).toEqual({ status: 503, body: { error: "shared ledger unavailable; outcome unconfirmed" } });
    }
  });

  test("[验收线 3] query strings, encoded ?, extra segments and POST are 400 without reaching the center", async () => {
    reset("new");
    expect((await read(PATH, owner, "?x=1")).status).toBe(400);
    expect((await read(PATH, owner, "?projectId=project-b")).status).toBe(400);
    for (const bad of ["feature-deps%3Fx=1", "feature-deps/x", "features/feature-a/feature-deps", "feature-depsx"]) {
      expect((await read(`/shared-ledger/${bad}`)).status).toBe(400);
    }
    // Uploads come only from the home's background sync, never through the page proxy.
    expect((await read(PATH, owner, "", { method: "POST", body: JSON.stringify(FEATURE_DEPS_READ_FIXTURE) })).status).toBe(400);
    expect(center.paths).toEqual([]);
  });

  test("[验收线 3] no read grant or other-project grant is 403 with zero center requests", async () => {
    reset("new");
    for (const principal of [planner, otherProject]) {
      expect(await read(PATH, principal)).toEqual({ status: 403, body: { error: "shared ledger identity unavailable" } });
    }
    expect(center.paths).toEqual([]);
  });

  test("[验收线 3] forwards through sharedLedgerGateProxy with the binding picked by project header", async () => {
    reset("new");
    const gate = (project: string) => sharedLedgerGateProxy(new Request(`http://127.0.0.1/api/v1${PATH}`,
      { headers: { [SHARED_LEDGER_PROJECT_HEADER]: project } }), PATH, owner, handleSharedLedgerApi, { stateDir: root, key: () => key });
    const ok = (await gate("project-a"))!;
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(FEATURE_DEPS_READ_FIXTURE);
    expect((await gate("project-b"))!.status).toBe(403);
  });

  test("[验收线 3] client.featureDeps: 403 stays a remote error, invalid fixtures and other teams are Unavailable", async () => {
    const client = new SharedLedgerClient({ centerId: "center-a", baseUrl: server.url.origin, teamId: "team-a", personId: "alice",
      instanceId: "instance-alice", bearer }, key, { stateDir: root });
    reset("new", FEATURE_DEPS_READ_FIXTURE);
    expect(await client.featureDeps()).toEqual(FEATURE_DEPS_READ_FIXTURE);
    reset("old403");
    const error = await client.featureDeps().catch((e: unknown) => e);
    expect(error instanceof SharedLedgerRemoteError && error.status).toBe(403);
    for (const name of ["topLevelExtraKey", "edgeNote", "edgeEvidence", "lockKind", "selfLoop", "duplicate", "zeroCount", "schemaVersion2", "overLimit"]) {
      const { sourceInstanceId: _s, ...body } = FEATURE_DEPS_INVALID_UPLOADS[name] as Record<string, unknown>;
      reset("new", { ...body, updatedAt: 1 });
      expect(await client.featureDeps().catch((e: unknown) => e)).toBeInstanceOf(SharedLedgerUnavailable);
    }
    reset("new", { ...FEATURE_DEPS_READ_FIXTURE, teamId: "team-b" });
    expect(await client.featureDeps().catch((e: unknown) => e)).toBeInstanceOf(SharedLedgerUnavailable);
  });
});
