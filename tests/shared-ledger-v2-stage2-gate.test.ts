import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as writes from "../src/lib/ledger-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { insertEvent, tx } from "../src/lib/ledger-tx.js";
import { IMPORT_ACTOR } from "../src/lib/ledger-checks.js";
import { readSharedLedgerMode, writeSharedLedgerMode } from "../src/lib/shared-ledger-mode.js";
import { PROJECTION_ACTOR, withProjectionScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { execution, fixture, rejected, snapshot, type Fixture } from "./shared-ledger-v2-stage2-gate-helpers.test.js";

const taskWriters: Record<string, (f: Fixture) => unknown> = {
  createTask: f => writes.createTask(f.db, f.owner, { project: "p", id: "new", title: "new", kind: "code", extra: { sharedFeatureId: "F" } }),
  importTask: f => writes.importTask(f.db, { ...f.owner, actor: IMPORT_ACTOR }, { task: {
    project: "p", id: "imported", title: "history", kind: "code", extra: { sharedFeatureId: "F" } }, createdTs: 1, events: [] }),
  setTask: f => writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "changed" } }),
  applyMove: f => tx(f.db, () => writes.applyMove(f.db, f.owner, getTask(f.db, "T")!, { from: "spec", to: "restate" }, true)),
  moveStage: f => writes.moveStage(f.db, f.owner, { taskId: "T", from: "spec", to: "restate" }),
  deliver: f => writes.deliver(f.db, f.owner, { taskId: "T", headSHA: "a".repeat(40) }),
  recordReview: f => writes.recordReview(f.db, f.owner, { taskId: "T", reviewer: "reviewer", verdict: "pass", p0: 0, p1: 0, p2: 0 }),
  recordVerify: f => writes.recordVerify(f.db, f.owner, { taskId: "T", result: "unknown", data: {} }),
  appendEvent: f => writes.appendEvent(f.db, f.owner, { project: "p", target: "T", kind: "note", text: "note" }),
  renameAgentRefs: f => writes.renameAgentRefs(f.db, f.owner, "agent-one", "agent-two"),
};
const projectWriters = ["createItem", "setItem", "setFrozen", "setMeta"];

describe("S2G persistent local write gate", () => {
  test("every exported write function has a scope classification", () => {
    expect(Object.entries(writes).filter(([, value]) => typeof value === "function").map(([name]) => name).sort())
      .toEqual([...Object.keys(taskWriters), ...projectWriters].sort());
  });
  for (const authority of [execution, { authorityMode: "planning" as const, sharedPlanning: true,
    migrating: { batchId: "batch", kind: "execute" as const } }, { ...execution, migrating: { batchId: "batch", kind: "home" as const } }]) {
    for (const [name, write] of Object.entries(taskWriters)) test(`${authority.authorityMode}/${authority.migrating?.kind ?? "steady"}: ${name} rejects atomically`, () => {
      const f = fixture();
      try {
        if (name === "recordReview") f.stage("review");
        if (name === "recordVerify") f.stage("live");
        f.setMode(authority);
        rejected(f, () => write(f));
      } finally { f.close(); }
    });
  }
  for (const authorityMode of ["planning", "source"] as const) test(`${authorityMode}: existing local card behavior stays writable`, () => {
    const f = fixture();
    try {
      f.setMode({ authorityMode, sharedPlanning: authorityMode === "planning" });
      expect(writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "ok" } }).row.title).toBe("ok");
      expect(writes.moveStage(f.db, f.owner, { taskId: "T", from: "spec", to: "restate" }).row.stage).toBe("restate");
      expect(writes.appendEvent(f.db, f.owner, { project: "p", target: "T", kind: "note" }).duplicate).toBe(false);
    } finally { f.close(); }
  });
  for (const patch of [{}, { sharedFeatureId: "other" }]) {
    for (const change of ["set-extra", "sql-extra"] as const) test(`${change} cannot erase old ownership: ${JSON.stringify(patch)}`, () => {
      const f = fixture();
      try {
        f.setMode(execution);
        rejected(f, () => tx(f.db, () => {
          if (change === "set-extra") writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { extra: patch } });
          else f.db.query("UPDATE tasks SET extra=? WHERE id='T'").run(JSON.stringify(patch));
          writes.deliver(f.db, f.owner, { taskId: "T", headSHA: "b".repeat(40) });
        }));
      } finally { f.close(); }
    });
  }
  test("featureId column also protects a card without sharedFeatureId extra", () => {
    const f = fixture();
    try {
      f.db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('F','p','feature','active','owner',1,1)").run();
      f.db.query("UPDATE tasks SET extra='{}',featureId='F' WHERE id='T'").run();
      f.setMode(execution);
      rejected(f, () => tx(f.db, () => {
        f.db.query("UPDATE tasks SET featureId=NULL WHERE id='T'").run();
        writes.appendEvent(f.db, f.owner, { project: "p", target: "T", kind: "note" });
      }));
    } finally { f.close(); }
  });
  test("dedup replay on execution is forbidden; ordinary unrelated card remains writable", () => {
    const f = fixture();
    try {
      writes.appendEvent(f.db, { ...f.owner, dedupKey: "old" }, { project: "p", target: "T", kind: "note" });
      f.setMode(execution);
      rejected(f, () => writes.appendEvent(f.db, { ...f.owner, dedupKey: "old" }, { project: "p", target: "T", kind: "note" }));
      writes.createTask(f.db, f.owner, { project: "p", id: "local", title: "local", kind: "code" });
      expect(writes.setTask(f.db, f.owner, { id: "local", rev: 1, patch: { title: "still local" } }).row.rev).toBe(2);
    } finally { f.close(); }
  });
  test("project metadata and items retain their original scope", () => {
    const f = fixture();
    try {
      f.setMode(execution);
      writes.createItem(f.db, f.owner, { project: "p", id: "I", title: "item" });
      writes.setItem(f.db, f.owner, { project: "p", id: "I", rev: 1, patch: { title: "updated" } });
      writes.setFrozen(f.db, f.owner, { project: "p", frozen: true });
      writes.setMeta(f.db, f.owner, { project: "p", key: "docsDir", value: "docs" });
      expect(getTask(f.db, "T")!.rev).toBe(1);
    } finally { f.close(); }
  });
});

