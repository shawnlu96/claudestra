import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LendOrder } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, LEDGER_SCHEMA_VERSION, openLedger } from "../src/lib/ledger-store.js";
import { cooldownPeerSlots, cooldownReleaseNotices, migratePeerCooldownBaseline } from "../src/lib/lend-peer-cooldown.js";
import type { LendFamily } from "../src/lib/lend-config.js";
import type { HelloRequest } from "../src/lib/lend-wire-v2.js";

const NOW = Date.parse("2026-10-02T03:50Z");
const RESET = Date.parse("2026-10-09T01:41Z");
const ERROR = "You've hit your usage limit. try again at Oct 9th, 2026 1:41 AM.";
let db: Database;
let seq: number;
beforeEach(() => { db = openLedger(":memory:"); seq = 0; });
afterEach(() => closeLedger(":memory:"));

function hello(used?: number, over: Partial<HelloRequest> = {}, peer = "mate", family: LendFamily = "codex") {
  return recordHello(db, peer, null, { v: 1, proto: 2, boot: "baseline-boot", seq: ++seq, paused: null,
    grant: null, slots: { codex: { total: 4, busy: 0 }, claude: { total: 3, busy: 0 } },
    ...(used === undefined ? {} : { quota: { [family]: { weekUsedPct: used, resetAt: RESET } } }), ...over }, NOW);
}
function start(peer = "mate", family: LendFamily = "codex", now = NOW) {
  const order = { orderId: "o1", taskId: "T1", project: "p", peer, family } as LendOrder;
  cooldownReleaseNotices(db, order, ERROR, now, []);
}
function row(peer = "mate", family: LendFamily = "codex") {
  return db.query("SELECT until, baselineWeekUsedPct FROM lend_peer_cooldowns WHERE peer = ? AND family = ?").get(peer, family);
}

test.each(["codex", "claude"] as const)("%s reset card clears with unchanged reset date and stored 100 percent baseline", (family) => {
  hello(100, {}, "mate", family);
  start("mate", family);
  expect(row("mate", family)).toEqual({ until: RESET, baselineWeekUsedPct: 100 });
  hello(3, {}, "mate", family);
  expect(row("mate", family)).toBeNull();
  expect(cooldownPeerSlots(db, "mate", { codex: 4, claude: 3 }, NOW)).toEqual({ codex: 4, claude: 3 });
});

test("no reading starts NULL; first 40 percent only seeds, equal 40 keeps, then 5 clears", () => {
  start();
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: null });
  hello(40);
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 40 });
  hello(40);
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 40 });
  hello(5);
  expect(row()).toBeNull();
});

test("an existing cached 40 percent is the baseline, never a presumed 100", () => {
  hello(40);
  start();
  hello(40);
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 40 });
  hello(5);
  expect(row()).toBeNull();
});

test("each accepted reading replaces the baseline after comparing, including increases and full usage", () => {
  hello(40);
  start();
  hello(70);
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 70 });
  hello(100);
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 100 });
  hello(80);
  expect(row()).toBeNull();
});

test.each(["codex_quota", "manual"])("%s pause blocks a drop but records it, and never shortens the deadline", (reason) => {
  hello(100);
  start();
  hello(3, { paused: { reason, until: NOW + 3600_000 } });
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 3 });
  hello(3);
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 3 });
  hello(2);
  expect(row()).toBeNull();
});

test("another family's pause allows recovery; quota and baseline are isolated by peer and family", () => {
  hello(100);
  start();
  start("other");
  start("mate", "claude");
  hello(3, { paused: { reason: "claude_quota", until: NOW + 3600_000 } });
  expect(row()).toBeNull();
  expect(row("other")).toEqual({ until: RESET, baselineWeekUsedPct: null });
  expect(row("mate", "claude")).toEqual({ until: RESET, baselineWeekUsedPct: null });
});

test("old/absent quota hellos cannot clear or overwrite the baseline or seed cache", () => {
  hello(100);
  expect(hello(3, { seq: 1 })).toEqual({ applied: false });
  start();
  hello();
  expect(hello(3, { seq: 1 })).toEqual({ applied: false });
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 100 });
  hello(3);
  expect(row()).toBeNull();
});

test("unchanged readings do not write quota cache or cooldown baseline again", () => {
  hello(40);
  start();
  db.run(`CREATE TRIGGER no_cached_update BEFORE UPDATE ON meta
    WHEN OLD.key LIKE 'lend:quota:%' BEGIN SELECT RAISE(ABORT, 'quota cache rewritten'); END`);
  db.run(`CREATE TRIGGER no_baseline_update BEFORE UPDATE OF baselineWeekUsedPct ON lend_peer_cooldowns
    BEGIN SELECT RAISE(ABORT, 'baseline rewritten'); END`);
  expect(() => hello(40)).not.toThrow();
});

test("hello transaction rollback also rolls back baseline and cached usage", () => {
  hello(100);
  start();
  db.run(`CREATE TRIGGER no_cache_write BEFORE UPDATE ON meta
    WHEN OLD.key LIKE 'lend:quota:%' BEGIN SELECT RAISE(ABORT, 'cache frozen'); END`);
  expect(() => hello(3)).toThrow("cache frozen");
  expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 100 });
  db.run("DROP TRIGGER no_cache_write");
  hello(3);
  expect(row()).toBeNull();
});

test("quota cache and active baseline survive separate database connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-baseline-"));
  const path = join(dir, "ledger.sqlite");
  try {
    db = openLedger(path);
    hello(100);
    closeLedger(path);
    db = openLedger(path);
    start();
    expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 100 });
    closeLedger(path);
    db = openLedger(path);
    hello(3);
    expect(row()).toBeNull();
  } finally {
    closeLedger(path);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([false, true])("old cooldown schema upgrades with nullable baseline, including version collision=%s", (collision) => {
  const dir = mkdtempSync(join(tmpdir(), "quota-baseline-migrate-"));
  const path = join(dir, "ledger.sqlite");
  try {
    const old = openLedger(path);
    old.run("INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt) VALUES ('mate', 'codex', ?, 'quota', ?)", [RESET, NOW]);
    old.run("ALTER TABLE lend_peer_cooldowns DROP COLUMN baselineWeekUsedPct");
    old.run(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION - (collision ? 0 : 1)}`);
    closeLedger(path);
    db = openLedger(path);
    expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: null });
    hello(40);
    migratePeerCooldownBaseline(db);
    closeLedger(path);
    db = openLedger(path);
    expect(row()).toEqual({ until: RESET, baselineWeekUsedPct: 40 });
    hello(5);
    expect(row()).toBeNull();
  } finally {
    closeLedger(path);
    rmSync(dir, { recursive: true, force: true });
  }
});
