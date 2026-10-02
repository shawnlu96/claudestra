import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { parseV2Request, type HelloRequest } from "../src/lib/lend-wire-v2.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";

const NOW = Date.parse("2026-10-02T03:50:00Z");
const RESET = Date.parse("2026-10-09T01:41:00Z");
const NEXT_RESET = Date.parse("2026-10-09T11:50:00Z");
const fresh = { codex: { weekUsedPct: 5, resetAt: NEXT_RESET } };
let db: Database;
let seq: number;
beforeEach(() => {
  db = openLedger(":memory:");
  seq = 0;
  for (const [peer, family] of [["mate", "codex"], ["mate", "claude"], ["other", "codex"]]) {
    db.run("INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt) VALUES (?, ?, ?, ?, ?)", [peer, family, RESET, "usage limit", NOW - 60_000]);
  }
});
afterEach(() => closeLedger(":memory:"));
function hello(over: Partial<HelloRequest> = {}) {
  const request: HelloRequest = { v: 1, proto: 2, boot: "quota_reset_boot", seq: ++seq, paused: null, quota: fresh,
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 3, busy: 0 } },
    grant: { until: NOW + 6 * 86400_000, roles: ["write", "review"], repos: ["org/repo"], ordersPerDay: 50, ordersLeftToday: 50 }, ...over };
  const parsed = parseV2Request("hello", request);
  if (!parsed.ok) throw new Error(parsed.error);
  return recordHello(db, "mate", null, parsed.value, NOW);
}
const rows = () => db.query("SELECT peer, family, until FROM lend_peer_cooldowns ORDER BY peer, family").all();
const codex = () => db.query("SELECT until FROM lend_peer_cooldowns WHERE peer = 'mate' AND family = 'codex'").get();

test("accepted unpaused hello with 5% in a later reset window restores placement for only that peer/family", () => {
  expect(hello()).toEqual({ applied: true });
  expect(rows()).toEqual([{ peer: "mate", family: "claude", until: RESET }, { peer: "other", family: "codex", until: RESET }]);
  const peers = borrowPeers(db, "p", [{ peer: "mate", projects: ["p"], roles: ["write", "review"], maxOpen: 10 }], NOW);
  expect(peers[0].v2?.slots).toEqual({ codex: 4, claude: 0 });
});

const keep: { name: string; over: Partial<HelloRequest> }[] = [
  { name: "old lender without quota", over: { quota: undefined } },
  { name: "empty quota", over: { quota: {} } },
  { name: "same reset at 5%", over: { quota: { codex: { weekUsedPct: 5, resetAt: RESET } } } },
  { name: "earlier reset at 5%", over: { quota: { codex: { weekUsedPct: 5, resetAt: RESET - 1 } } } },
  { name: "later window already full", over: { quota: { codex: { weekUsedPct: 100, resetAt: NEXT_RESET } } } },
  { name: "still paused for this family despite a one-hour fallback", over: { paused: { reason: "codex_quota", until: NOW + 3600_000 } } },
  { name: "peer-wide pause", over: { paused: { reason: "manual", until: NOW + 3600_000 } } },
  { name: "quota only for another family", over: { quota: { claude: { weekUsedPct: 5, resetAt: NEXT_RESET } } } },
];
test.each(keep)("hello keeps the weekly Codex cooldown: $name", ({ over }) => {
  expect(hello(over)).toEqual({ applied: true });
  expect(codex()).toEqual({ until: RESET });
});

test("another family's pause does not block quota recovery for Codex", () => {
  hello({ paused: { reason: "claude_quota", until: NEXT_RESET } });
  expect(codex()).toBeNull();
  expect(rows()).toEqual([{ peer: "mate", family: "claude", until: NEXT_RESET }, { peer: "other", family: "codex", until: RESET }]);
});

test("delayed hello cannot clear a cooldown, even with a later quota window", () => {
  hello({ quota: undefined });
  expect(hello({ seq: 1 })).toEqual({ applied: false });
  expect(codex()).toEqual({ until: RESET });
  expect(hello()).toEqual({ applied: true });
  expect(codex()).toBeNull();
});

test("recovery is compared to the extended cooldown, not the original reset", () => {
  hello({ paused: { reason: "codex_quota", until: NEXT_RESET }, quota: undefined });
  hello();
  expect(codex()).toEqual({ until: NEXT_RESET });
  hello({ quota: { codex: { weekUsedPct: 99, resetAt: NEXT_RESET + 1 } } });
  expect(codex()).toBeNull();
});
