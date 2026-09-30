import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mergeQueueBusy, schedulerQueueIdle } from "../src/lib/scheduler-update-gate.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("updates wait for in-flight or unresolved unknown merges; waiting, merged and resolved journals are idle", () => {
  const db = new Database(":memory:");
  try {
    expect(mergeQueueBusy(db)).toBe(false);
    db.exec("CREATE TABLE scheduler_merges (phase TEXT, intentId TEXT)");
    for (const phase of ["ready", "await_ci", "await_review", "merged", "resolved", "updating", "merging", "unknown"]) {
      db.exec("DELETE FROM scheduler_merges"); db.prepare("INSERT INTO scheduler_merges VALUES (?, 'job')").run(phase);
      expect(mergeQueueBusy(db)).toBe(["updating", "merging", "unknown"].includes(phase));
    }
  } finally { db.close(); }
});
test("a missing ledger does not create a database or block initial installation", () => {
  expect(schedulerQueueIdle(new LedgerReader(join(tmpdir(), `t68-missing-${crypto.randomUUID()}.db`)))).toBe(true);
});
