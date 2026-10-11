/** The production card adapter of the B-terminal retirement: only a positively absent ledger means "no local card". */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { ledgerCardWorker } from "../src/manager/lend-worker-archive-cmds.js";

const root = mkdtempSync(join(tmpdir(), "lend-registry-ledger-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a same-name card is found; an unreadable ledger throws instead of reading as no card", () => {
  const dir = join(root, "locked");
  mkdirSync(dir);
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  db.query("UPDATE tasks SET stage = 'blocked' WHERE id = 'T1'").run();
  registerWorker(db, { agent: "agent-lend-x", sessionId: "s1", taskId: "T1", role: "author", createdBy: "pm", now: 2 });
  closeLedger(path);
  const reader = new LedgerReader(path);
  try {
    expect(ledgerCardWorker(reader, "agent-lend-x")).toMatchObject({ taskId: "T1" });
    reader.close();
    chmodSync(dir, 0o000);
    expect(reader.get()).toBeNull(); // the reader's own semantics: any stat error reads as "no ledger"
    expect(() => ledgerCardWorker(reader, "agent-lend-x")).toThrow("台账读不到");
  } finally { chmodSync(dir, 0o700); reader.close(); }
});

test("an absent ledger file is no card; a present but not yet initialized one throws", () => {
  const absent = new LedgerReader(join(root, "missing", "ledger.sqlite"));
  expect(ledgerCardWorker(absent, "agent-lend-x")).toBeUndefined();
  const path = join(root, "empty.sqlite");
  writeFileSync(path, "");
  const empty = new LedgerReader(path);
  try { expect(() => ledgerCardWorker(empty, "agent-lend-x")).toThrow("未就绪"); } finally { empty.close(); }
});
