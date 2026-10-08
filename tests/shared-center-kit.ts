/**
 * N7X1 test kit: a fake center on 127.0.0.1 (the real signed transport talks to it; nothing reaches a real bridge or center)
 * serving the N7C proposal list, V1 feature detail and projections, plus a local ledger bound to its project.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { writeJsonAtomicSync } from "../src/lib/state-file.js";
import { SHARED_LEDGER_CAPABILITIES, type SharedLedgerFeatureDetail, type SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { defaultProposalPolicy, proposalDigest, type FeatureProposal } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { writeSharedLedgerCredential, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import type { CenterNode } from "../src/lib/shared-ledger-center-replica-write.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";

export const CENTER = { centerId: "center-a", teamId: "team-a", projectId: "shared-project", instanceId: "home-a", personId: "member-a" };
export const SCOPE = { centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId };
export const SCRUB = { identity: { username: "n7x-user", hostname: "n7x-host" } };
export const FEATURE_UUID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";
export const LOCAL_ID = "n7-0f1e2d3c4b";

export interface FakeFeature {
  id: string; title: string; version: number; rev: number; nodes: CenterNode[]; bindings: { nodeKey: string; taskId: string }[];
  homeInstanceId: string; authorityMode: "source" | "planning";
}
export const node = (key: string, patch: Partial<CenterNode> = {}): CenterNode =>
  ({ key, oneLine: `节点 ${key}`, deps: [], fileGlobs: [`src/n7x/${key}.ts`], estimate: "S", ...patch });
export const fakeFeature = (patch: Partial<FakeFeature> = {}): FakeFeature => ({ id: FEATURE_UUID, title: "中心副本合成功能", version: 2, rev: 5,
  nodes: [node("alpha"), node("beta", { deps: ["alpha"] })], bindings: [], homeInstanceId: CENTER.instanceId, authorityMode: "planning", ...patch });

/** V1 detail exactly as the center serves it (no projection, no tasks: nothing pushed yet). */
export function detailOf(f: FakeFeature): SharedLedgerFeatureDetail {
  return { schemaVersion: 1, teamId: CENTER.teamId, serverSeq: 10 + f.rev, capabilities: SHARED_LEDGER_CAPABILITIES,
    feature: { id: f.id, projectId: CENTER.projectId, title: f.title, description: "", rev: f.rev, version: f.version, authorityMode: f.authorityMode,
      homeInstanceId: f.homeInstanceId, executorInstanceIds: [], status: "active",
      counts: { total: f.nodes.length, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: 1000, projection: null },
    dag: { version: f.version, nodes: structuredClone(f.nodes), bindings: structuredClone(f.bindings) }, tasks: [],
  } as SharedLedgerFeatureDetail;
}

function proposalRecord(kind: "new" | "revise", f: FakeFeature, n: number) {
  const base = { schemaVersion: 1, ...SCOPE, operationId: `op-${kind}-${n}`, title: f.title, description: "", ownerWords: null,
    nodes: f.nodes, homeInstanceId: f.homeInstanceId, expiresAt: 9_000_000_000_000 };
  const proposal = (kind === "new" ? { ...base, kind } : { ...base, kind, featureId: f.id, baseVersion: Math.max(1, f.version - 1), expectedRev: 1,
    baseDigest: "c".repeat(64) }) as FeatureProposal;
  const digest = proposalDigest(proposal);
  return { proposal, proposalId: `proposal-${kind}-${n}`, proposalRev: 1, proposer: { type: "person", personId: "person-a", instanceId: null },
    operation: { schemaVersion: 1, ...SCOPE, operationId: proposal.operationId, proposalDigest: digest, state: "published",
      proposalId: `proposal-${kind}-${n}`, featureId: f.id, version: f.version, updatedAt: 1000 } };
}

export function startFakeCenter() {
  const features = new Map<string, FakeFeature>();
  const proposals: ReturnType<typeof proposalRecord>[] = [];
  const requests: { method: string; path: string }[] = [];
  const projections: SharedLedgerProjection[] = [];
  const state = { mode: "ok" as "ok" | "unauthorized" | "down" };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push({ method: req.method, path });
    if (state.mode === "down") return new Response("down", { status: 503 });
    if (state.mode === "unauthorized") return Response.json({ error: "unauthorized" }, { status: 401 });
    if (req.method === "GET" && path === `/v1/feature-proposals/projects/${CENTER.projectId}`) {
      return Response.json({ policy: defaultProposalPolicy(SCOPE), proposals });
    }
    const detail = path.match(/^\/v1\/teams\/team-a\/features\/([^/]+)$/);
    if (req.method === "GET" && detail) {
      const f = features.get(detail[1]!);
      return f ? Response.json(detailOf(f)) : Response.json({ code: "forbidden", status: 403, message: "x" }, { status: 403 });
    }
    if (req.method === "POST" && path === "/v1/teams/team-a/projections") {
      const { payload } = await req.json() as { payload: SharedLedgerProjection };
      projections.push(payload);
      return Response.json({ schemaVersion: 1, serverSeq: projections.length, sourceInstanceId: payload.sourceInstanceId, sourceSeq: payload.sourceSeq, digest: "b".repeat(64) });
    }
    return new Response("not found", { status: 404 });
  } });
  return {
    url: `http://127.0.0.1:${server.port}/`, features, requests, projections, state,
    /** Publishes (or republishes) a feature reachable through a proposal of the given kind. */
    publish(f: FakeFeature, kind: "new" | "revise" | "none" = "new") {
      features.set(f.id, structuredClone(f));
      if (kind !== "none") proposals.push(proposalRecord(kind, f, proposals.length + 1));
    },
    stop() { server.stop(true); },
  };
}

