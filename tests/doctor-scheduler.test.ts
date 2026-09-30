import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSchedulerJournal } from "../src/lib/doctor-scheduler.js";
import { LedgerReader } from "../src/lib/ledger-read.js";

test("doctor names every unknown merge journal with its resolve exit", () => {
  const root = mkdtempSync(join(tmpdir(), "t68-doctor-")), path = join(root, "ledger.db"), db = new Database(path);
  db.exec("PRAGMA user_version=1; CREATE TABLE scheduler_merges(intentId TEXT,taskId TEXT,project TEXT,phase TEXT,reason TEXT,updatedAt INTEGER)");
  db.exec("INSERT INTO scheduler_merges VALUES ('m1','T1','p','unknown','gh timeout',1), ('m2','T2','p','merged',NULL,1)");
  db.close();
  try {
    const checks = checkSchedulerJournal(new LedgerReader(path));
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("warn");
    expect(String(checks[0].detail)).toContain("p/T1（m1）");
    expect(String(checks[0].detail)).not.toContain("T2");
    expect(checks[0].fix).toContain("scheduler-merge-resolve");
    expect(checkSchedulerJournal(new LedgerReader(join(root, "missing.db")))[0]).toMatchObject({ status: "ok" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
