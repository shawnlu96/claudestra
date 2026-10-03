import { expect, test } from "bun:test";
import { fixture } from "./shared-ledger-server-fixture.test.js";
import { sharedLedgerManifestDigest } from "../src/lib/shared-ledger-contract-transfer.js";

function staged(f: ReturnType<typeof fixture>) {
  const manifest = f.manifest();
  manifest.features[0]!.authorityMode = "source";
  const payload = { mode: "commit", batchId: "c6-batch", manifest, manifestDigest: sharedLedgerManifestDigest(manifest) };
  const result = f.call("home", payload, "imports");
  expect(result.status).toBe(200);
  const id = result.body.mappings.find((m: { kind: string }) => m.kind === "feature").id;
  const get = () => f.call("home", null, "imports/c6-batch", "GET");
  const control = (mode: string, person = "home") => f.call(person,
    { mode, batchId: payload.batchId, projectId: manifest.projectId, manifestDigest: payload.manifestDigest }, "imports/c6-batch");
  return { payload, id, get, control };
}

test("staged imports have persistent verified receipts, freeze members, and activate once", () => {
  const f = fixture();
  try {
    const s = staged(f), before = s.get();
    expect(before.body.status).toBe("staged");
    expect(before.body.verification).toEqual({ features: 1, versions: 1, bindings: 1, tasks: 1, sourceSeq: 10, manifestDigest: s.payload.manifestDigest });
    const edit = { type: "feature.set", requestId: "c6-edit", projectId: "project-a", featureId: s.id, expectedRev: 1, patch: { title: "Edited" } };
    expect(f.call("bob", edit).body.code).toBe("execution_not_shared");
    expect(s.control("activate", "bob").status).toBe(403);
    expect(f.call("bob", null, "imports/c6-batch", "GET").status).toBe(403);
    f.restart();
    expect(s.get()).toEqual(before);
    const active = s.control("activate");
    expect(active.body.status).toBe("active");
    expect(s.control("activate")).toEqual(active);
    expect(f.call("bob", edit).status).toBe(200);
    expect(s.control("revoke").status).toBe(409);
    expect(f.call("home", s.payload, "imports").body).toEqual(before.body.receipt);
    expect(f.call("bob", null, `features/${s.id}`, "GET").body.feature.title).toBe("Edited");
  } finally { f.cleanup(); }
});

test("trial revocation is atomic, durable, cannot activate or replay the revoked batch", () => {
  const f = fixture();
  try {
    const s = staged(f), revoked = s.control("revoke");
    expect(revoked.body.status).toBe("revoked");
    f.restart();
    expect(s.get()).toEqual(revoked);
    expect(s.control("revoke")).toEqual(revoked);
    expect(s.control("activate").status).toBe(409);
    expect(f.call("home", s.payload, "imports").status).toBe(409);
    for (const table of ["features", "id_map", "task_mirrors", "step_mirrors", "source_dag_mirrors", "projection_watermarks"]) {
      expect(f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n).toBe(0);
    }
    expect(f.call("home", { ...s.payload, batchId: "new-trial" }, "imports").status).toBe(200);
  } finally { f.cleanup(); }
});

test("verification reads stored rows; drift, cross-project control and changed digest fail closed", () => {
  const f = fixture();
  try {
    const s = staged(f);
    expect(f.call("home", { mode: "activate", batchId: s.payload.batchId, projectId: "project-other", manifestDigest: s.payload.manifestDigest },
      "imports/c6-batch").status).toBe(403);
    expect(f.call("home", { mode: "activate", batchId: s.payload.batchId, projectId: "project-a", manifestDigest: "0".repeat(64) },
      "imports/c6-batch").status).toBe(409);
    const task = f.store.get<{ taskId: string; data: string }>("SELECT taskId,data FROM task_mirrors")!;
    f.store.run("UPDATE task_mirrors SET data=? WHERE taskId=?", JSON.stringify({ ...JSON.parse(task.data), specSummary: "Changed snapshot" }), task.taskId);
    expect(s.get().status).toBe(409);
    expect(s.control("activate").status).toBe(409);
    expect(f.store.get<{ authorityMode: string }>("SELECT authorityMode FROM feature_locations")!.authorityMode).toBe("source");
  } finally { f.cleanup(); }
});
