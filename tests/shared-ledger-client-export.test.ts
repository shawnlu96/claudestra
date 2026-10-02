import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { previewSharedLedgerExport, dryRunSharedLedgerExport, migrateSharedLedgerExport } from "../src/lib/shared-ledger-export.js";
import { writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { SharedLedgerClient, SharedLedgerUnavailable } from "../src/lib/shared-ledger-client.js";
import { fakeConnection, fakeKey } from "./shared-ledger-client.test.js";

test("read-only export is deterministic, includes historical bindings and never uploads local columns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-fake-export-"));
  const path = join(dir, "fake.sqlite");
  const db = openLedger(path);
  try {
    createTask(db, { actor: "owner", now: 1000 }, { project: "fake-local-project", id: "fake-task", title: "Fake task", kind: "code" });
    db.prepare("UPDATE tasks SET spec = ?, extra = ?, assignee = ? WHERE id = ?")
      .run("/Users/fake-user/private-spec", JSON.stringify({ sessionId: "fake-session", token: "obviously-fake-secret", docsDir: "/fake/local" }),
        "fake-user", "fake-task");
    db.prepare("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("fake-feature", "fake-local-project", "Fake feature", "Team visible plan", "active", 2, 1, "fake-user", 1000, 1000);
    const nodes = [{ key: "A", taskId: null, oneLine: "Build", deps: [], status: "planned", estimate: "S", inheritedFrom: null }];
    for (const version of [1, 2]) {
      db.prepare("INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, createdAt, nodes) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("fake-feature", version, version === 1 ? "initial" : "new_issue", "Team visible reason", "fake-user", 1000, JSON.stringify(nodes));
      db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, ?, ?, ?, ?, ?)")
        .run("fake-feature", version, "A", "fake-task", "fake-user", 1000);
    }
    const options = { localProject: "fake-local-project", projectId: "fake-project", sourceInstanceId: "fake-instance",
      featureIds: ["fake-feature"], batchId: "fake-batch", stateDir: dir,
      scrub: { identity: { username: "fake-user", hostname: "fake-host" } }, summaries: { "fake-task": { summary: "Reviewed team summary", digest: null } } };
    expect(() => previewSharedLedgerExport(db, options)).toThrow("preview requires persistent planning gate");
    await writeSharedLedgerMode("fake-feature", { authorityMode: "source", sharedPlanning: true }, dir);
    const before = db.serialize();
    const a = previewSharedLedgerExport(db, options);
    const b = previewSharedLedgerExport(db, options);
    expect(a.payload.manifestDigest).toBe(b.payload.manifestDigest);
    expect(a.preview).toBe(b.preview);
    expect(db.serialize().equals(before)).toBe(true);
    expect(a.payload.manifest.features[0]!.versions.map((v) => v.bindings)).toEqual([
      [{ nodeKey: "A", taskId: "fake-task" }], [{ nodeKey: "A", taskId: "fake-task" }]]);
    expect(a.payload.manifest.features[0]!.projection.tasks[0]!.specSummary).toBe("Reviewed team summary");
    for (const local of ["fake-user", "fake-session", "obviously-fake-secret", "/Users/", "docsDir", "sessionId", "extra", "\"spec\": "]) {
      expect(a.preview).not.toContain(local);
    }
    let calls = 0;
    const batches: unknown[] = [];
    const fetcher = (async (_url, init) => {
      const envelope = JSON.parse(init!.body as string);
      batches.push(envelope.payload); calls++;
      if (calls === 1) return new Response("fake lost response", { status: 502 });
      return Response.json({ schemaVersion: 1, mode: envelope.payload.mode, batchId: "fake-batch", manifestDigest: a.payload.manifestDigest,
        serverSeq: 1, mappings: [] });
    }) as typeof fetch;
    const client = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: fetcher });

    expect((await migrateSharedLedgerExport(client, a.payload, a.payload.manifestDigest, db, dir)).mode).toBe("commit");
    expect(batches[0]).toEqual(batches[1]);
    expect((await dryRunSharedLedgerExport(client, a.payload)).mode).toBe("dry-run");
    await expect(migrateSharedLedgerExport(client, a.payload, "fake-wrong-digest", db, dir)).rejects.toThrow("approval mismatch");
    expect(db.serialize().equals(before)).toBe(true);
    const offline = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: (async () => { throw new Error("fake offline"); }) as unknown as typeof fetch });
    await expect(dryRunSharedLedgerExport(offline, a.payload)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});

test("preview v1 then local v2 rejects stale commit even while the gate remains installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-ledger-fake-stale-"));
  const path = join(dir, "fake.sqlite");
  const db = openLedger(path);
  try {
    db.prepare("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) "
      + "VALUES ('fake-stale', 'fake-local', 'Plan', '', 'active', 1, 1, 'fake-member', 1, 1)").run();
    const addVersion = (version: number) => db.prepare(
      "INSERT INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes) VALUES ('fake-stale', ?, ?, 'fake-member', 1, '[]')")
      .run(version, version === 1 ? "initial" : "new_issue");
    addVersion(1);
    await writeSharedLedgerMode("fake-stale", { authorityMode: "source", sharedPlanning: true }, dir);
    const preview = previewSharedLedgerExport(db, { localProject: "fake-local", projectId: "fake-project", sourceInstanceId: "fake-instance",
      featureIds: ["fake-stale"], batchId: "fake-stale-batch", stateDir: dir, summaries: {},
      scrub: { identity: { username: "fake-user", hostname: "fake-host" } } });
    addVersion(2);
    db.prepare("UPDATE features SET currentVersion = 2 WHERE id = 'fake-stale'").run();
    let calls = 0;
    const client = new SharedLedgerClient(fakeConnection, fakeKey(), {
      fetch: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
    await expect(migrateSharedLedgerExport(client, preview.payload, preview.payload.manifestDigest, db, dir)).rejects.toThrow("planning changed");
    expect(calls).toBe(0);
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});
