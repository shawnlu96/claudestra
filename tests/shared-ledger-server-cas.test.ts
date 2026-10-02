import { test, expect } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";

test("different nodes still conflict on feature CAS; snapshot and new-key retry", () => {
  const f = fixture();
  try {
    const id = f.create();
    const first = { type: "dag.init", featureId: id, projectId: "project-a", expectedRev: 1, baseVersion: 0,
      nodes: [f.node(), f.node("n2")], reason: "Initial", requestId: "init" };
    expect(f.call("alice", first).status).toBe(200);
    const rewrite = { ...first, type: "dag.rewrite", expectedRev: 2, baseVersion: 1, requestId: "alice-edit" };
    rewrite.nodes[0]!.oneLine = "First change";
    expect(f.call("alice", rewrite).status).toBe(200);
    const seq = f.store.seq();
    const bob = { ...rewrite, requestId: "bob-edit", nodes: [f.node(), { ...f.node("n2"), oneLine: "Second change" }] };
    const loser = f.call("bob", bob);
    expect(loser.status).toBe(409);
    expect(loser.body.currentRev).toBe(3);
    expect(loser.body.currentVersion).toBe(2);
    expect(loser.body.latest.dag.nodes[0].oneLine).toBe("First change");
    expect(loser.body.modifiedBy).toBe("alice");
    expect(f.store.seq()).toBe(seq);
    expect(f.store.get<{ n: number }>("SELECT COUNT(*) n FROM dag_versions")!.n).toBe(2);
    expect(f.call("bob", { ...bob, expectedRev: 3, baseVersion: 2, requestId: "bob-retry" }).status).toBe(200);
  } finally { f.cleanup(); }
});

test("same title conflicts point to existing feature; no-read conflicts have no snapshot", () => {
  const f = fixture();
  try {
    const id = f.create();
    const duplicate = { type: "feature.new", projectId: "project-a", requestId: "dupe", title: "Feature", description: "", homeInstanceId: "instance-home" };
    expect(f.call("bob", duplicate).body.latest.feature.id).toBe(id);
    f.add("writer", "member", "project-a", ["plan"]);
    const hidden = f.call("writer", duplicate);
    expect(hidden.status).toBe(409);
    expect(hidden.body.code).toBe("replayed");
    expect(hidden.body.latest).toBeUndefined();
    expect(f.call("writer", { type: "feature.set", projectId: "project-a", featureId: id, requestId: "stale", expectedRev: 99,
      patch: { description: "Changed" } }).body.latest).toBeUndefined();
  } finally { f.cleanup(); }
});
