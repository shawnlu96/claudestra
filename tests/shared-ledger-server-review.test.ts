import { test, expect } from "bun:test";
import { registerCredential } from "../src/shared-ledger/identity.js";
import type { SharedLedgerCredential } from "../src/lib/shared-ledger-auth.js";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";

test("owner home without projecting service is rejected before import writes; new member plans remain allowed", () => {
  const f = fixture();
  try {
    f.add("owner", "owner");
    const m = f.manifest(); m.sourceInstanceId = "instance-owner";
    const r = f.call("owner", { mode: "commit", batchId: "owner-import", manifest: m,
      manifestDigest: sharedLedgerManifestDigest(m) }, "imports");
    expect(r.status).toBe(403);
    expect(r.body.message).toBe("主场没有可投影的服务身份");
    for (const table of ["features", "id_map", "events", "task_mirrors", "import_batches"]) {
      expect(f.store.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
    }
    expect(f.call("alice", { type: "feature.new", projectId: "project-a", requestId: "member-plan", title: "Member plan",
      description: "Unexecuted", homeInstanceId: "instance-alice" }).status).toBe(200);
    const { id, manifest } = f.imported();
    expect(f.call("home", f.projection(id, manifest), "projections").status).toBe(200);
    expect(f.call("alice", null, `features/${id}`, "GET").body.feature.projection.sourceSeq).toBe(11);
  } finally { f.cleanup(); }
});

test("import requires an active unexpired service credential with the project action", () => {
  const f = fixture();
  try {
    f.add("owner", "owner");
    const m = f.manifest(); m.sourceInstanceId = "instance-owner";
    const owner = f.credentials.get("owner")!;
    for (const grant of [
      { role: "service", actions: ["read"], expiresAt: f.now + 100000 },
      { role: "service", actions: ["project"], expiresAt: f.now },
      { role: "member", actions: ["project"], expiresAt: f.now + 100000 },
    ] as { role: SharedLedgerCredential["projects"][number]["role"]; actions: SharedLedgerCredential["projects"][number]["actions"]; expiresAt: number }[]) {
      registerCredential(f.store, { ...owner, credentialHash: "a".repeat(64), expiresAt: grant.expiresAt,
        projects: [{ projectId: "project-a", role: grant.role, actions: grant.actions }] }, "owner");
      expect(f.call("owner", { mode: "commit", batchId: "invalid-service", manifest: m,
        manifestDigest: sharedLedgerManifestDigest(m) }, "imports").status).toBe(403);
    }
    expect(f.store.seq()).toBe(0);
  } finally { f.cleanup(); }
});

test("adding an unbound node to a completed imported DAG refreshes status and counts", () => {
  const f = fixture();
  try {
    const m = f.manifest(); m.features[0]!.projection.tasks[0]!.stage = "done";
    const imported = f.call("home", { mode: "commit", batchId: "done-import", manifest: m,
      manifestDigest: sharedLedgerManifestDigest(m) }, "imports");
    expect(imported.status).toBe(200);
    const id = imported.body.mappings.find((v: { kind: string }) => v.kind === "feature").id;
    expect(f.call("bob", null, `features/${id}`, "GET").body.feature.status).toBe("done");
    expect(f.call("bob", { type: "dag.rewrite", featureId: id, projectId: "project-a", expectedRev: 1, baseVersion: 1,
      requestId: "add-unbound", nodes: [f.node(), f.node("n2")], reason: "More work" }).status).toBe(200);
    const feature = f.call("bob", null, `features/${id}`, "GET").body.feature;
    expect(feature.status).not.toBe("done");
    expect(feature.counts).toMatchObject({ completed: 1, total: 2 });
  } finally { f.cleanup(); }
});
