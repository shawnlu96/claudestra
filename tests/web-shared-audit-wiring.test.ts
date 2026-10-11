/**
 * UIEXEC1 · formal TeamSource execution wiring: the bridge web context (fail-closed matrix, no auth material, no cross-Principal
 * reuse), the local-project query on POST through the real sharedExecTransport, and the production composition root end to end.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal } from "../src/lib/principals.js";
import type { SharedLedgerBinding } from "../src/lib/shared-ledger-gate-bindings.js";
import { handleSharedExecApi } from "../src/bridge/local-api/shared-exec.js";
import { configureSharedExecEntry, type EntrySwitch, type SharedExecEntryPort } from "../src/bridge/shared-ledger-v2-entry.js";
import { sharedExecWebContext, type WebContextDeps, type WebContextView } from "../src/bridge/shared-ledger-v2-web-context.js";
import { initSharedLedgerV2, sharedLedgerV2Bridge } from "../src/bridge/shared-ledger-v2-wiring.js";
import { setAppConfigForTest } from "../web/lib/app-config";
import { sharedExecTransport } from "../web/lib/api/shared-ledger-v2";
import { beginEditor, taskCommand } from "../web/features/collab/shared/task/task-model";
import { taskFixtureCapabilities, taskFixtureCreate, taskFixtureScope } from "../web/features/collab/shared/task/task-fixture";
import { parseExecContext, productionExecPort } from "../web/features/collab/shared/exec/production-port";
import { F, P, resetWorld, world } from "./shared-ledger-v2-stage2-wiring-world.test.js";

const member: Principal = { id: "guest:member", role: "external", agents: [], createdAt: "synthetic" };
const other: Principal = { id: "guest:other", role: "external", agents: [], createdAt: "synthetic" };
const SECRET = "bearer-SECRET-material";
const q = "teamId=team&projectId=project&featureId=center-feature";

beforeEach(resetWorld);
afterEach(async () => { configureSharedExecEntry(null); setAppConfigForTest(null); await resetWorld(); });

function harness() {
  const state = {
    mode: "on" as EntrySwitch, modeAfterRead: null as EntrySwitch | null,
    bindings: [{ centerId: "center", teamId: "team", projectId: "project", localProjectId: "local-project" }] as SharedLedgerBinding[],
    credentials: new Set([member.id]), feature: true as boolean, repository: "Team/Repository" as string | null,
    view: { teamId: "team", projectId: "project", serviceGeneration: 3, feature: { id: "center-feature", epoch: 2, authorityMode: "execution" } } as WebContextView,
    snapshots: [] as string[], opens: [] as string[], writes: 0, revokes: 0, revokeDuringRead: false,
  };
  const deps: WebContextDeps = {
    bindings: () => state.bindings,
    credential: (p) => state.credentials.has(p.id) ? { instanceId: "instance-local" } : null,
    revoke: () => { state.revokes++; },
    // The opened connection carries credential material; the context must never copy it out.
    open: (p, project) => {
      state.opens.push(`${p.id}:${project}`);
      return state.credentials.has(p.id)
        ? { scope: state.bindings[0]!, signer: { instanceId: "instance-local" }, transport: { bearer: SECRET, dir: "/Users/x/state" } } as never : null;
    },
    role: (p) => p.id === "owner:self" ? "owner" : "member",
    localFeature: (project, id) => state.feature && project === "local-project" && id === "center-feature"
      ? { localFeatureId: "local-feature", centerFeatureId: id, epoch: 2 } : null,
    snapshot: async (p, project, localFeatureId) => {
      state.snapshots.push(`${p.id}:${project}:${localFeatureId}`);
      if (state.modeAfterRead) state.mode = state.modeAfterRead;
      if (state.revokeDuringRead) state.credentials.delete(p.id);
      return structuredClone(state.view);
    },
    repository: () => state.repository,
    bootId: "bridge-boot",
  };
  const port: SharedExecEntryPort = {
    mode: (project) => project === "local-project" ? state.mode : "off",
    clientFor: () => ({ command: async (c) => { state.writes++; return { received: c } as never; }, queryAsk: async () => ({}) as never }),
    snapshot: async () => ({}), receipt: async () => ({}),
    commandRoute: () => "central",
    webContext: sharedExecWebContext(deps),
  };
  configureSharedExecEntry(port);
  return state;
}
async function call(path: string, p = member, init: RequestInit = {}) {
  const url = new URL(`http://synthetic.invalid/api/v1/shared-exec/${path}`);
  return (await handleSharedExecApi(new Request(url.href, init), url.pathname.slice("/api/v1".length), p, url))!;
}

test("[验收线 3] on/observe context carries only ExecContext fields from local facts; no auth material, path or other project", async () => {
  const s = harness(), r = await call(`context?${q}`);
  expect(r.status).toBe(200);
  const body = await r.json(), text = JSON.stringify(body);
  expect(body).toEqual({ mode: "on", localProjectId: "local-project",
    scope: { teamId: "team", projectId: "project", serviceGeneration: 3, epoch: 2, bootId: "bridge-boot" },
    viewer: { role: "member", instanceId: "instance-local" }, repository: "Team/Repository", instanceNames: { "instance-local": "本机" } });
  for (const leak of [SECRET, "/Users", "bearer", "token", "credential"]) expect(text.includes(leak)).toBe(false);
  expect(s.snapshots).toEqual(["guest:member:local-project:local-feature"]);
  s.mode = "observe";
  expect(((await (await call(`context?${q}`)).json()) as { mode: string }).mode).toBe("observe");
  // Switch dropped to observe while the center answered: the later reading wins.
  s.mode = "on"; s.modeAfterRead = "observe";
  expect(((await (await call(`context?${q}`)).json()) as { mode: string }).mode).toBe("observe");
});

test("[验收线 3] off, revocation, forged reply, stale fence and missing mapping all fail closed", async () => {
  const s = harness();
  const status = async (p = member) => { const r = await call(`context?${q}`, p); return [r.status, ((await r.json()) as { code: string }).code]; };
  s.mode = "off"; expect(await status()).toEqual([503, "unavailable"]); expect(s.snapshots).toEqual([]); expect(s.opens).toEqual([]);
  s.mode = "on"; s.modeAfterRead = "off"; expect(await status()).toEqual([503, "unavailable"]); s.modeAfterRead = null; s.mode = "on";
  expect(await status({ ...member, disabled: true })).toEqual([403, "forbidden"]);
  expect(await status({ ...member, peer: "peer-a" })).toEqual([403, "forbidden"]);
  s.credentials.delete(member.id); expect(await status()).toEqual([403, "forbidden"]); s.credentials.add(member.id);
  const binding = s.bindings[0]!;
  s.bindings = []; expect(await status()).toEqual([503, "v2_unmapped"]);
  s.bindings = [binding, { ...binding, localProjectId: "another" }]; expect(await status()).toEqual([503, "v2_unmapped"]);
  s.bindings = [binding];
  s.feature = false; expect(await status()).toEqual([404, "not_found"]); s.feature = true;
  s.repository = null; expect(await status()).toEqual([503, "v2_unmapped"]); s.repository = "team/repository";
  const good = structuredClone(s.view);
  for (const forged of [{ ...good, teamId: "team-b" }, { ...good, projectId: "project-b" }, { ...good, feature: { ...good.feature, id: "f2" } },
    { ...good, feature: { ...good.feature, authorityMode: "planning" } }, { ...good, feature: { ...good.feature, epoch: 1 } },
    { ...good, serviceGeneration: 0 }]) {
    s.view = forged; expect(await status()).toEqual([503, "unavailable"]);
  }
  s.view = good;
  expect((await call(`context?${q}`, member, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await call("context?teamId=team&projectId=project")).status).toBe(400);
  configureSharedExecEntry(null); expect(await status()).toEqual([503, "unavailable"]);
});

test("[验收线 3] contexts are per Principal: a second Principal re-opens and re-reads, a revoked one never borrows the first", async () => {
  const s = harness();
  expect((await call(`context?${q}`)).status).toBe(200);
  expect((await call(`context?${q}`, other)).status).toBe(403);
  s.credentials.add(other.id);
  expect((await call(`context?${q}`, other)).status).toBe(200);
  expect(s.opens).toEqual(["guest:member:local-project", "guest:other:local-project", "guest:other:local-project"]);
  expect(s.snapshots).toEqual(["guest:member:local-project:local-feature", "guest:other:local-project:local-feature"]);
});

test("[验收线 3] a credential revoked while the center answers is refused and its cached connection dropped", async () => {
  const s = harness();
  s.revokeDuringRead = true;
  const r = await call(`context?${q}`);
  expect([r.status, ((await r.json()) as { code: string }).code, s.revokes]).toEqual([403, "forbidden", 1]);
});

test("[验收线 2] real sharedExecTransport posts with the local project query; the center body is unchanged", async () => {
  const s = harness(), urls: string[] = [];
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "synthetic", version: "" });
  const bridge = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input), "http://synthetic.invalid");
    urls.push(`${url.pathname}${url.search}`);
    return handleSharedExecApi(new Request(url.href, init), url.pathname.slice("/api/v1".length), member, url);
  }) as typeof fetch);
  try {
    const c = taskCommand(beginEditor({ ...taskFixtureCreate, title: "Synthetic" }), taskFixtureCapabilities, taskFixtureScope, "a".repeat(64), "request-1");
    expect(c.projectId).toBe("project");
    // Old red: the same body without the query resolves the center id as a local project (switch off there) and writes nothing.
    const old = await fetch("/api/v1/shared-exec/commands", { method: "POST", body: JSON.stringify(c) });
    expect([old.status, s.writes]).toEqual([503, 0]);
    const reply = await sharedExecTransport("local-project").command(c, new AbortController().signal) as { received: unknown };
    expect(urls.at(-1)).toBe("/api/v1/shared-exec/commands?project=local-project");
    expect(s.writes).toBe(1); expect(reply.received).toEqual(c);
  } finally { bridge.mockRestore(); }
});

test("browser port keeps only a context for its own team/project, drops extra fields, and reads once per TTL", async () => {
  const identity = { center: "center", team: "team", person: "person", project: "project", machine: "local" };
  const ok = { mode: "on", localProjectId: "local-project", scope: { teamId: "team", projectId: "project", serviceGeneration: 3, epoch: 2,
    bootId: "bridge-boot" }, viewer: { role: "owner", instanceId: "i" }, repository: "team/repository", instanceNames: { i: "本机" } };
  expect(parseExecContext({ ...ok, token: SECRET }, identity)).toEqual(ok as never);
  for (const bad of [{ ...ok, mode: "off" }, { ...ok, scope: { ...ok.scope, teamId: "team-b" } }, { ...ok, scope: { ...ok.scope, projectId: "p2" } },
    { ...ok, localProjectId: "../x" }, { ...ok, viewer: { role: "admin", instanceId: "i" } }, { ...ok, instanceNames: { i: 1 } }, null])
    expect(parseExecContext(bad, identity)).toBeNull();
  let clock = 0, changes = 0, reads = 0, reply: unknown = ok;
  const port = productionExecPort(identity, () => changes++, async (id) => { reads++; expect(id).toBe("center-feature");
    if (reply instanceof Error) throw reply; return reply; }, () => clock);
  expect(port.context("center-feature")).toBeNull(); expect(port.context("center-feature")).toBeNull();
  await Bun.sleep(0);
  expect([reads, changes]).toEqual([1, 1]); expect(port.context("center-feature")?.mode).toBe("on");
  clock = 60_000; reply = new Error("503 unavailable"); port.context("center-feature"); await Bun.sleep(0);
  expect([reads, changes]).toEqual([2, 2]); expect(port.context("center-feature")).toBeNull();
  port.close(); clock = 200_000; expect(port.context("center-feature")).toBeNull(); await Bun.sleep(0); expect(reads).toBe(2);
});

test("[验收线 1] production composition root injects webContext; the owner reads its context over the fake center", async () => {
  const s = await world();
  sharedLedgerV2Bridge()?.stop();
  initSharedLedgerV2({ wiring: s.wiring, db: () => null, repository: (p) => p === P ? "team/repository" : null });
  const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "synthetic" };
  const r = await call(`context?teamId=team&projectId=project&featureId=${F}`, owner);
  expect(r.status).toBe(200);
  const body = await r.json() as { mode: string; localProjectId: string; scope: { epoch: number }; viewer: { role: string } };
  expect([body.mode, body.localProjectId, body.scope.epoch, body.viewer.role]).toEqual(["on", P, 1, "owner"]);
  expect(JSON.stringify(body).includes("owner-bearer")).toBe(false);
  expect((await call(`context?teamId=team&projectId=project&featureId=${F}`, member)).status).toBe(403);
});

async function ownerWorld() {
  const s = await world();
  sharedLedgerV2Bridge()?.stop();
  initSharedLedgerV2({ wiring: s.wiring, db: () => null, repository: (p) => p === P ? "team/repository" : null });
  const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "synthetic" };
  const get = async () => {
    const r = await call(`context?teamId=team&projectId=project&featureId=${F}`, owner);
    return [r.status, ((await r.json()) as { code?: string }).code ?? "ok"];
  };
  return { s, get };
}

test("[验收线 3] real composition root: a credential revoked after a cached open fails closed with no further center read", async () => {
  const { s, get } = await ownerWorld();
  expect(await get()).toEqual([200, "ok"]);
  const reads = s.requests.length;
  // Old red: Stage2Wiring.open returned the cached connection, so this answered 200/on and read the center again.
  writeFileSync(join(s.dir, "shared-ledger-credentials.json"), JSON.stringify({ credentials: [] }), { mode: 0o600 });
  expect(await get()).toEqual([403, "forbidden"]);
  expect(s.requests.length).toBe(reads);
  // The stale connection is gone from the wiring too: no other port reuses the revoked credential.
  expect(s.wiring.transportFor(P)).toBeNull();
});

test("[验收线 3] real composition root: a fence that moves while the center answers is not published", async () => {
  const { s, get } = await ownerWorld();
  const modes = join(s.dir, "shared-ledger-modes.json");
  const original = s.wiring.snapshot.bind(s.wiring);
  s.wiring.snapshot = async (...args: Parameters<typeof original>) => {
    const view = await original(...args);
    const file = JSON.parse(await Bun.file(modes).text());
    file.features[F].centerExecution.epoch = 2;
    writeFileSync(modes, JSON.stringify(file), { mode: 0o600 });
    return view;
  };
  // Old red: 200 with scope.epoch=1 although the local record had moved to 2.
  expect(await get()).toEqual([503, "unavailable"]);
});
