import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSharedLedgerImport } from "../scripts/shared-ledger-import.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { readSharedLedgerMode, writeSharedLedgerModes } from "../src/lib/shared-ledger-mode.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "c6-migrate-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const id = "c600-plan", project = "project-a";
  db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) "
    + "VALUES (?,?, 'Team plan', 'Shared description', 'active', 1, 1, 'owner', 1, 1)").run(id, project);
  db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,1,'initial','Plan','owner',1,?)")
    .run(id, JSON.stringify([{ key: "next", taskId: null, oneLine: "Next", deps: [], fileGlobs: ["src/sample.ts"], estimate: "1h" }]));
  const options = { stateDir: dir, localProject: project, projectId: "shared-project", sourceInstanceId: "peer-a", featureIds: [id],
    batchId: "batch-a", summaries: {}, scrub: { identity: { username: "private-person", hostname: "private-machine" } } };
  const event = (data: unknown, dedup: string, target = id) => db.prepare(
    "INSERT INTO events(ts,actor,project,target,kind,text,data,dedupKey) VALUES (1,'owner',?,?,'feature','',?,?)")
    .run(project, target, JSON.stringify(data), dedup);
  return { dir, db, id, options, event, close() { closeLedger(path); rmSync(dir, { recursive: true, force: true }); } };
}

test("prepare backs up before gate, preserves the reviewed snapshot and same-batch identity", async () => {
  const f = fixture();
  try {
    const a = await prepareSharedLedgerImport(f.db, f.options);
    expect(readSharedLedgerMode(f.id, f.dir)).toEqual({ authorityMode: "source", sharedPlanning: true });
    expect(statSync(a.backup).mode & 0o777).toBe(0o600);
    const backup = new Database(a.backup, { readonly: true });
    expect(backup.query("SELECT title FROM features").get()).toEqual({ title: "Team plan" });
    backup.close();
    f.event({ op: "execution-progress" }, "progress");
    const b = await prepareSharedLedgerImport(f.db, f.options);
    expect(b).toEqual(a);
    await expect(prepareSharedLedgerImport(f.db, { ...f.options, projectId: "other" })).rejects.toThrow("selection changed");
    await expect(prepareSharedLedgerImport(f.db, { ...f.options, batchId: "batch-b" })).rejects.toThrow("already migrating");
    const raw = readFileSync(join(f.dir, "shared-ledger-migrations", "batch-a.json"), "utf8");
    expect(raw).not.toContain("private-person");
    expect(raw).not.toContain("private-machine");
  } finally { f.close(); }
});

test("pending proposal anywhere in the selection blocks the whole group before installing gates", async () => {
  const f = fixture();
  try {
    const second = "c600-second";
    f.db.prepare("INSERT INTO features SELECT ?,project,'Second',ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt FROM features WHERE id=?")
      .run(second, f.id);
    f.options.featureIds = [second, f.id];
    f.db.prepare("INSERT INTO dag_proposals(featureId,version,baseVersion,reasonKind,reasonText,proposedBy,nodes,cancels,scopeChange,sha,askId,createdAt,state) "
      + "VALUES (?,2,1,'new_issue','Review','owner','[]','[]',1,'digest','ask',1,'pending')").run(f.id);
    await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("pending proposal");
    expect(readSharedLedgerMode(f.id, f.dir).sharedPlanning).toBe(false);
    expect(readSharedLedgerMode(second, f.dir).sharedPlanning).toBe(false);
    expect(existsSync(join(f.dir, "shared-ledger-migrations", "batch-a.backup.sqlite"))).toBe(false);
  } finally { f.close(); }
});

for (const outcome of [null, "unknown", "failed-with-leftovers", "manual"]) {
  test(`prepare blocks ${outcome ?? "in-flight"} start without treating a timeout as failure`, async () => {
    const f = fixture();
    try {
      if (outcome === "manual") f.event({ op: "new" }, "dag-start:card:attempt:task-new", "card");
      else {
        const claim = f.event({ op: "autostart_claim", taskId: "card" }, "autostart:plan:next:arm");
        if (outcome) f.event({ op: "autostart_settle", outcome: outcome === "unknown" ? outcome : "failed", leftovers: ["unresolved"] },
          `autostart-settle:${claim.lastInsertRowid}`);
      }
      await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("migration blocked");
      expect(readSharedLedgerMode(f.id, f.dir).sharedPlanning).toBe(false);
    } finally { f.close(); }
  });
}

test("sensitive fields and missing references cannot produce a package, and retain the installed gate", async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE features SET ownerWords = ?").run("private-person");
    await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("upload blocked");
    expect(readSharedLedgerMode(f.id, f.dir).sharedPlanning).toBe(true);
    f.db.prepare("UPDATE features SET ownerWords = 'Reviewed description'").run();
    f.db.prepare("INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,createdAt,nodes) VALUES (?,2,'new_issue','Plan','owner',1,?)")
      .run(f.id, JSON.stringify([
      { key: "next", taskId: "missing-card", oneLine: "Next", deps: [], estimate: "1h" },
    ]));
    f.db.prepare("UPDATE features SET currentVersion = 2").run();
    await expect(prepareSharedLedgerImport(f.db, f.options)).rejects.toThrow("upload blocked");
    expect(readSharedLedgerMode(f.id, f.dir).sharedPlanning).toBe(true);
  } finally { f.close(); }
});

test("group preflight runs under the ledger writer lock and failure publishes no partial mode", async () => {
  const f = fixture();
  try {
    await expect(writeSharedLedgerModes({ [f.id]: { authorityMode: "source", sharedPlanning: true },
      other: { authorityMode: "source", sharedPlanning: true } }, f.dir, f.db.filename, () => {
      const competitor = new Database(f.db.filename);
      competitor.run("PRAGMA busy_timeout = 0");
      try { expect(() => competitor.run("BEGIN IMMEDIATE")).toThrow(); }
      finally { competitor.close(); }
      throw new Error("late preflight blocker");
    })).rejects.toThrow("late preflight blocker");
    expect(readSharedLedgerMode(f.id, f.dir).sharedPlanning).toBe(false);
    expect(readSharedLedgerMode("other", f.dir).sharedPlanning).toBe(false);
  } finally { f.close(); }
});
