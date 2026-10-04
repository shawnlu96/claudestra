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
import { parseSharedLedgerResponse } from "../src/lib/shared-ledger-contract-responses.js";
import {
  SHARED_LEDGER_ACTIVITY_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, SHARED_LEDGER_EXT_CAPABILITIES_OLD_CENTER_STATUS,
  SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE, SHARED_LEDGER_FEATURE_FIXTURE, SHARED_LEDGER_LIST_FIXTURE, SHARED_LEDGER_VERSIONS_FIXTURE,
} from "../src/lib/shared-ledger-contract-fixtures.js";
import type { InstanceKey } from "../src/lib/instance-key.js";
import type { Principal } from "../src/lib/principals.js";

// Synthetic loopback center: verifies the real client signature, then answers from shared fixtures. No production center/state.
const pair = generateKeyPairSync("ed25519");
const key: InstanceKey = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
const bearer = "synthetic-reads-bearer";
const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "2026-10-04T00:00:00Z" } as Principal;
const planner = { ...owner, id: "guest:planner", role: "external" } as Principal;
const otherProject = { ...owner, id: "guest:project-b", role: "external" } as Principal;
type Mode = "new" | "readonly" | "old";
const center = { mode: "new" as Mode, overrides: new Map<string, unknown>(), paths: [] as string[] };
let root: string, server: ReturnType<typeof Bun.serve>, deps: SharedLedgerProxyDeps;

