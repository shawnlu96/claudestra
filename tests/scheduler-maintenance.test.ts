import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireMaintenance, whileOwned } from "../src/lib/scheduler-maintenance.js";
import { LedgerReader } from "../src/lib/ledger-read.js";

test("lost maintenance ownership prevents invoking a spawn thunk and checks again after awaited work", async () => {
  let effects = 0, active = false;
  const guard = () => { if (!active) throw new Error("lease lost"); };
  await expect(whileOwned(guard, async () => { effects++; })).rejects.toThrow(/lease lost/);
  expect(effects).toBe(0);
  active = true;
  await expect(whileOwned(guard, async () => { effects++; active = false; })).rejects.toThrow(/lease lost/);
  expect(effects).toBe(1);
});

test("update lease and scheduler mutations exclude each other; in-flight reload marker blocks a new scheduler", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68-maintenance-"));
  const opts = { path: join(root, "mutex"), marker: join(root, "update.json"), reader: new LedgerReader(join(root, "missing.db")) };
  let update = await acquireMaintenance("update", opts);
  try {
    expect(update).not.toBeNull();
    expect(await acquireMaintenance("scheduler", opts)).toBeNull();
    update!.release(); update = null;
    const scheduler = await acquireMaintenance("scheduler", opts);
    expect(scheduler).not.toBeNull();
    expect(await acquireMaintenance("update", opts)).toBeNull();
    scheduler!.release();
    writeFileSync(opts.marker, "reload still pending");
    expect(await acquireMaintenance("scheduler", opts)).toBeNull();
  } finally { update?.release(); rmSync(root, { recursive: true, force: true }); }
});
test("unknown deployment blocks update after daemon replacement; only the exact deployment intent can use update", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68-maintenance-db-"));
  const path = join(root, "ledger.db"), db = new Database(path);
  db.exec("PRAGMA user_version=1; CREATE TABLE scheduler_merges(intentId TEXT,phase TEXT); INSERT INTO scheduler_merges VALUES ('job','unknown')");
  db.close();
  const opts = { path: join(root, "mutex"), marker: join(root, "update.json"), reader: new LedgerReader(path) };
  try {
    expect(await acquireMaintenance("update", opts)).toBeNull();
    const job = await acquireMaintenance("update", { ...opts, ownIntent: "job" });
    expect(job).not.toBeNull(); job!.release();
  } finally { opts.reader.close(); rmSync(root, { recursive: true, force: true }); }
});
test("a launched deployment waits for its submitting tick to release the shared maintenance lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68-maintenance-handoff-"));
  const opts = { path: join(root, "mutex"), marker: join(root, "update.json"), reader: new LedgerReader(join(root, "missing.db")) };
  const scheduler = await acquireMaintenance("scheduler", opts);
  try {
    expect(scheduler).not.toBeNull();
    const pending = acquireMaintenance("update", { ...opts, ownIntent: "same-deployment" });
    await Bun.sleep(20); scheduler!.release();
    const job = await pending;
    expect(job).not.toBeNull(); job!.release();
  } finally { scheduler?.release(); rmSync(root, { recursive: true, force: true }); }
});
