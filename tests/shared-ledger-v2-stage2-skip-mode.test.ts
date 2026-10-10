/**
 * S2D2 · S2D round-2 P2-2 / P2-4: the route reads the mode file once per file version (a revocation is still seen on the next
 * check), and diagnostics are deduplicated by a time window that also covers route checks made outside a pass.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import * as modes from "../src/lib/shared-ledger-mode.js";
import { clearSchedulerV2Diagnostics, configureSchedulerV2Pass, schedulerV2Route } from "../src/lib/scheduler-v2-pass.js";
import { readSharedLedgerModeCached, schedulerV2Diagnostic } from "../src/lib/scheduler-v2-skip-mode.js";

const cleanups: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Pass(null); while (cleanups.length) cleanups.pop()!(); });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "s2d2-mode-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  createTask(db, { actor: "owner" }, { id: "T", project: "p", title: "synthetic", kind: "code" });
  db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('f','p','synthetic','active','owner',1,1)").run();
  db.query("UPDATE tasks SET featureId='f' WHERE id='T'").run();
  return { dir, db };
}
/** Atomic replace (tmp + rename), as every writer of the mode file does. */
function publish(dir: string, f: modes.SharedLedgerMode | string) {
  const tmp = join(dir, `modes.${Math.random()}.tmp`);
  writeFileSync(tmp, typeof f === "string" ? f : JSON.stringify({ features: { f } }));
  renameSync(tmp, join(dir, "shared-ledger-modes.json"));
}
const execution: modes.SharedLedgerMode = { authorityMode: "execution", sharedPlanning: true };

describe("S2D2 route mode cache", () => {
  test("an unchanged file is read once across many route checks; each new version is read on the next check", () => {
    const { dir, db } = ledger();
    publish(dir, execution);
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
    const reads = spyOn(modes, "readSharedLedgerMode");
    try {
      for (let i = 0; i < 50; i++) expect(schedulerV2Route("T", db)).toBe("central");
      expect(reads).toHaveBeenCalledTimes(1);
      // a migration batch starts: frozen on the very next check
      publish(dir, { ...execution, migrating: { batchId: "b1", kind: "execute" } });
      expect(schedulerV2Route("T", db)).toBe("skip");
      expect(schedulerV2Route("T", db)).toBe("skip");
      expect(reads).toHaveBeenCalledTimes(2);
      // reverted to planning: local again on the next check
      publish(dir, { authorityMode: "planning", sharedPlanning: true });
      expect(schedulerV2Route("T", db)).toBe("local");
      expect(reads).toHaveBeenCalledTimes(3);
    } finally { reads.mockRestore(); }
  });

  test("an in-place rewrite of the same size is still seen (ctime / mtime change)", async () => {
    const { dir } = ledger();
    const path = join(dir, "shared-ledger-modes.json");
    writeFileSync(path, JSON.stringify({ features: { f: { authorityMode: "planning", sharedPlanning: true } } }));
    expect(readSharedLedgerModeCached("f", dir).authorityMode).toBe("planning");
    await Bun.sleep(5);
    writeFileSync(path, JSON.stringify({ features: { f: { authorityMode: "planning", sharedPlanning: false } } }));
    expect(readSharedLedgerModeCached("f", dir).sharedPlanning).toBe(false);
  });

  test("a corrupt file is never cached: every check holds feature cards and a repaired file is read at once", () => {
    const { dir, db } = ledger();
    publish(dir, "{not json");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(schedulerV2Route("T", db)).toBe("skip");
      expect(() => readSharedLedgerModeCached("f", dir)).toThrow();
      expect(() => readSharedLedgerModeCached("f", dir)).toThrow();
    } finally { error.mockRestore(); }
    publish(dir, { authorityMode: "source", sharedPlanning: false });
    expect(schedulerV2Route("T", db)).toBe("local");
  });

  test("missing file reads as source (local) without caching a default", () => {
    const { dir, db } = ledger();
    expect(schedulerV2Route("T", db)).toBe("local");
    publish(dir, { ...execution, migrating: { batchId: "b", kind: "home" } });
    expect(schedulerV2Route("T", db)).toBe("skip");
  });

  test("cached answers are copies: a caller mutating one cannot change the next answer", () => {
    const { dir } = ledger();
    publish(dir, execution);
    const a = readSharedLedgerModeCached("f", dir);
    (a as { authorityMode: string }).authorityMode = "source";
    expect(readSharedLedgerModeCached("f", dir).authorityMode).toBe("execution");
  });
});

describe("S2D2 diagnostic dedup window", () => {
  test("a key logs once per 10-minute window and again after it; clearing resets", () => {
    clearSchedulerV2Diagnostics();
    expect(schedulerV2Diagnostic("k", 0)).toBe(true);
    expect(schedulerV2Diagnostic("k", 1)).toBe(false);
    expect(schedulerV2Diagnostic("k", 10 * 60_000 - 1)).toBe(false);
    expect(schedulerV2Diagnostic("k", 10 * 60_000)).toBe(true);
    expect(schedulerV2Diagnostic("other", 10 * 60_000)).toBe(true);
    clearSchedulerV2Diagnostics();
    expect(schedulerV2Diagnostic("k", 10 * 60_000 + 1)).toBe(true);
  });

  test("route checks outside a pass (S2I / S2A ports) log again after the window instead of once per process", () => {
    const { dir, db } = ledger();
    publish(dir, execution);
    configureSchedulerV2Pass({ mode: () => "observe", wrapManager: (m) => m });
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) expect(schedulerV2Route("T", db)).toBe("skip");
      expect(info).toHaveBeenCalledTimes(1);
      now += 10 * 60_000;
      expect(schedulerV2Route("T", db)).toBe("skip");
      expect(info).toHaveBeenCalledTimes(2);
      clearSchedulerV2Diagnostics(); // S2F's per-tick clear
      expect(schedulerV2Route("T", db)).toBe("skip");
      expect(info).toHaveBeenCalledTimes(3);
    } finally { clock.mockRestore(); info.mockRestore(); }
  });
});