function authentic(req: Request, path: string): boolean {
  const h = SHARED_LEDGER_AUTH_HEADERS, auth = req.headers.get("authorization") ?? "";
  const fields = [req.method, path, req.headers.get(h.ts)!, sharedLedgerCredentialHash(""), req.headers.get(h.nonce)!,
    req.headers.get(h.instance)!, sharedLedgerCredentialHash(auth.slice(7))];
  return auth === `Bearer ${bearer}` && req.headers.get(h.key) === key.publicKey
    && verifyPurpose(key.publicKey, "claudestra-shared-ledger-v1", fields, req.headers.get(h.sig) ?? "");
}
function answer(resource: string): Response {
  if (center.overrides.has(resource)) return Response.json(center.overrides.get(resource));
  const ext = resource === "ext-capabilities" || /^features\/[^/]+\/(?:versions|activity\/\d+)$/.test(resource);
  if (ext && center.mode === "old") return Response.json({ error: "not found" }, { status: SHARED_LEDGER_EXT_CAPABILITIES_OLD_CENTER_STATUS });
  if (resource === "ext-capabilities") {
    return Response.json(center.mode === "new" ? SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE : SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE);
  }
  if (resource === "features/feature-a/versions") return Response.json(SHARED_LEDGER_VERSIONS_FIXTURE);
  if (/^features\/feature-a\/activity\/\d+$/.test(resource)) return Response.json(SHARED_LEDGER_ACTIVITY_FIXTURE);
  if (resource === "features") return Response.json(SHARED_LEDGER_LIST_FIXTURE);
  if (resource === "features/feature-a") return Response.json(SHARED_LEDGER_FEATURE_FIXTURE);
  return Response.json({ error: "not found" }, { status: 404 });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sl-gate-reads-"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    center.paths.push(path);
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

const call = (path: string, principal = owner, query = "") =>
  handleSharedLedgerApi(new Request(`http://127.0.0.1/api/v1${path}${query}`), path, principal, deps);
const read = async (path: string, principal = owner, query = "") => {
  const r = (await call(path, principal, query))!;
  return { status: r.status, body: await r.json() as unknown };
};
const reset = (mode: Mode) => { center.mode = mode; center.overrides.clear(); center.paths.length = 0; };

describe("P1-D add-only reads through the real bridge proxy and client", () => {
  test("复现: main 上代理对 ext-capabilities / features/x/versions 回 400 → 新可授权读 200", async () => {
    reset("new");
    expect(await read("/shared-ledger/ext-capabilities")).toEqual({ status: 200, body: SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE });
    expect(await read("/shared-ledger/features/feature-a/versions")).toEqual({ status: 200, body: SHARED_LEDGER_VERSIONS_FIXTURE });
    expect(await read("/shared-ledger/features/feature-a/activity/0")).toEqual({ status: 200, body: SHARED_LEDGER_ACTIVITY_FIXTURE });
    expect(center.paths).toEqual(["/v1/teams/team-a/ext-capabilities", "/v1/teams/team-a/features/feature-a/versions",
      "/v1/teams/team-a/features/feature-a/activity/0"]);
  });

  test("read-only center keeps uploads false; old center 404 answers all-off 200", async () => {
    reset("readonly");
    const ro = await read("/shared-ledger/ext-capabilities");
    expect(ro).toEqual({ status: 200, body: SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE });
    expect((ro.body as { uploads: unknown }).uploads).toEqual({ projectionExt1: false });
    reset("old");
    expect(await read("/shared-ledger/ext-capabilities")).toEqual({ status: 200, body: { schemaVersion: 1, teamId: "team-a",
      reads: { versions: false, activity: false, ext1: false, activityExt: false }, uploads: { projectionExt1: false } } });
    // Off is only for capabilities: an old center's 404 on a data read stays a 404, not an empty success.
    expect((await read("/shared-ledger/features/feature-a/versions")).status).toBe(404);
  });

  test("malformed capabilities (missing uploads / extra key / non-boolean) and leaky activity are refused, not passed through", async () => {
    const { uploads: _u, ...missing } = SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE;
    const bad = [missing, { ...SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, extra: true },
      { ...SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE, reads: { ...SHARED_LEDGER_EXT_CAPABILITIES_NEW_FIXTURE.reads, versions: "yes" } }];
    for (const body of bad) {
      reset("new"); center.overrides.set("ext-capabilities", body);
      expect(await read("/shared-ledger/ext-capabilities")).toEqual({ status: 503, body: { error: "shared ledger unavailable; outcome unconfirmed" } });
    }
    for (const leak of [{ text: "原文" }, { data: { to: "write" } }]) {
      reset("new");
      center.overrides.set("features/feature-a/activity/0", { ...SHARED_LEDGER_ACTIVITY_FIXTURE,
        items: [{ ...SHARED_LEDGER_ACTIVITY_FIXTURE.items[1]!, ...leak }] });
      expect((await read("/shared-ledger/features/feature-a/activity/0")).status).toBe(503);
    }
  });

  test("cross-project versions/activity are 403; no read grant or other-project grant is 403 even for capabilities", async () => {
    reset("new");
    center.overrides.set("features/feature-a/versions", { ...SHARED_LEDGER_VERSIONS_FIXTURE, projectId: "project-b" });
    center.overrides.set("features/feature-a/activity/3", { ...SHARED_LEDGER_ACTIVITY_FIXTURE, projectId: "project-b" });
    expect(await read("/shared-ledger/features/feature-a/versions")).toEqual({ status: 403, body: { error: "project unavailable" } });
    expect(await read("/shared-ledger/features/feature-a/activity/3")).toEqual({ status: 403, body: { error: "project unavailable" } });
    reset("new");
    for (const principal of [planner, otherProject]) {
      for (const path of ["/shared-ledger/ext-capabilities", "/shared-ledger/features/feature-a/versions", "/shared-ledger/features/feature-a/activity/0"]) {
        expect(await read(path, principal)).toEqual({ status: 403, body: { error: "shared ledger identity unavailable" } });
      }
    }
    expect(center.paths).toEqual([]);
  });

  test("illegal cursors, other paths and any query stay 400 without reaching the center", async () => {
    reset("new");
    const bad = ["features/feature-a/activity/-1", "features/feature-a/activity/01", "features/feature-a/activity/1.5",
      "features/feature-a/activity/9007199254740992", "features/feature-a/activity", "features/feature-a/activity-ext/0",
      "features/feature-a/ext1", "features/feature-a/versions/2", "ext-capabilities/x"];
    for (const resource of bad) expect((await read(`/shared-ledger/${resource}`)).status).toBe(400);
    expect((await read("/shared-ledger/features/feature-a/activity/0", owner, "?after=1")).status).toBe(400);
    expect((await read("/shared-ledger/ext-capabilities", owner, "?as=owner")).status).toBe(400);
    const post = await handleSharedLedgerApi(new Request("http://127.0.0.1/api/v1/shared-ledger/ext-capabilities", { method: "POST", body: "{}" }),
      "/shared-ledger/ext-capabilities", owner, deps);
    expect(post!.status).toBe(400);
    expect(center.paths).toEqual([]);
  });

  test("old features/feature responses replay byte-identical through the same proxy", async () => {
    reset("old");
    const list = await (await call("/shared-ledger/features"))!.text();
    const detail = await (await call("/shared-ledger/features/feature-a"))!.text();
    expect(list).toBe(JSON.stringify(parseSharedLedgerResponse("features", SHARED_LEDGER_LIST_FIXTURE)));
    expect(detail).toBe(JSON.stringify(SHARED_LEDGER_FEATURE_FIXTURE));
  });

  test("the unchanged gate proxy selects the binding by header and forwards the new reads", async () => {
    reset("readonly");
    const gate = (path: string, project?: string) => sharedLedgerGateProxy(new Request(`http://127.0.0.1/api/v1${path}`,
      { headers: project ? { [SHARED_LEDGER_PROJECT_HEADER]: project } : {} }), path, owner, handleSharedLedgerApi, { stateDir: root, key: () => key });
    const caps = await gate("/shared-ledger/ext-capabilities", "project-a");
    expect(await caps!.json()).toEqual(SHARED_LEDGER_EXT_CAPABILITIES_READONLY_FIXTURE);
    expect((await gate("/shared-ledger/features/feature-a/versions"))!.status).toBe(200);
    expect((await gate("/shared-ledger/ext-capabilities", "project-b"))!.status).toBe(403);
  });
});
