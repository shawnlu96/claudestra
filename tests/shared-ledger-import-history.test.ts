/** mirror-import-R1: a source home's legal DAG history replays through the signed import entry; online planning rules stay intact. */
import { expect, test } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import type { SharedLedgerImportManifest } from "../src/lib/shared-ledger-contract.js";

type Fixture = ReturnType<typeof fixture>;
type Feature = SharedLedgerImportManifest["features"][number];

/** Synthetic two-version history: the bound node keeps nodeKey/taskId while oneLine/estimate/fileGlobs/deps are revised. */
function history(f: Fixture, authorityMode: "source" | "planning" = "source", title = "Imported"): SharedLedgerImportManifest {
  const m = f.manifest(title);
  const source = m.features[0]!;
  source.authorityMode = authorityMode;
  source.projection.tasks.push({ ...structuredClone(source.projection.tasks[0]!), sourceTaskId: "source-task-2",
    steps: [{ sourceStepId: "step-b", sourceRev: 1, sourceSeq: 10, state: "running" }] });
  source.versions = [
    { version: 1, reason: "Initial", bindings: [{ nodeKey: "n1", taskId: "source-task" }],
      nodes: [{ ...f.node("n1"), oneLine: "Plan A sample" }, f.node("n2")] },
    { version: 2, reason: "Switch approach", bindings: [{ nodeKey: "n1", taskId: "source-task" }, { nodeKey: "n2", taskId: "source-task-2" }],
      nodes: [{ ...f.node("n1"), oneLine: "Plan B sample", estimate: "3h", fileGlobs: ["src/other.ts"], deps: ["n2"] }, f.node("n2")] },
  ];
  return m;
}
const payload = (m: SharedLedgerImportManifest, mode: "dry-run" | "commit", batchId = "history-batch") =>
  ({ mode, batchId, manifest: m, manifestDigest: sharedLedgerManifestDigest(m) });
const count = (f: Fixture, table: string) => f.store.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n;
const BUSINESS = ["features", "id_map", "source_dag_mirrors", "dag_versions", "dag_bindings", "task_mirrors", "step_mirrors",
  "events", "import_batches", "import_lifecycle", "feature_locations", "projection_watermarks"];

test("source authority two-version history with same bindings: dry-run and commit succeed, history kept verbatim", () => {
  const f = fixture();
  try {
    const m = history(f);
    const dry = f.call("home", payload(m, "dry-run"), "imports");
    expect(dry.body.code).toBeUndefined();
    expect(dry.status).toBe(200);
    for (const table of BUSINESS) expect(count(f, table)).toBe(0);
    expect(f.store.seq()).toBe(0);

    const committed = f.call("home", payload(m, "commit"), "imports");
    expect(committed.status).toBe(200);
    const id = committed.body.mappings.find((v: { kind: string }) => v.kind === "feature").id as string;
    const taskId = (sourceId: string) => committed.body.mappings.find((v: { sourceId: string }) => v.sourceId === sourceId).id as string;
    const rows = f.store.all<{ version: number; data: string }>("SELECT version,data FROM source_dag_mirrors WHERE featureId=? ORDER BY version", id);
    expect(rows.map((r) => JSON.parse(r.data))).toEqual(m.features[0]!.versions.map((v) =>
      ({ ...v, bindings: v.bindings.map((b) => ({ ...b, taskId: taskId(b.taskId) })) })));
    expect(count(f, "dag_versions") + count(f, "dag_bindings")).toBe(0);

    const receipt = f.call("home", null, "imports/history-batch", "GET");
    expect(receipt.body.status).toBe("staged");
    expect(receipt.body.verification).toEqual({ features: 1, versions: 2, bindings: 3, tasks: 2, sourceSeq: 10,
      manifestDigest: sharedLedgerManifestDigest(m) });
    const read = f.call("home", null, `features/${id}`, "GET").body;
    expect(read.feature.authorityMode).toBe("source");
    expect(read.feature.version).toBe(2);
    expect(read.feature.projection.sourceSeq).toBe(10);
    // Idempotent replay of the same batch; a different digest under the same batch id is refused.
    expect(f.call("home", payload(m, "commit"), "imports").body).toEqual(committed.body);
    const changed = structuredClone(m); changed.features[0]!.versions[1]!.reason = "Changed";
    expect(f.call("home", payload(changed, "commit"), "imports").body.code).toBe("replayed");
  } finally { f.cleanup(); }
});

test("historical binding tampering is still refused and leaves no rows", () => {
  const f = fixture();
  try {
    const cases: [string, (s: Feature) => void][] = [
      ["removed", (s) => { s.versions[1]!.bindings = s.versions[1]!.bindings.filter((b) => b.nodeKey !== "n1"); }],
      ["moved to another task", (s) => { s.versions[1]!.bindings = [{ nodeKey: "n1", taskId: "source-task-2" }, { nodeKey: "n2", taskId: "source-task" }]; }],
      ["moved to another node", (s) => { s.versions[1]!.bindings = [{ nodeKey: "n2", taskId: "source-task" }]; }],
      ["bound node deleted", (s) => {
        s.versions[1]!.nodes = [f.node("n2")]; s.versions[1]!.bindings = [{ nodeKey: "n2", taskId: "source-task-2" }];
      }],
    ];
    for (const [label, tamper] of cases) {
      const m = history(f);
      tamper(m.features[0]!);
      const r = f.call("home", payload(m, "commit", `tamper-${label.replaceAll(" ", "-")}`), "imports");
      expect([label, r.status]).toEqual([label, 400]);
      expect([label, r.body.code]).toEqual([label, "invalid_field"]);
    }
    // Version order and graph validity are still enforced on history.
    const order = history(f); order.features[0]!.versions.reverse();
    expect(f.call("home", payload(order, "commit", "order"), "imports").status).toBe(400);
    const cycle = history(f); cycle.features[0]!.versions[1]!.nodes[1]!.deps = ["n1"];
    expect(() => sharedLedgerManifestDigest(cycle)).toThrow("invalid_field");
    expect(f.call("home", { mode: "commit", batchId: "cycle", manifest: cycle, manifestDigest: "0".repeat(64) }, "imports").status).toBe(400);
    for (const table of BUSINESS) expect(count(f, table)).toBe(0);
  } finally { f.cleanup(); }
});

