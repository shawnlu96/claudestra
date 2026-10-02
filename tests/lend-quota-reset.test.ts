import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { helloBody } from "../src/lib/lend-hello.js";
import { PAUSE_FALLBACK_MS, pausedUntil, type QuotaView } from "../src/lib/lend-health.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { LEND_PEER_COOLDOWN_SCHEMA, peerCooldownUntil, updatePeerCooldownHello } from "../src/lib/lend-peer-cooldown.js";
import { lendQuotaResetAt } from "../src/lib/lend-quota-reset.js";
import { harness } from "./lend-harness.js";

const NOW = Date.parse("2026-10-02T01:55:00Z");
const RESET = Date.parse("2026-10-09T01:41:00Z");
const ERROR = "起 worker 失败：创建失败: Codex（ACP）引导没拿到 thread id：引导轮失败：You’ve hit your usage limit. "
  + "Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 9th, 2026 1:41 AM."
  + "（已清理：窗口已关；频道已删；占位已删）";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

test.each([
  { reason: ERROR, expected: RESET },
  { reason: "try again at Oct 9th, 2026 1:41 AM UTC", expected: RESET },
  { reason: "try again at Oct 9th, 2026 1:41 PM GMT", expected: RESET + 12 * 3600_000 },
  { reason: "try again at Oct 9th, 2026 1:41 AM +0900", expected: RESET - 9 * 3600_000 },
  { reason: "try again at 2026-10-09T01:41", expected: RESET },
  { reason: "try again at 2026-10-09T01:41:00Z", expected: RESET },
  { reason: "try again at 2026-10-09T01:41+09:00", expected: RESET - 9 * 3600_000 },
  { reason: "try again at invalid", expected: null },
  { reason: "try again at Oct 1st, 2026 1:41 AM", expected: null },
  { reason: "try again at 2026-10-02T01:55Z", expected: null },
])("shared parser keeps reset hint semantics: $reason", ({ reason, expected }) => {
  expect(lendQuotaResetAt(reason, NOW)).toBe(expected);
  expect(peerCooldownUntil(reason, NOW)).toBe(expected ?? NOW + 6 * 3600_000);
});

test("only the borrower caps a distant parsed reset at eight days", () => {
  const reason = "try again at Oct 20th, 2026 1:41 AM";
  expect(lendQuotaResetAt(reason, NOW)).toBe(Date.parse("2026-10-20T01:41Z"));
  expect(peerCooldownUntil(reason, NOW)).toBe(NOW + 8 * 86400_000);
});

const observations: { name: string; quota: QuotaView | null; readFails?: boolean; expected: number }[] = [
  { name: "no quota reading", quota: null, expected: RESET },
  { name: "full without reset", quota: { observedAt: NOW, full: true, resetsAt: null }, expected: RESET },
  { name: "unknown without reset", quota: { observedAt: NOW, full: null, resetsAt: null }, expected: RESET },
  { name: "not full without reset", quota: { observedAt: NOW, full: false, resetsAt: null }, expected: RESET },
  { name: "past reset", quota: { observedAt: NOW, full: true, resetsAt: NOW - 1 }, expected: RESET },
  { name: "reset at now", quota: { observedAt: NOW, full: true, resetsAt: NOW }, expected: RESET },
  { name: "failed quota read", quota: null, readFails: true, expected: RESET },
  { name: "future reading takes priority", quota: { observedAt: NOW, full: true, resetsAt: NOW + 7200_000 }, expected: NOW + 7200_000 },
];
test.each(observations)("bootstrap pause and hello use reset hint: $name", async ({ quota, readFails, expected }) => {
  const h = harness({ entry: { grantedAt: new Date(NOW).toISOString(), until: new Date(NOW + 6 * 86400_000).toISOString() } });
  databases.push(h.db);
  h.advanceTime(NOW - h.d.now());
  // Introduce the observation at create so the admission check cannot consume it first.
  h.d.worker.create = async () => {
    h.health.quota = quota;
    if (readFails) h.d.codexQuota = async () => { throw new Error("quota fixture unavailable"); };
    return { ok: false, error: ERROR };
  };
  for (let i = 0; i < 4; i++) await h.tick();
  expect(getOrder(h.db, "o1")?.state).toBe("released");
  expect(pausedUntil(h.db, NOW)).toBe(expected);
  expect(helloBody(h.db, h.lend.lend[0], NOW).paused).toEqual({ reason: "codex_quota", until: expected });
});

test.each(["missing hint", "try again at invalid", "try again at Jan 1st, 1970 12:00 AM"])(
  "bootstrap without usable reset still falls back to one hour: %s", async (hint) => {
    const h = harness();
    databases.push(h.db);
    h.d.worker.create = async () => ({ ok: false, error: `You've hit your usage limit. ${hint}` });
    for (let i = 0; i < 4; i++) await h.tick();
    expect(getOrder(h.db, "o1")?.state).toBe("released");
    expect(pausedUntil(h.db, h.d.now())).toBe(h.d.now() + PAUSE_FALLBACK_MS);
  },
);

test("paused hello preserves a weekly cooldown against shorter hints and extends later ones", () => {
  const db = new Database(":memory:");
  databases.push(db);
  for (const sql of LEND_PEER_COOLDOWN_SCHEMA) db.run(sql);
  db.run("INSERT INTO lend_peer_cooldowns (peer, family, until, reason, startedAt) VALUES (?, ?, ?, ?, ?)", ["mate", "codex", RESET, ERROR, NOW]);
  const row = () => db.query("SELECT until, reason, startedAt FROM lend_peer_cooldowns WHERE peer = 'mate' AND family = 'codex'").get();
  for (const until of [NOW + PAUSE_FALLBACK_MS, NOW - 1, RESET]) {
    updatePeerCooldownHello(db, "mate", { reason: "codex_quota", until }, NOW);
    expect(row()).toEqual({ until: RESET, reason: ERROR, startedAt: NOW });
  }
  const later = RESET + 3600_000;
  updatePeerCooldownHello(db, "mate", { reason: "codex_quota", until: later }, NOW);
  expect(row()).toEqual({ until: later, reason: ERROR, startedAt: NOW });
  updatePeerCooldownHello(db, "mate", null, NOW);
  updatePeerCooldownHello(db, "mate", { reason: "claude_quota", until: later + 1 }, NOW);
  updatePeerCooldownHello(db, "other", { reason: "codex_quota", until: later + 1 }, NOW);
  expect(row()).toEqual({ until: later, reason: ERROR, startedAt: NOW });
});