const STATE_FILES = ["shared-ledger-bindings.json", "shared-ledger-credentials.json", "shared-ledger-mirrors.json", "shared-center-replicas.json",
  "shared-center-binds.json", "shared-ledger-migrations"];

/** Durable things a refused sync must not touch (the replica status file may record the fixed reason). */
export function ledgerSnapshot(db: ReturnType<typeof integrationFixture>["db"], dir = STATE_DIR) {
  const read = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { features: count("SELECT COUNT(*) AS n FROM features"), versions: count("SELECT COUNT(*) AS n FROM dag_versions"),
    bindings: count("SELECT COUNT(*) AS n FROM dag_bindings"), tasks: count("SELECT COUNT(*) AS n FROM tasks"),
    seq: count("SELECT COALESCE(MAX(seq), 0) AS n FROM events"),
    modes: read("shared-ledger-modes.json"), mirrors: read("shared-ledger-mirrors.json"), claims: read("shared-center-binds.json") };
}

/** Local ledger (integration fixture) bound to the fake center's project with an owner:self service credential. */
export async function replicaKit(opts: { credentialInstance?: string; actions?: ("read" | "plan" | "import" | "project")[] } = {}) {
  const f = integrationFixture(), center = startFakeCenter(), dir = STATE_DIR;
  writeJsonAtomicSync(join(dir, "shared-ledger-bindings.json"), [{ ...SCOPE, localProjectId: f.project }], { mode: 0o600 });
  await writeSharedLedgerCredential({ localSubject: "owner:self", kind: "service", centerId: CENTER.centerId, baseUrl: center.url,
    teamId: CENTER.teamId, personId: CENTER.personId, instanceId: opts.credentialInstance ?? CENTER.instanceId, bearer: "bearer-for-tests-only",
    projects: [{ projectId: CENTER.projectId, actions: opts.actions ?? ["project"] }] }, dir);
  return {
    f, center, dir,
    sync: () => f.ledger(["center-replica", "sync"]),
    status: () => f.ledger(["center-replica", "status"]),
    async close() {
      center.stop();
      await writeSharedLedgerMode(LOCAL_ID, { authorityMode: "source", sharedPlanning: false }, dir, f.db.filename);
      for (const name of STATE_FILES) rmSync(join(dir, name), { recursive: true, force: true });
      await f.close();
    },
  };
}