test("failing second feature rolls back a valid first history: no partial rows, mappings or sequence", () => {
  const f = fixture();
  try {
    const m = history(f);
    const second = structuredClone(m.features[0]!);
    second.sourceFeatureId = "second-feature"; second.title = "Second";
    for (const t of second.projection.tasks) t.sourceTaskId = `second-${t.sourceTaskId}`;
    for (const v of second.versions) v.bindings = v.bindings.map((b) => ({ ...b, taskId: `second-${b.taskId}` }));
    second.versions[1]!.bindings = second.versions[1]!.bindings.filter((b) => b.nodeKey !== "n1");
    m.features.push(second);
    for (const mode of ["dry-run", "commit"] as const) {
      const r = f.call("home", payload(m, mode), "imports");
      expect(r.body.code).toBe("invalid_field");
      for (const table of BUSINESS) expect(count(f, table)).toBe(0);
      expect(f.store.seq()).toBe(0);
    }
  } finally { f.cleanup(); }
});

test("source mode stays frozen online; activation is explicit and online bound-node edits are still refused", () => {
  const f = fixture();
  try {
    const m = history(f);
    const r = f.call("home", payload(m, "commit"), "imports");
    expect(r.status).toBe(200);
    const id = r.body.mappings.find((v: { kind: string }) => v.kind === "feature").id as string;
    const nodes = m.features[0]!.versions[1]!.nodes;
    const rewrite = (requestId: string, oneLine: string, person = "bob") => f.call(person, { type: "dag.rewrite", requestId, projectId: "project-a",
      featureId: id, expectedRev: 1, baseVersion: 2, reason: "Online edit", nodes: [{ ...nodes[0]!, oneLine }, nodes[1]!] });
    expect(rewrite("source-plan", "Plan C sample").body.code).toBe("execution_not_shared");
    expect(rewrite("source-plan-home", "Plan C sample", "home").body.code).toBe("execution_not_shared");
    expect(f.call("bob", { type: "feature.set", requestId: "source-set", projectId: "project-a", featureId: id, expectedRev: 1,
      patch: { title: "Changed" } }).body.code).toBe("execution_not_shared");
    expect(f.call("bob", { type: "approval", requestId: "source-approve", projectId: "project-a", featureId: id }).body.code)
      .toBe("execution_not_shared");
    // Import never activates or turns execution on by itself.
    expect(f.call("home", null, "imports/history-batch", "GET").body.status).toBe("staged");
    expect(f.store.get<{ authorityMode: string }>("SELECT authorityMode FROM feature_locations WHERE featureId=?", id)!.authorityMode).toBe("source");

    const control = (mode: string) => f.call("home", { mode, batchId: "history-batch", projectId: "project-a",
      manifestDigest: sharedLedgerManifestDigest(m) }, "imports/history-batch");
    expect(control("activate").body.status).toBe("active");
    expect(f.call("bob", null, `features/${id}`, "GET").body.feature.authorityMode).toBe("planning");
    expect(rewrite("planning-bound", "Plan C sample").body.code).toBe("execution_not_shared");
    const unbound = f.call("bob", { type: "dag.rewrite", requestId: "planning-unbound", projectId: "project-a", featureId: id,
      expectedRev: 1, baseVersion: 2, reason: "Online edit", nodes: [...nodes, f.node("n3")] });
    expect(unbound.status).toBe(200);
  } finally { f.cleanup(); }
});

test("planning-authority imports keep the online rule for history; source revoke and cross-project stay closed", () => {
  const f = fixture();
  try {
    expect(f.call("home", payload(history(f, "planning"), "commit", "planning-history"), "imports").body.code).toBe("execution_not_shared");
    for (const table of BUSINESS) expect(count(f, table)).toBe(0);

    const other = history(f); other.projectId = "project-b";
    expect(f.call("home", payload(other, "commit", "other-project"), "imports").status).toBe(403);
    const foreign = history(f); foreign.sourceInstanceId = "instance-alice";
    expect(f.call("home", payload(foreign, "commit", "foreign-source"), "imports").status).toBe(403);

    const m = history(f);
    expect(f.call("home", payload(m, "commit"), "imports").status).toBe(200);
    const revoked = f.call("home", { mode: "revoke", batchId: "history-batch", projectId: "project-a",
      manifestDigest: sharedLedgerManifestDigest(m) }, "imports/history-batch");
    expect(revoked.body.status).toBe("revoked");
    for (const table of ["features", "id_map", "source_dag_mirrors", "task_mirrors", "step_mirrors"]) expect(count(f, table)).toBe(0);
  } finally { f.cleanup(); }
});