function project(f: Fixture, centerSeq: number, batchId?: string) {
  return tx(f.db, () => withProjectionScope(f.db, { featureId: "F", centerSeq, batchId }, () => {
    f.db.query("UPDATE tasks SET title=?,rev=rev+1 WHERE id='T'").run(`snapshot ${centerSeq}`);
    return insertEvent(f.db, { actor: PROJECTION_ACTOR }, { project: "p", target: "T", kind: "task",
      data: { op: "center-projection", centerSeq: -10, featureId: "spoof" } }, true);
  }));
}
describe("S2G projection authorization", () => {
  test("direct SQL writer stamps the token and increasing center sequence", () => {
    const f = fixture();
    try {
      f.setMode(execution);
      expect(project(f, 5).data).toMatchObject({ featureId: "F", centerSeq: 5 });
      rejected(f, () => project(f, 5));
      rejected(f, () => project(f, 4));
      expect(project(f, 6).data.centerSeq).toBe(6);
      rejected(f, () => tx(f.db, () => {
        project(f, 7);
        f.db.query("UPDATE tasks SET title='after token' WHERE id='T'").run();
      }));
      rejected(f, () => tx(f.db, () => {
        f.db.query("UPDATE tasks SET title='before token' WHERE id='T'").run();
        withProjectionScope(f.db, { featureId: "F", centerSeq: 7 }, () => {});
      }));
    } finally { f.close(); }
  });
  test("migration batch, feature mismatch, actor and token cleanup fail closed", () => {
    const f = fixture();
    try {
      f.setMode({ authorityMode: "source", sharedPlanning: false, migrating: { batchId: "batch", kind: "execute" } });
      rejected(f, () => project(f, 1));
      rejected(f, () => project(f, 1, "wrong"));
      expect(project(f, 1, "batch").data.centerSeq).toBe(1);
      f.db.query("UPDATE tasks SET extra=? WHERE id='T'").run(JSON.stringify({ sharedFeatureId: "other" }));
      rejected(f, () => project(f, 2, "batch"));
      f.db.query("UPDATE tasks SET extra=? WHERE id='T'").run(JSON.stringify({ sharedFeatureId: "F" }));
      rejected(f, () => writes.setTask(f.db, { actor: PROJECTION_ACTOR }, { id: "T", rev: 2, patch: { title: "bare" } }));
      rejected(f, () => writes.moveStage(f.db, { actor: PROJECTION_ACTOR }, { taskId: "T", from: "spec", to: "restate" }));
      const before = snapshot(f);
      expect(() => withProjectionScope(f.db, { featureId: "F", centerSeq: 2, batchId: "batch" }, () => {
        f.db.query("UPDATE tasks SET title='aborted' WHERE id='T'").run();
        throw new Error("writer failed");
      })).toThrow("writer failed");
      expect(snapshot(f)).toEqual(before);
      rejected(f, () => project(f, 2, "wrong"));
      rejected(f, () => writes.setTask(f.db, { actor: PROJECTION_ACTOR }, { id: "T", rev: 2, patch: { title: "bare" } }));
    } finally { f.close(); }
  });
  test("an asynchronous callback, nested token or wrong actor rolls back", () => {
    const f = fixture();
    try {
      f.setMode(execution);
      const ref = { featureId: "F", centerSeq: 1 };
      rejected(f, () => withProjectionScope(f.db, ref, () => Promise.resolve()));
      rejected(f, () => withProjectionScope(f.db, ref, () => withProjectionScope(f.db, ref, () => {})));
      rejected(f, () => withProjectionScope(f.db, ref, () => insertEvent(f.db, f.owner,
        { project: "p", target: "T", kind: "task", data: { op: "center-projection" } }, true)));
    } finally { f.close(); }
  });
});

describe("S2G mode file compatibility", () => {
  test("legacy modes read unchanged; execution and migration fields validate on read and write", async () => {
    const f = fixture();
    try {
      const legacy = { authorityMode: "source" as const, sharedPlanning: true, mirror: true as const };
      f.setMode(legacy);
      expect(readSharedLedgerMode("F", f.dir)).toEqual(legacy);
      await writeSharedLedgerMode("F", execution, f.dir, f.path);
      expect(readSharedLedgerMode("F", f.dir)).toEqual(execution);
      const invalid = [
        { ...execution, authorityMode: "planning" }, { ...execution, centerPlanned: { ...execution.centerExecution } },
        { ...execution, centerExecution: { ...execution.centerExecution, epoch: 0 } },
        { ...execution, migrating: { batchId: "bad/path", kind: "execute" } },
        { ...execution, migrating: { batchId: "batch", kind: "other" } },
      ];
      for (const m of invalid) {
        await expect(writeSharedLedgerMode("F", m as typeof execution, f.dir, f.path)).rejects.toThrow("invalid persistent ledger mode");
        writeFileSync(join(f.dir, "shared-ledger-modes.json"), JSON.stringify({ features: { F: m } }));
        expect(() => readSharedLedgerMode("F", f.dir)).toThrow("shared ledger local state invalid");
      }
    } finally { f.close(); }
  });
});
