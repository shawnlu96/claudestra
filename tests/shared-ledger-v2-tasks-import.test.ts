import { expect, test } from "bun:test";
import { parseMigrationManifest, v2ManifestDigest, type V2Command } from "../src/lib/shared-ledger-contract-v2";
import { importTaskRows } from "../src/shared-ledger/exec-tasks/import";
import { recordCommit, findReceipt } from "../src/shared-ledger/exec-tasks/journal";
import { registerMapping } from "../src/shared-ledger/exec-tasks/storage";
import { command, harness, fixtureManifest } from "./shared-ledger-v2-tasks-harness.test";

function migration(h: ReturnType<typeof harness>, input = fixtureManifest()) {
  const manifest = parseMigrationManifest({ ...input, manifestDigest: v2ManifestDigest(input as { manifestDigest: string }) });
  const c = command("migration.commit", { manifestDigest: manifest.manifestDigest }) as V2Command;
  return h.tx(ctx => {
    const old = findReceipt(ctx, c); if (old) return old;
    importTaskRows(ctx, h.deps, c, manifest);
    return recordCommit(ctx, c, { entityId: "feature", rev: 1, specRev: null, version: null, epoch: 1, operationId: null }, "migration");
  });
}
test("frozen manifest imports whitelisted rows with audited bijective local/central ID mappings", () => {
  const h = harness(false); const receipt = migration(h);
  const rows = h.db.query("SELECT * FROM exec_task_id_map ORDER BY kind").all() as Record<string, unknown>[];
  expect(rows).toHaveLength(2);
  expect(rows[1]).toEqual({ teamId: "team", projectId: "project", kind: "task", sourceInstanceId: "local",
    sourceId: "old-task", id: "task", registeredBy: "person", registeredInstanceId: "local", registeredAt: 2000 });
  const before = h.snapshot(); expect(migration(h)).toEqual(receipt); expect(h.snapshot()).toEqual(before);
  for (const field of ["extra", "unrecognized"]) {
    const input = fixtureManifest(); input.tasks[0][field] = {};
    expect(() => migration(h, input)).toThrow("invalid_field"); expect(h.snapshot()).toEqual(before);
  }
  expect(() => h.db.run("UPDATE exec_task_id_map SET sourceId='other'")).toThrow("immutable");
  expect(() => h.db.run("DELETE FROM exec_task_id_map")).toThrow("immutable");
});
test("mapping conflicts in either direction or across source instances never overwrite", () => {
  const h = harness(false); migration(h);
  const mapping = { kind: "task", sourceInstanceId: "local", sourceId: "old-task", id: "task" };
  const before = h.snapshot();
  h.tx(ctx => registerMapping(ctx, mapping)); expect(h.snapshot()).toEqual(before);
  for (const patch of [{ id: "other" }, { sourceId: "other" }, { sourceInstanceId: "peer-a" }]) {
    expect(() => h.tx(ctx => registerMapping(ctx, { ...mapping, ...patch }))).toThrow("conflict");
    expect(h.snapshot()).toEqual(before);
  }
});
test("import mapping conflict and downstream receipt failure roll back imported rows and versions", () => {
  const h = harness(false);
  h.tx(ctx => registerMapping(ctx, { kind: "task", sourceInstanceId: "local", sourceId: "old-task", id: "other" }));
  const before = h.snapshot(); expect(() => migration(h)).toThrow("conflict"); expect(h.snapshot()).toEqual(before);
  const other = harness(false), empty = other.snapshot();
  other.db.exec("CREATE TRIGGER failed_receipt BEFORE INSERT ON exec_command_receipts BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
  expect(() => migration(other)).toThrow("receipt failed"); expect(other.snapshot()).toEqual(empty);
});
test("manifest source mappings and migration authorization are required", () => {
  const h = harness(false); h.denied.add("migration.commit");
  expect(() => migration(h)).toThrow("forbidden");
  h.denied.clear(); const m = fixtureManifest(); m.mappings[0].sourceInstanceId = "peer-a";
  expect(() => migration(h, m)).toThrow("invalid_field");
});
