/** PJ1 fixtures: 本机 home ledger + a local migration journal as scripts/shared-ledger-import.ts leaves it after commit. */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../src/lib/ask-bind.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { previewSharedLedgerExport } from "../src/lib/shared-ledger-export.js";
import { writeSharedLedgerCredential, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import type { MirrorEntry } from "../src/lib/shared-ledger-projector.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";

export const CENTER = { centerId: "center-a", teamId: "team-a", projectId: "shared-project", instanceId: "home-a", personId: "member-a" };
export const SCRUB = { identity: { username: "pj1-user", hostname: "pj1-host" } };

/** Leaves the mode as an import commit does: {source, sharedPlanning:true}, journal phase verified / receipt staged. */
export async function commitJournal(f: ReturnType<typeof integrationFixture>, batchId: string, phase: "verified" | "active" = "verified", dir = STATE_DIR) {
  await writeSharedLedgerMode(f.id, { authorityMode: "source", sharedPlanning: true }, dir, f.db.filename);
  const { payload } = previewSharedLedgerExport(f.db, { localProject: f.project, projectId: CENTER.projectId, sourceInstanceId: CENTER.instanceId,
    featureIds: [f.id], batchId, stateDir: dir, scrub: SCRUB, summaries: { "c5-existing": { summary: "Existing work", digest: null } } });
  const result = { schemaVersion: 1, mode: "commit", batchId, manifestDigest: payload.manifestDigest, serverSeq: 3,
    mappings: [{ kind: "feature", sourceInstanceId: CENTER.instanceId, sourceId: f.id, id: "center-feature-1" }] };
  mkdirSync(join(dir, "shared-ledger-migrations"), { recursive: true });
  await Bun.write(join(dir, "shared-ledger-migrations", `${batchId}.json`), JSON.stringify({ schemaVersion: 1, selectionDigest: "0".repeat(64),
    featureIds: [f.id], backup: "backup", phase, payload: { ...payload, mode: "commit" },
    target: canonicalJson({ centerId: CENTER.centerId, baseUrl: "https://center.example/", teamId: CENTER.teamId, personId: CENTER.personId, instanceId: CENTER.instanceId }),
    receipt: { status: phase === "active" ? "active" : "staged", batchId, projectId: CENTER.projectId, serverSeq: 3, receipt: result, verification: null } }));
  return payload;
}
export async function serviceCredential(dir = STATE_DIR, actions: ("read" | "plan" | "import" | "project")[] = ["import", "project"]) {
  await writeSharedLedgerCredential({ localSubject: "owner:self", kind: "service", centerId: CENTER.centerId, baseUrl: "https://center.example/",
    teamId: CENTER.teamId, personId: CENTER.personId, instanceId: CENTER.instanceId, bearer: "bearer-for-tests-only",
    projects: [{ projectId: CENTER.projectId, actions }] }, dir);
}
export function cleanupMirrorState(dir = STATE_DIR) {
  for (const name of ["shared-ledger-migrations", "shared-ledger-mirrors.json", "shared-ledger-credentials.json"]) rmSync(join(dir, name), { recursive: true, force: true });
}
export function mirrorEntry(f: ReturnType<typeof integrationFixture>, watermark: number, patch: Partial<MirrorEntry> = {}): MirrorEntry {
  return { enabled: true, batchId: "batch-pj1", centerId: CENTER.centerId, teamId: CENTER.teamId, projectId: CENTER.projectId,
    centerFeatureId: "center-feature-1", sourceInstanceId: CENTER.instanceId, localProject: f.project, watermark, snapshot: false,
    fingerprints: {}, taskMeta: {}, lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0, ...patch };
}
export const globalSeq = (f: ReturnType<typeof integrationFixture>) =>
  (f.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
