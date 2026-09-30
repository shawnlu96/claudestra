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
test("in-flight or unknown merge blocks update after daemon replacement; a merged journal does not", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68-maintenance-db-"));
  const path = join(root, "ledger.db"), db = new Database(path);
  db.exec("PRAGMA user_version=1; CREATE TABLE scheduler_merges(intentId TEXT,phase TEXT); INSERT INTO scheduler_merges VALUES ('job','merging')");
  db.close();
  const opts = { path: join(root, "mutex"), marker: join(root, "update.json"), reader: new LedgerReader(path) };
  try {
    expect(await acquireMaintenance("update", opts)).toBeNull();
    const set = (phase: string) => { const w = new Database(path); w.prepare("UPDATE scheduler_merges SET phase=?").run(phase); w.close(); };
    set("unknown");
    expect(await acquireMaintenance("update", opts)).toBeNull();
    set("merged");
    const update = await acquireMaintenance("update", opts);
    expect(update).not.toBeNull(); update!.release();
  } finally { opts.reader.close(); rmSync(root, { recursive: true, force: true }); }
});

test("P1 overlap (T68g): the deploy job holds the same lease as update; it waits out a scheduler pass and only a half-finished update refuses it", async () => {
  const root = mkdtempSync(join(tmpdir(), "t68g-maintenance-"));
  const opts = { path: join(root, "mutex"), marker: join(root, "update.json"), request: join(root, "request"), reader: new LedgerReader(join(root, "missing.db")) };
  try {
    const pass = await acquireMaintenance("scheduler", opts);
    expect(pass).not.toBeNull();
    setTimeout(() => pass!.release(), 300);
    const deploy = await acquireMaintenance("deploy", { ...opts, waitMs: 5000 });
    expect(deploy).not.toBeNull();
    expect(await acquireMaintenance("update", opts)).toBeNull();
    expect(await acquireMaintenance("scheduler", opts)).toBeNull();
    deploy!.release();
    writeFileSync(opts.marker, "reload still pending");
    expect(await acquireMaintenance("deploy", opts)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
