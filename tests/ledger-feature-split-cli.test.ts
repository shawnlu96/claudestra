import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { DRY_RUN_READS, isWriteInvocation } from "../src/manager/write-commands.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";

let dir: string, path: string, db: Database;
const map = { targets: [{ slug: "target", title: "Target", nodes: ["A"] }], deps: [] };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feature-split-")); path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  const ctx = { actor: "owner" };
  createFeature(db, ctx, { project: "p", slug: "src", title: "Source" });
  initDag(db, ctx, { id: "ab12-src", rev: 1, nodes: [{ key: "A", oneLine: "A" }] });
  writeFileSync(join(dir, "map.json"), JSON.stringify(map));
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true }); });
const run = (actor: string, ...args: string[]) => runLedger(args, {
  db, actor, actorProject: "p", projectIds: ["p"], now: () => 100,
  loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
});

test("CLI dry-run classification, read-only report and exclusive --out protect database", async () => {
  expect(DRY_RUN_READS.has("feature-split")).toBe(true);
  expect(isWriteInvocation("ledger", ["feature-split", "src", "--dry-run"])).toBe(false);
  expect(isWriteInvocation("ledger", ["feature-split", "src"])).toBe(true);
  const before = db.serialize();
  db.exec("PRAGMA query_only=ON");
  const out = join(dir, "report.md");
  const args = ["feature-split", "src", "--plan", join(dir, "map.json"), "--dry-run"];
  expect(await run("owner", ...args, "--out", out)).toMatchObject({ ok: true, dryRun: true });
  expect(readFileSync(out, "utf8")).toContain("total 1 / done 0 / active 0");
  expect(await run("owner", ...args, "--out", path)).toMatchObject({ ok: false });
  expect(await run("worker", ...args)).toMatchObject({ ok: false, code: "forbidden" });
  expect(db.serialize()).toEqual(before);
});

test("WAL backup captures complete pre-split database and CLI dedup replay", async () => {
  db.exec("PRAGMA journal_mode=WAL");
  const args = ["feature-split", "src", "--plan", join(dir, "map.json"), "--dedup", "migration"];
  const result = await run("owner", ...args);
  expect(result).toMatchObject({ ok: true, duplicate: false });
  const backupPath = result.backup as string;
  expect(backupPath).toContain(".pre-feature-split-");
  const backup = openLedger(backupPath);
  try {
    expect(backup.query("SELECT currentVersion FROM features WHERE id='ab12-src'").get()).toEqual({ currentVersion: 1 });
    expect(backup.query("SELECT id FROM features WHERE id='ab12-target'").get()).toBeNull();
  } finally { closeLedger(backupPath); }
  const before = db.serialize();
  expect(await run("owner", ...args)).toMatchObject({ ok: true, duplicate: true });
  expect(db.serialize()).toEqual(before);
});

test("feature dependency cycle is rejected before backup or writes", () => {
  const before = db.serialize();
  let backed = false;
  expect(() => applyFeatureSplit(db, { actor: "owner" }, "ab12-src", {
    ...map, deps: [{ from: "target", to: "src" }],
  }, () => { backed = true; return null; })).toThrow("成环");
  expect(backed).toBe(false);
  expect(db.serialize()).toEqual(before);
});

for (const target of [{ id: "" }, { slug: "" }, { id: "   " }]) {
  test(`empty target ${JSON.stringify(target)} rejected identically in dry-run and write`, async () => {
    const invalid = join(dir, "invalid.json");
    writeFileSync(invalid, JSON.stringify({ targets: [{ ...target, title: "Empty", nodes: ["A"] }] }));
    const before = db.serialize();
    const args = ["feature-split", "src", "--plan", invalid];
    const dry = await run("owner", ...args, "--dry-run");
    const write = await run("owner", ...args);
    expect(dry).toMatchObject({ ok: false, code: "invalid" });
    expect(write).toEqual(dry);
    expect(db.serialize()).toEqual(before);
  });
}
