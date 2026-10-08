/** N8A fixtures: a home ledger with a bound project, a service credential and a fake center that follows the import contract. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import type { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { SharedLedgerRemoteError, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import type { SharedLedgerImport } from "../src/lib/shared-ledger-contract.js";
import { runSharedLedgerAutoSharePass, type AutoShareDeps } from "../src/lib/shared-ledger-auto-share.js";
import { readAutoShareState } from "../src/lib/shared-ledger-auto-share-state.js";
import { CENTER, SCRUB, serviceCredential } from "./shared-ledger-mirror-fixture.test.js";

export const PROJECT = "n8a-proj";
export const SECRET = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const STATE_FILES = ["shared-ledger-migrations", "shared-ledger-mirrors.json", "shared-ledger-credentials.json", "shared-ledger-bindings.json",
  "shared-ledger-modes.json", "shared-ledger-auto-share.json"];
export function cleanupAutoShareState() { for (const name of STATE_FILES) rmSync(join(STATE_DIR, name), { recursive: true, force: true }); }

type Fault = "none" | "dry-run-4xx" | "commit-4xx" | "lost";
/** Fake center behind the import client surface: receipts are built from the payload exactly as checkReceipt expects. */
export function fakeCenter() {
  const receipts = new Map<string, unknown>(), calls: string[] = [];
  let fault: Fault = "none", serverSeq = 0;
  const staged = (p: SharedLedgerImport) => {
    const fs = p.manifest.features, src = p.manifest.sourceInstanceId;
    serverSeq++;
    const mappings = fs.flatMap((f) => [{ kind: "feature", sourceInstanceId: src, sourceId: f.sourceFeatureId, id: `center-${f.sourceFeatureId}` },
      ...f.projection.tasks.map((t) => ({ kind: "task", sourceInstanceId: src, sourceId: t.sourceTaskId, id: `center-task-${t.sourceTaskId}` }))]);
    return { status: "staged", batchId: p.batchId, projectId: p.manifest.projectId, serverSeq,
      receipt: { schemaVersion: 1, mode: "commit", batchId: p.batchId, manifestDigest: p.manifestDigest, serverSeq, mappings },
      verification: { features: fs.length, versions: fs.reduce((n, f) => n + f.versions.length, 0),
        bindings: fs.reduce((n, f) => n + f.versions.reduce((a, v) => a + v.bindings.length, 0), 0),
        tasks: fs.reduce((n, f) => n + f.projection.tasks.length, 0), sourceSeq: p.manifest.sourceSeq, manifestDigest: p.manifestDigest } };
  };
  const center = {
    calls, batches: [] as SharedLedgerImport[],
    fault: (next: Fault) => { fault = next; },
    client: (connection: unknown) => ({
      connection,
      async importReceipt(batchId: string) { calls.push(`receipt ${batchId}`); return receipts.get(batchId) ?? { status: "unknown", batchId }; },
      async import(p: SharedLedgerImport) {
        calls.push(`dry-run ${p.batchId}`);
        if (fault === "dry-run-4xx") throw new SharedLedgerRemoteError(422, { code: "invalid" });
        return { mode: "dry-run", batchId: p.batchId, manifestDigest: p.manifestDigest };
      },
      async commitImport(p: SharedLedgerImport) {
        calls.push(`commit ${p.batchId}`);
        if (fault === "commit-4xx") throw new SharedLedgerRemoteError(409, { code: "conflict" });
        if (fault === "lost") throw new SharedLedgerUnavailable();
        const r = staged(p);
        receipts.set(p.batchId, r); center.batches.push(p);
        return r.receipt;
      },
      async controlImport() { throw new Error("not used by auto-share"); },
    }) as unknown as SharedLedgerClient,
  };
  return center;
}

/** Bound project with `ids` active features (each a one-node DAG); options add the non-candidates of acceptance 1. */
export async function autoShareFixture(ids: string[], node: (id: string) => string = (id) => `Plan ${id}`) {
  const dir = mkdtempSync(join(tmpdir(), "n8a-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const actor = "agent-n8a-pm", ctx = { actor };
  db.run("INSERT INTO ledger_instance VALUES ('origin', 'n8a0')");
  setMeta(db, { actor: "owner" }, { project: PROJECT, key: "pms", value: [actor] });
  const feature = (slug: string) => {
    const id = createFeature(db, ctx, { project: PROJECT, slug, title: `Feature ${slug}` }).row.id;
    initDag(db, ctx, { id, rev: 1, nodes: [{ key: "work", oneLine: node(slug), fileGlobs: [`src/${slug}.ts`] }] });
    return id;
  };
  const features = ids.map(feature);
  writeFileSync(join(STATE_DIR, "shared-ledger-bindings.json"), JSON.stringify([{ centerId: CENTER.centerId, teamId: CENTER.teamId,
    projectId: CENTER.projectId, localProjectId: PROJECT }]), { mode: 0o600 });
  chmodSync(join(STATE_DIR, "shared-ledger-bindings.json"), 0o600);
  await serviceCredential();
  const center = fakeCenter();
  let scrub: AutoShareDeps["scrub"] = async () => SCRUB;
  const deps = (now: number): AutoShareDeps => ({ ledgerPath: path, now: () => now, client: (credential) => center.client(credential),
    scrub: (d, plan) => scrub!(d, plan) });
  const ledger = (args: string[], who = actor) => runLedger(args, { db, actor: who, actorProject: PROJECT, projectIds: [PROJECT],
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => Date.now(),
    autoDispatch: () => true, autoProjects: () => [PROJECT] });
  return { db, dir, path, actor, features, feature, center, ledger,
    setScrub(next: AutoShareDeps["scrub"]) { scrub = next; },
    pass: (now: number) => runSharedLedgerAutoSharePass(deps(now)),
    state: () => readAutoShareState()[PROJECT]!,
    modesRaw: () => existsSync(join(STATE_DIR, "shared-ledger-modes.json")) ? readFileSync(join(STATE_DIR, "shared-ledger-modes.json"), "utf8") : "",
    journal: (batchId: string) => JSON.parse(readFileSync(join(STATE_DIR, "shared-ledger-migrations", `${batchId}.json`), "utf8")),
    async close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); cleanupAutoShareState(); },
  };
}

/** Acceptance 1 shape: 3 sharable + done + mirrored + excluded + center replica. */
export async function mixedFixture() {
  const f = await autoShareFixture(["alpha", "beta", "gamma"]);
  const [done, mirrored, excluded, replica] = ["done", "mirrored", "excluded", "replica"].map(f.feature) as [string, string, string, string];
  f.db.prepare("UPDATE features SET status = 'done' WHERE id = ?").run(done);
  await writeSharedLedgerMode(mirrored, { authorityMode: "source", sharedPlanning: true, mirror: true }, STATE_DIR, f.path);
  await writeSharedLedgerMode(replica, { authorityMode: "planning", sharedPlanning: true, centerPlanned: { centerId: CENTER.centerId,
    teamId: CENTER.teamId, projectId: CENTER.projectId, centerFeatureId: "center-replica" } }, STATE_DIR, f.path);
  return { ...f, done, mirrored, excluded, replica };
}
