import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeLedger, openLedger, LEDGER_SCHEMA_VERSION } from "../src/lib/ledger-store.js";
import { cooldownPeerSlots } from "../src/lib/lend-peer-cooldown.js";

test("version 18 migrates to durable family cooldowns; reopening preserves them", () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-cooldown-"));
  const path = join(dir, "ledger.sqlite");
  try {
    const old = openLedger(path);
    old.run("DROP TABLE lend_peer_cooldowns");
    old.run("PRAGMA user_version = 18");
    closeLedger(path);
    const migrated = openLedger(path);
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: LEDGER_SCHEMA_VERSION });
    migrated.run("INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt) VALUES ('mate', 'codex', 5000, 'quota', 1000)");
    closeLedger(path);
    const reopened = openLedger(path);
    expect(cooldownPeerSlots(reopened, "mate", { codex: 4, claude: 2 }, 2000)).toEqual({ codex: 0, claude: 2 });
    expect(cooldownPeerSlots(reopened, "other", { codex: 4, claude: 2 }, 2000)).toEqual({ codex: 4, claude: 2 });
    expect(cooldownPeerSlots(reopened, "mate", { codex: 4, claude: 2 }, 5000)).toEqual({ codex: 4, claude: 2 });
  } finally {
    closeLedger(path);
    rmSync(dir, { recursive: true, force: true });
  }
});


test("latest-version database missing the cooldown table repairs it on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-cooldown-repair-"));
  const path = join(dir, "ledger.sqlite");
  try {
    const db = openLedger(path);
    db.run("DROP TABLE lend_peer_cooldowns");
    closeLedger(path);
    expect(openLedger(path).query("SELECT * FROM lend_peer_cooldowns").all()).toEqual([]);
  } finally {
    closeLedger(path);
    rmSync(dir, { recursive: true, force: true });
  }
});
