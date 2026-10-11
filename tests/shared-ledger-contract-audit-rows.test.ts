/** CTROWS1: set-level relations of V2 views, snapshots, manifests and receipt lookups. Synthetic ledgers, temp dirs and fake fetch only. */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { v2ManifestDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { assertRowRelations, assertSpecArtifacts } from "../src/lib/shared-ledger-contract-v2-row-relations.js";
import { V2_ROUTES, parseFeatureView } from "../src/lib/shared-ledger-contract-v2-routes.js";
import { V2_FEATURE_VIEW_FIXTURE } from "../src/lib/shared-ledger-contract-v2-routes-fixtures.js";
import { parseMigrationManifest, parseSnapshot } from "../src/lib/shared-ledger-contract-v2-transfer.js";
import { writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { createStage2Transport, type Stage2Connection } from "../src/lib/shared-ledger-v2-transport.js";
import { dep, executionMode, intent, ledger, ref, tables, task, view } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

type Obj = Record<string, any>;
const scope = { teamId: "team", projectId: "project" };
const featureParams = { ...scope, featureId: "feature" };
const snapshot = (fn: (s: Obj) => void = () => {}): Obj => { const s = structuredClone(V2_DTO_FIXTURES.snapshot.valid) as Obj; fn(s); return s; };
const featureView = (fn: (v: Obj) => void = () => {}): Obj => { const v = structuredClone(V2_FEATURE_VIEW_FIXTURE) as Obj; fn(v); return v; };
const manifest = (fn: (m: Obj) => void = () => {}): Obj => {
  const m = structuredClone(V2_DTO_FIXTURES.migrationManifest.valid) as Obj;
  fn(m); m.manifestDigest = v2ManifestDigest(m as { manifestDigest: string });
  return m;
};
const invalid = (fn: () => unknown) => expect(fn).toThrow("invalid_field");
/** Both collection entry points: the feature view (bare parser and route response) and the snapshot. */
function bothReject(mutate: (rows: Obj) => void): void {
  invalid(() => parseFeatureView(featureView(mutate)));
  invalid(() => V2_ROUTES.features.parseResponse(featureView(mutate), featureParams));
  invalid(() => parseSnapshot(snapshot(mutate)));
}
function bothAccept(mutate: (rows: Obj) => void): void {
  expect(parseFeatureView(featureView(mutate)).tasks).toHaveLength(featureView(mutate).tasks.length);
  expect(V2_ROUTES.features.parseResponse(featureView(mutate), featureParams).intents).toHaveLength(featureView(mutate).intents.length);
  expect(parseSnapshot(snapshot(mutate)).intents).toHaveLength(snapshot(mutate).intents.length);
}
function refusedWithZeroWrites(raw: Obj): void {
  const l = ledger();
  try {
    l.setMode(executionMode);
    const before = tables(l);
    let error: (Error & { code?: string }) | null = null;
    try { writeExecutionProjection(l.db, raw, ref); } catch (e) { error = e as Error & { code?: string }; }
    expect([error?.code, error?.message.startsWith("projection_view:")]).toEqual(["invalid", true]);
    expect(tables(l)).toEqual(before);
  } finally { l.close(); }
}

describe("task dependency cycles", () => {
  const edge = (fromTask: string, toTask: string) => ({ ...structuredClone(V2_DTO_FIXTURES.dependency.valid) as Obj, fromTask, toTask });
  const twoTasks = (rows: Obj) => { rows.tasks.push({ ...structuredClone(rows.tasks[0]), id: "task-two" }); };
  test("[验收线 1] a two-task cycle is refused by the feature view and the snapshot", () => {
    bothReject(rows => { twoTasks(rows); rows.dependencies = [edge("task", "task-two"), edge("task-two", "task")]; });
  });
  test("[验收线 1] an ordinary two-task DAG is accepted by both", () => {
    bothAccept(rows => { twoTasks(rows); rows.dependencies = [edge("task", "task-two")]; });
    bothAccept(rows => { twoTasks(rows); rows.dependencies = [edge("task-two", "task")]; });
  });
  test("[验收线 1] a cyclic view sent to the real projection entry writes nothing locally", () => {
    const cyclic = view(10, { tasks: [task("T1"), task("T2")], deps: [dep("T1", "T2"), dep("T2", "T1")] });
    refusedWithZeroWrites(cyclic);
    const l = ledger();
    try {
      l.setMode(executionMode);
      const dag = view(10, { tasks: [task("T1"), task("T2")], deps: [dep("T1", "T2")] });
      expect(writeExecutionProjection(l.db, dag, ref)).toMatchObject({ kind: "written", tasks: ["T1", "T2"] });
      expect(l.rows("SELECT fromTask, toTask FROM task_deps")).toEqual([{ fromTask: "T1", toTask: "T2" }]);
    } finally { l.close(); }
  });
  test("[验收线 1] the shared relation check is the one both entry points run", () => {
    const tasks = [{ id: "a", title: "a" }, { id: "b", title: "b" }, { id: "c", title: "c" }];
    const edges = (...pairs: [string, string][]) => pairs.map(([fromTask, toTask]) => ({ fromTask, toTask }));
    expect(() => assertRowRelations({ tasks, dependencies: edges(["a", "b"], ["b", "c"], ["a", "c"]), intents: [] })).not.toThrow();
    invalid(() => assertRowRelations({ tasks, dependencies: edges(["a", "b"], ["b", "c"], ["c", "a"]), intents: [] }));
  });
});

describe("one operation, one center intent", () => {
  // Same task, action and fence as the fixture intent; only the row id (and here the status) differs.
  const replay = (rows: Obj, patch: Obj) => { rows.intents.push({ ...structuredClone(rows.intents[0]), id: "intent-replay", resources: [], ...patch }); };
  test("[验收线 2] two intents sharing an operationId are refused by both entry points, whatever their status", () => {
    bothReject(rows => replay(rows, { status: "done" }));
    bothReject(rows => replay(rows, {}));
    bothReject(rows => { rows.intents[0].status = "submitted"; replay(rows, { status: "cancelled" }); });
  });
  test("[验收线 2] a second intent under its own operation is accepted by both", () => {
    bothAccept(rows => replay(rows, { status: "done", operationId: "operation-two" }));
    bothAccept(rows => replay(rows, { operationId: "operation-two" }));
  });
  test("[验收线 2] the migration manifest shares the rule", () => {
    const mapped = (m: Obj, operationId: string) => {
      m.intents.push({ ...structuredClone(m.intents[0]), id: "intent-replay", resources: [], status: "done", operationId });
      m.mappings.push({ kind: "intent", sourceInstanceId: "local", sourceId: "old-intent-replay", id: "intent-replay" });
    };
    invalid(() => parseMigrationManifest(manifest(m => mapped(m, "operation"))));
    expect(parseMigrationManifest(manifest(m => mapped(m, "operation-two"))).intents).toHaveLength(2);
  });
  test("[验收线 2] the real projection entry refuses the replayed operation instead of letting the later row win", () => {
    const pending = intent("op1", "T1"), done = intent("op1", "T1", { id: "c-replay", status: "done" });
    refusedWithZeroWrites(view(10, { tasks: [task("T1")], intents: [pending, done] }));
    const l = ledger();
    try {
      l.setMode(executionMode);
      const distinct = view(10, { tasks: [task("T1")], intents: [pending, intent("op2", "T1", { status: "done" })] });
      expect(writeExecutionProjection(l.db, distinct, ref).kind).toBe("written");
      expect(l.rows("SELECT id, status FROM scheduler_intents ORDER BY id")).toEqual([{ id: "op1", status: "pending" }, { id: "op2", status: "done" }]);
    } finally { l.close(); }
  });
  test("[验收线 2] assertRowRelations keys on operationId alone", () => {
    const tasks = [{ id: "a", title: "a" }];
    expect(() => assertRowRelations({ tasks, dependencies: [], intents: [{ operationId: "x" }, { operationId: "y" }] })).not.toThrow();
    invalid(() => assertRowRelations({ tasks, dependencies: [], intents: [{ operationId: "x" }, { operationId: "x" }] }));
  });
});

describe("spec artifact pairing", () => {
  const other = "c".repeat(64);
  const approved = (s: Obj) => { s.tasks = manifest().tasks; };
  const breaks: Record<string, (rows: Obj) => void> = {
    "kind review": rows => { rows.artifacts[0].kind = "review"; },
    "kind report": rows => { rows.artifacts[0].kind = "report"; },
    "artifact originalDigest differs": rows => { rows.artifacts[0].originalDigest = other; },
    "task originalDigest differs": rows => { rows.tasks[0].spec.originalDigest = other; },
  };
  test("[验收线 3] the legal spec pairing passes in the manifest, the migration request and the snapshot", () => {
    expect(parseMigrationManifest(manifest()).artifacts[0].kind).toBe("spec");
    expect(V2_ROUTES.migrations.parseRequest({ mode: "dry-run", manifest: manifest() }, scope).manifest.tasks[0].spec.artifactId).toBe("artifact");
    expect(parseSnapshot(snapshot(approved)).tasks[0].spec.artifactId).toBe("artifact");
    expect(parseSnapshot(snapshot()).tasks[0].spec.artifactId).toBeNull();
  });
  for (const [name, mutate] of Object.entries(breaks)) {
    test(`[验收线 3] migration and snapshot refuse a spec reference with ${name}`, () => {
      invalid(() => parseMigrationManifest(manifest(mutate)));
      invalid(() => V2_ROUTES.migrations.parseRequest({ mode: "commit", manifest: manifest(mutate) }, scope));
      invalid(() => parseSnapshot(snapshot(s => { approved(s); mutate(s); })));
    });
  }
  test("[验收线 3] an unreferenced non-spec artifact stays legal", () => {
    const report = (rows: Obj) => { rows.artifacts.push({ ...structuredClone(rows.artifacts[0]), artifactId: "artifact-report", kind: "report", originalDigest: other }); };
    expect(parseSnapshot(snapshot(s => { approved(s); report(s); })).artifacts).toHaveLength(2);
    const task = { id: "t", specRev: 1, spec: { artifactId: "a", originalDigest: other, sharedDigest: other } };
    const artifact = { artifactId: "a", kind: "spec", taskId: "t", specRev: 1, originalDigest: other, sharedDigest: other };
    expect(() => assertSpecArtifacts([task], [artifact])).not.toThrow();
    for (const patch of [{ kind: "evidence" }, { originalDigest: "d".repeat(64) }, { sharedDigest: "d".repeat(64) }, { taskId: "u" }, { specRev: 2 }]) {
      invalid(() => assertSpecArtifacts([task], [{ ...artifact, ...patch }]));
    }
    invalid(() => assertSpecArtifacts([task], []));
  });
});

describe("receipt lookup operationId", () => {
  const digest = "a".repeat(64);
  const params = (operationId: string | null) => ({ ...scope, requestId: "request", operationId, commandDigest: digest });
  const lookup = (operationId: string | null): Obj => {
    const receipt = structuredClone(V2_DTO_FIXTURES.receipt.valid) as Obj;
    return { ...scope, requestId: "request", status: "committed", receipt: { ...receipt, commandDigest: digest, result: { ...receipt.result, operationId } } };
  };
  test("[验收线 3] a query naming an operation accepts only a receipt of that operation", () => {
    expect(V2_ROUTES.receipts.parseResponse(lookup("operation"), params("operation")).receipt?.result.operationId).toBe("operation");
    invalid(() => V2_ROUTES.receipts.parseResponse(lookup("operation-other"), params("operation")));
    invalid(() => V2_ROUTES.receipts.parseResponse(lookup("operation"), params("operation-other")));
  });
  test("[验收线 3] a receipt without an operation is left to the caller's own check, as the frozen route fixture has it", () => {
    expect(V2_ROUTES.receipts.parseResponse(lookup(null), params("operation")).receipt?.result.operationId).toBeNull();
  });
  test("[验收线 3] a null query keeps its meaning, and unknown stays unknown", () => {
    for (const operationId of ["operation", "operation-other", null]) {
      expect(V2_ROUTES.receipts.parseResponse(lookup(operationId), params(null)).receipt?.result.operationId).toBe(operationId);
    }
    const unknown = { ...scope, requestId: "request", status: "unknown", receipt: null };
    for (const operationId of ["operation", null]) expect(V2_ROUTES.receipts.parseResponse(unknown, params(operationId)).receipt).toBeNull();
  });
  test("[验收线 3] the signed transport over a fake fetch refuses the other operation's receipt", async () => {
    const key = generateKeyPairSync("ed25519");
    let served: string | null = "operation";
    const fetch = (async () => Response.json(lookup(served))) as unknown as NonNullable<Stage2Connection["fetch"]>;
    const t = createStage2Transport({ connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: scope.teamId,
      personId: "person", instanceId: "local", bearer: "synthetic-ctrows1-bearer" }, projectId: scope.projectId,
      key: { privateKey: key.privateKey, publicKey: String(key.publicKey.export({ format: "jwk" }).x) }, fetch });
    const query = { requestId: "request", operationId: "operation", commandDigest: digest };
    expect((await t.receipt(query)).receipt?.result.operationId).toBe("operation");
    served = "operation-other";
    await expect(t.receipt(query)).rejects.toThrow();
    expect((await t.receipt({ ...query, operationId: null })).receipt?.result.operationId).toBe("operation-other");
  });
});
