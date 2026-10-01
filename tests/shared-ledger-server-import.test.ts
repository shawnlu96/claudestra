import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";

test("import dry-run is read-only; commit idempotent, digest/collision/pending/ref failures are atomic", () => {
  const f = fixture();
  try {
    const m = f.manifest();
    const payload = { mode: "dry-run", batchId: "batch", manifestDigest: sharedLedgerManifestDigest(m), manifest: m };
    expect(f.call("home", payload, "imports").status).toBe(200);
    expect(f.store.get<{ n: number }>("SELECT COUNT(*) n FROM features")!.n).toBe(0);
    expect(f.store.seq()).toBe(0);
    const committed = f.call("home", { ...payload, mode: "commit" }, "imports");
    expect(committed.status).toBe(200);
    f.restart();
    expect(f.call("home", { ...payload, mode: "commit" }, "imports").body).toEqual(committed.body);
    const seq = f.store.seq();
    const changed = structuredClone(m); changed.features[0]!.description = "Different";
    expect(f.call("home", { ...payload, mode: "commit", manifest: changed, manifestDigest: sharedLedgerManifestDigest(changed) }, "imports").body.code).toBe("replayed");
    const collision = structuredClone(m); collision.features[0]!.title = "Other title";
    expect(f.call("home", { ...payload, mode: "commit", batchId: "collision", manifest: collision,
      manifestDigest: sharedLedgerManifestDigest(collision) }, "imports").status).toBe(409);
    const broken = structuredClone(m); broken.features[0]!.sourceFeatureId = "different"; broken.features[0]!.title = "Another";
    broken.features[0]!.versions[0]!.bindings[0]!.taskId = "absent";
    expect(f.call("home", { ...payload, batchId: "missing", manifest: broken, manifestDigest: sharedLedgerManifestDigest(broken) }, "imports").status).toBe(400);
    const pending = structuredClone(m) as any; pending.features[0].pendingProposal = true;
    expect(f.call("home", { ...payload, batchId: "pending", manifest: pending }, "imports").body.code).toBe("pending_proposal");
    const badVersion = structuredClone(m); badVersion.features[0]!.versions[0]!.version = 2;
    expect(f.call("home", { ...payload, batchId: "version", manifest: badVersion,
      manifestDigest: sharedLedgerManifestDigest(badVersion) }, "imports").status).toBe(400);
    expect(f.store.seq()).toBe(seq);
    expect(f.store.get<{ n: number }>("SELECT COUNT(*) n FROM features")!.n).toBe(1);
    const empty = { ...m, features: [] };
    const e = { ...payload, mode: "commit", batchId: "empty", manifest: empty, manifestDigest: sharedLedgerManifestDigest(empty) };
    expect(f.call("home", e, "imports").status).toBe(200);
    expect(f.call("home", { ...e, manifest: m, manifestDigest: sharedLedgerManifestDigest(m) }, "imports").body.code).toBe("replayed");
  } finally { f.cleanup(); }
});

test("late duplicate title rolls back entire group, source-only imports forbid planning commands", () => {
  const f = fixture();
  try {
    f.create("Existing");
    const m = f.manifest("New");
    const second = structuredClone(m.features[0]!);
    second.sourceFeatureId = "second-feature"; second.title = "Existing";
    second.projection.tasks = []; second.versions[0]!.bindings = [];
    m.features.push(second);
    expect(f.call("home", { mode: "commit", batchId: "group", manifest: m, manifestDigest: sharedLedgerManifestDigest(m) }, "imports").status).toBe(409);
    expect(f.store.get<{ n: number }>("SELECT COUNT(*) n FROM id_map")!.n).toBe(0);
    const source = f.manifest("Source"); source.features[0]!.authorityMode = "source";
    const r = f.call("home", { mode: "commit", batchId: "source", manifest: source, manifestDigest: sharedLedgerManifestDigest(source) }, "imports");
    expect(r.status).toBe(200);
    const id = r.body.mappings.find((v: { kind: string }) => v.kind === "feature").id;
    expect(f.call("bob", { type: "feature.set", projectId: "project-a", featureId: id, expectedRev: 1, requestId: "source-change", patch: { title: "Changed" } }).body.code)
      .toBe("execution_not_shared");
  } finally { f.cleanup(); }
});

test("failure during second feature projection rolls back first feature, mappings and events", () => {
  const f = fixture();
  try {
    const m = f.manifest();
    m.features[0]!.projection.events.push({ sourceSeq: 10, sourceTaskId: "source-task", type: "build", at: f.now, summary: "First event" });
    const second = structuredClone(m.features[0]!);
    second.sourceFeatureId = "second"; second.title = "Second";
    second.projection.tasks[0]!.sourceTaskId = "second-task";
    second.versions[0]!.bindings[0]!.taskId = "second-task";
    second.projection.events[0]!.sourceTaskId = "second-task";
    m.features.push(second);
    const r = f.call("home", { mode: "commit", batchId: "late-failure", manifest: m, manifestDigest: sharedLedgerManifestDigest(m) }, "imports");
    expect(r.status).toBe(409);
    for (const table of ["features", "id_map", "events", "task_mirrors", "import_batches"]) {
      expect(f.store.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
    }
  } finally { f.cleanup(); }
});
