/** S2P shared fixture: temp ledger + mode file + synthetic center feature views (本机 / peer only, no production state). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { SharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { V2_FEATURE_VIEW_FIXTURE } from "../src/lib/shared-ledger-contract-v2-routes-fixtures.js";
import type { ExecutionProjectionRef, ProjectionCenterRef, ProjectionIdentity } from "../src/lib/shared-ledger-v2-projection.js";

type Obj = Record<string, any>;
export const center: ProjectionCenterRef & { centerId: string } = { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: "feature" };
export const executionMode: SharedLedgerMode = { authorityMode: "execution", sharedPlanning: true, centerExecution: { ...center, epoch: 1 } };
export const fence = { serviceGeneration: 1, epoch: 1, bootId: "boot-local" };
export const HEAD_A = "a".repeat(40), HEAD_B = "b".repeat(40), HEAD_C = "c".repeat(40);
const base = (): Obj => structuredClone(V2_FEATURE_VIEW_FIXTURE) as Obj;
const s = { teamId: "team", projectId: "project" };
const times = (t = 1000) => ({ rev: 1, createdAt: 1000, updatedAt: t });

export function task(id: string, patch: Obj = {}): Obj {
  return { ...base().tasks[0], id, itemId: null, title: `card ${id}`, stage: "build", round: 2, head: HEAD_A, pr: 7, ...patch };
}
export const step = (taskId: string, patch: Obj = {}): Obj => ({ ...base().steps[0], taskId, round: 2, ...patch });
export const dep = (fromTask: string, toTask: string, patch: Obj = {}): Obj =>
  ({ ...s, fromTask, toTask, kind: "blocks", when: "after", state: "waiting", createdBy: "person", ...times(), ...patch });
export const workflow = (taskId: string, patch: Obj = {}): Obj =>
  ({ ...s, taskId, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: ["codex"], specRev: 1, ...times(), ...patch });
const key = (path: string) => ({ ...s, repository: "team/repository", kind: "file", path });
export function intent(id: string, taskId: string, patch: Obj = {}, path = `src/${id}.ts`): Obj {
  return { ...base().intents[0], id: `c-${id}`, operationId: id, taskId, node: "write", action: "dispatch", head: HEAD_A, round: 2,
    resources: [key(path)], status: "pending", causalSeq: 3, eventSeq: 5, reason: `center ${id}`, ...patch };
}
export function resource(i: Obj): Obj[] {
  return (i.resources as Obj[]).map(k => ({ key: k, taskId: i.taskId, intentId: i.id, operationId: i.operationId, ...fence,
    scope: "intent", state: "held", acquiredAt: 1500 }));
}
/** A feature view at serverSeq; resources follow the held (pending / submitted) intents. */
export function view(serverSeq: number, rows: { tasks: Obj[]; deps?: Obj[]; steps?: Obj[]; workflows?: Obj[]; intents?: Obj[] }, patch: Obj = {}): Obj {
  const v = base(), intents = rows.intents ?? [];
  return { ...v, serverSeq, feature: { ...v.feature, authorityMode: "execution", currentVersion: 0, ...patch }, dag: null,
    tasks: rows.tasks, dependencies: rows.deps ?? [], steps: rows.steps ?? [], workflows: rows.workflows ?? [], intents,
    resources: intents.filter(i => ["pending", "submitted"].includes(i.status)).flatMap(resource), pendingAsks: [] };
}

export function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "s2p-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const setMode = (m: SharedLedgerMode, featureId = "F") => writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: { [featureId]: m } }));
  const rows = (sql: string, ...args: (string | number)[]) => db.query(sql).all(...args) as Obj[];
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { dir, path, db, setMode, rows, close };
}
export type Ledger = ReturnType<typeof ledger>;
/** Trusted instance mapping (S2F supplies it): "local" is this home, peer-a is the local peer "peer-a-name" with fingerprint fp-a. */
export const identity: ProjectionIdentity = { home: "local", peer: (instanceId: string) => instanceId === "peer-a" ? { name: "peer-a-name", fp: "fp-a" } : null };
export const ref: ExecutionProjectionRef = { project: "p", featureId: "F", now: 5000, identity };
export function tables(l: Ledger): Obj {
  const names = l.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name as string);
  return Object.fromEntries(names.map(n => [n, l.rows(`SELECT * FROM "${n}" ORDER BY rowid`)]));
}
