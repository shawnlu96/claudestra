import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { isSharedLedgerTaskComplete, recomputeFeatureStates } from "../src/shared-ledger/feature-state.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";
import type { SharedLedgerFeature, SharedLedgerImportManifest } from "../src/lib/shared-ledger-contract.js";

type F = ReturnType<typeof fixture>;
let seq = 10;

/** Imports one feature whose bound tasks carry the given stages. */
function importStages(f: F, stages: string[]): string {
  const m: SharedLedgerImportManifest = f.manifest();
  const source = m.features[0]!;
  const template = source.projection.tasks[0]!;
  const tag = `${stages.join("-")}-${seq}`;
  source.sourceFeatureId = `feature-${tag}`;
  source.title = `Imported ${tag}`;
  const keys = stages.map((_, i) => `n${i}`);
  source.versions = [{ version: 1, nodes: keys.map((k) => f.node(k)), reason: "Initial",
    bindings: keys.map((k) => ({ nodeKey: k, taskId: `task-${tag}-${k}` })) }];
  source.projection.tasks = stages.map((stage, i) => ({ ...structuredClone(template), sourceTaskId: `task-${tag}-n${i}`, stage,
    steps: template.steps.map((s) => ({ ...s, sourceStepId: `step-${tag}-n${i}` })) }));
  source.projection.sourceSeq = m.sourceSeq = ++seq;
  for (const t of source.projection.tasks) { t.sourceSeq = seq; for (const st of t.steps) st.sourceSeq = seq; }
  const r = f.call("home", { mode: "commit", batchId: `batch-${tag}`,
    manifestDigest: sharedLedgerManifestDigest(m), manifest: m }, "imports");
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  return r.body.mappings.find((v: { kind: string }) => v.kind === "feature").id as string;
}
const read = (f: F, id: string): SharedLedgerFeature => f.call("alice", null, `features/${id}`, "GET").body.feature;

test("completion predicate accepts done and verified only", () => {
  expect(isSharedLedgerTaskComplete("done")).toBe(true);
  expect(isSharedLedgerTaskComplete("verified")).toBe(true);
  for (const stage of ["build", "review", "merge", "blocked", "spec"]) expect(isSharedLedgerTaskComplete(stage)).toBe(false);
});

test("all verified, or verified mixed with done, completes the feature", () => {
  const f = fixture();
  try {
    for (const stages of [["verified", "verified", "verified"], ["done", "verified", "done"]]) {
      const feature = read(f, importStages(f, stages));
      expect(feature.counts).toEqual({ total: 3, completed: 3, blocked: 0, missing: 0 });
      expect(feature.status).toBe("done");
    }
  } finally { f.cleanup(); }
});

test("an unfinished task keeps the feature active; blocked still wins over active", () => {
  const f = fixture();
  try {
    for (const open of ["build", "review", "merge"]) {
      const feature = read(f, importStages(f, ["verified", "done", open]));
      expect(feature.counts.completed).toBe(2);
      expect(feature.status).toBe("active");
    }
    const blocked = read(f, importStages(f, ["verified", "blocked"]));
    expect(blocked.counts).toEqual({ total: 2, completed: 1, blocked: 1, missing: 0 });
    expect(blocked.status).toBe("blocked");
  } finally { f.cleanup(); }
});

test("bindings without a mirror stay missing and never count as complete", () => {
  const f = fixture();
  try {
    const id = importStages(f, ["verified", "verified", "verified"]);
    // A binding whose mirror row is absent (e.g. lost source) must stay missing, not be inferred complete.
    const gone = f.store.get<{ taskId: string }>("SELECT taskId FROM task_mirrors WHERE featureId=? ORDER BY taskId LIMIT 1", id)!.taskId;
    f.store.run("DELETE FROM step_mirrors WHERE taskId=?", gone);
    f.store.run("DELETE FROM task_mirrors WHERE taskId=?", gone);
    f.restart();
    const feature = read(f, id);
    expect(feature.counts).toEqual({ total: 3, completed: 2, blocked: 0, missing: 1 });
    expect(feature.status).toBe("active");
  } finally { f.cleanup(); }
});

test("startup repairs rows written under the old rule once, then writes nothing and keeps serverSeq", () => {
  const f = fixture();
  try {
    const id = importStages(f, Array(12).fill("verified"));
    const other = importStages(f, ["verified", "build"]);
    // Simulate the stored state the old `done`-only rule produced.
    const row = f.store.get<{ data: string }>("SELECT data FROM features WHERE id=?", id)!;
    const legacy = { ...JSON.parse(row.data), status: "active" };
    legacy.counts = { ...legacy.counts, completed: 0 };
    f.store.run("UPDATE features SET data=? WHERE id=?", JSON.stringify(legacy), id);
    const otherBefore = f.store.get<{ data: string }>("SELECT data FROM features WHERE id=?", other)!.data;
    const seq = f.store.seq();
    const rev = legacy.rev;
    expect(read(f, id).counts.completed).toBe(0);

    f.restart();
    const repaired = read(f, id);
    expect(repaired.counts.completed).toBe(12);
    expect(repaired.status).toBe("done");
    expect(repaired.rev).toBe(rev);
    expect(f.store.seq()).toBe(seq);
    expect(f.store.get<{ data: string }>("SELECT data FROM features WHERE id=?", other)!.data).toBe(otherBefore);

    const repairedData = f.store.get<{ data: string }>("SELECT data FROM features WHERE id=?", id)!.data;
    f.restart();
    expect(f.store.get<{ n: number }>("SELECT total_changes() n")!.n).toBe(0);
    expect(recomputeFeatureStates(f.store)).toBe(0);
    expect(f.store.get<{ n: number }>("SELECT total_changes() n")!.n).toBe(0);
    expect(f.store.get<{ data: string }>("SELECT data FROM features WHERE id=?", id)!.data).toBe(repairedData);
    expect(f.store.seq()).toBe(seq);
  } finally { f.cleanup(); }
});
