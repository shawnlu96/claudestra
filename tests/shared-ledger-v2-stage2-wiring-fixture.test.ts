/** S2F test fixture: a synthetic ledger in a temp state dir with one execution card (T) and one local card (L). */
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { writeSharedLedgerCredential } from "../src/lib/shared-ledger-mode.js";
import { initSharedLedgerV2, sharedLedgerV2Bridge } from "../src/bridge/shared-ledger-v2-wiring.js";
import { schedulerV2Wiring } from "../src/lib/scheduler-v2-wiring.js";

export const PROJECT = "s2-drill-demo";
export const SCOPE = { centerId: "center", teamId: "team", projectId: "project" };
const cleanups: (() => void | Promise<void>)[] = [];
// The daemon's pass entry starts the process's single wiring lazily; another file's runScheduler test may leave one running.
beforeEach(async () => { await schedulerV2Wiring()?.stop(); });
afterEach(async () => {
  sharedLedgerV2Bridge()?.stop();
  await schedulerV2Wiring()?.stop();
  while (cleanups.length) await cleanups.pop()!();
});

export function credential(subject: string, personId: string) {
  return { localSubject: subject, kind: "person" as const, centerId: SCOPE.centerId, baseUrl: "https://center.invalid",
    teamId: SCOPE.teamId, personId, instanceId: "home", bearer: `bearer-${personId}`,
    projects: [{ projectId: SCOPE.projectId, actions: ["read" as const, "plan" as const] }] };
}

export function executionMode(epoch = 1, extra: Record<string, unknown> = {}) {
  return { authorityMode: "execution", sharedPlanning: true,
    centerExecution: { ...SCOPE, centerFeatureId: "center-feature", epoch }, ...extra };
}

export async function wiringFixture(o: { credentials?: boolean; bound?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s2f-wiring-")), path = join(dir, "ledger.sqlite");
  const db: Database = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  createTask(db, { actor: "owner" }, { id: "T", project: PROJECT, title: "execution card", kind: "code" });
  createTask(db, { actor: "owner" }, { id: "L", project: PROJECT, title: "local card", kind: "code" });
  db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f',?,'synthetic','active','owner',1,1)").run(PROJECT);
  db.query("UPDATE tasks SET featureId='f' WHERE id='T'").run();
  const setMode = (mode: Record<string, unknown>) =>
    writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { f: mode } }), { mode: 0o600 });
  setMode(executionMode());
  if (o.bound !== false) {
    writeFileSync(join(dir, "shared-ledger-bindings.json"), JSON.stringify([{ ...SCOPE, localProjectId: PROJECT }]), { mode: 0o600 });
  }
  if (o.credentials !== false) {
    await writeSharedLedgerCredential(credential("owner:self", "person-owner"), dir);
    await writeSharedLedgerCredential(credential("token:member", "person-member"), dir);
  }
  return { dir, db, setMode, bridge: (extra = {}) => initSharedLedgerV2({ dir, db: () => db, ...extra }) };
}
