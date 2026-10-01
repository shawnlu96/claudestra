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
    await expect(migrateSharedLedgerExport(client, a.payload, a.payload.manifestDigest, dir)).rejects.toThrow("persistent planning gate");
    await writeSharedLedgerMode("fake-feature", { authorityMode: "source", sharedPlanning: true }, dir);
    expect((await migrateSharedLedgerExport(client, a.payload, a.payload.manifestDigest, dir)).mode).toBe("commit");
    expect(batches[0]).toEqual(batches[1]);
    expect((await dryRunSharedLedgerExport(client, a.payload)).mode).toBe("dry-run");
    await expect(migrateSharedLedgerExport(client, a.payload, "fake-wrong-digest", dir)).rejects.toThrow("approval mismatch");
    expect(db.serialize().equals(before)).toBe(true);
    const offline = new SharedLedgerClient(fakeConnection, fakeKey(), { fetch: (async () => { throw new Error("fake offline"); }) as unknown as typeof fetch });
    await expect(dryRunSharedLedgerExport(offline, a.payload)).rejects.toBeInstanceOf(SharedLedgerUnavailable);
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});
