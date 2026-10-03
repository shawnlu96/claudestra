import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { claimLend, leaseLend, offerLend, reofferLend, type OfferInput } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";
import { placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { cooldownReleaseNotices, peerCooldownUntil } from "../src/lib/lend-peer-cooldown.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { HelloRequest } from "../src/lib/lend-wire-v2.js";

const NOW = Date.parse("2026-10-01T23:07:00Z");
const RESET = Date.parse("2026-10-09T01:41:00Z");
const ERROR = "起 worker 失败：创建失败: Codex（ACP）引导没拿到 thread id：引导轮失败：You’ve hit your usage limit. "
  + "Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 9th, 2026 1:41 AM."
  + "（已清理：窗口已关；频道已删；占位已删）";
const RELEASE_AT = NOW;
const borrow: BorrowEntry = { peer: "mate", projects: ["p"], roles: ["write", "review"], maxOpen: 10 };
let db: Database;
let seq: number;
const ctx = (now = RELEASE_AT) => ({ actor: "owner", now });
const rows = () => db.query("SELECT * FROM lend_peer_cooldowns").all() as { family: string; until: number; reason: string }[];
function hello(paused: HelloRequest["paused"] = null, now = RELEASE_AT, sequence = ++seq) {
  return recordHello(db, "mate", null, { v: 1, proto: 2, boot: "boot", seq: sequence, paused,
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 3, busy: 0 } },
    grant: { until: now + 7 * 86400_000, roles: ["write", "review"], repos: ["org/repo"], ordersPerDay: 50, ordersLeftToday: 50 } }, now);
}
function input(id: string): OfferInput {
  return { taskId: id, peer: "mate", family: "codex", repo: "org/repo", pr: null, spec: "Implement x; validate x", borrow,
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: "b".repeat(40), report: null } };
}
function offered(id: string, review = false) {
  createTask(db, ctx(), { id, project: "p", title: id, kind: "code", agent: "agent-dev" });
  db.run("UPDATE tasks SET stage = ?, headSHA = ? WHERE id = ?", [review ? "review" : "build", review ? "b".repeat(40) : null, id]);
  return offerLend(db, ctx(), { ...input(id), pr: review ? 7 : null });
}
function held(id: string, review = false) {
  const order = offered(id, review);
  claimLend(db, ctx(), "mate", { v: 1, orderId: order.orderId, worker: "agent-worker" }, () => borrow);
  return order;
}
function released(id: string, detail = ERROR, now = RELEASE_AT) {
  return leaseLend(db, ctx(now), "mate", { v: 1, orderId: id, gen: 1, action: "release", reason: "not_started", detail });
}
beforeEach(() => { db = openLedger(":memory:"); seq = 0; hello(); });
afterEach(() => closeLedger(":memory:"));

test("accident write release remembers reset, zeroes Codex only, rejects Codex review placement", () => {
  const o = held("T1");
  const result = released(o.orderId);
  expect(rows()).toMatchObject([{ family: "codex", until: RESET }]);
  expect(result.notices.some(n => n.text.includes("退回本机"))).toBe(true);
  expect(result.notices.filter(n => n.text.includes("额度冷却"))).toHaveLength(1);
  const peers = borrowPeers(db, "p", [borrow], RELEASE_AT);
  expect(peers[0].v2?.slots).toEqual({ codex: 0, claude: 3 });
  const facts: PlacementFacts = { peers: peers.map(p => ({ ...p, roles: p.roles ?? [], v2: p.v2 ?? null })),
    remote: { mode: "balance", roles: ["review", "write"], reviewFirst: [], poolTimeoutMin: 30 },
    repo: "org/repo", local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
  expect(placeFor(facts, "review", "codex").kind).toBe("local");
  expect(placeFor(facts, "review", "claude")).toMatchObject({ kind: "peer", peer: "mate", family: "claude" });
});

test("missing time defaults to six hours; ordinary release never cools", () => {
  released(held("T1").orderId, "clone denied");
  expect(rows()).toEqual([]);
  released(held("T2").orderId, "You’ve hit your usage limit.");
  expect(rows()[0].until).toBe(RELEASE_AT + 6 * 3600_000);
});

test("successful claim clears; refused claim does not; reoffer clears the old peer family", () => {
  const o = held("T1");
  const pending = offered("T2");
  released(o.orderId);
  expect(() => claimLend(db, ctx(), "mate", { v: 1, orderId: pending.orderId, worker: "agent-worker" }, () => null)).toThrow();
  expect(rows()).toHaveLength(1);
  claimLend(db, ctx(), "mate", { v: 1, orderId: pending.orderId, worker: "agent-worker" }, () => borrow);
  expect(rows()).toEqual([]);
  cooldownReleaseNotices(db, o, ERROR, RELEASE_AT, []);
  reofferLend(db, ctx(), { ...input("T2"), reason: "PM retry" });
  expect(rows()).toEqual([]);
});

test("multiple already-claimed orders releasing in one cooldown notify only once", () => {
  const a = held("T1"), b = held("T2");
  expect(released(a.orderId).notices.filter(n => n.text.includes("额度冷却"))).toHaveLength(1);
  expect(released(b.orderId).notices.filter(n => n.text.includes("额度冷却"))).toHaveLength(0);
  expect(cooldownReleaseNotices(db, a, ERROR, RESET + 1, []).filter(n => n.text.includes("额度冷却"))).toHaveLength(1);
});

test("accepted paused hello only extends live cooldown, old hello and other family do not", () => {
  released(held("T1").orderId);
  hello({ reason: "claude_quota", until: RESET + 3 * 3600_000 });
  expect(rows()[0].until).toBe(RESET);
  hello({ reason: "codex_quota", until: RELEASE_AT + 3600_000 });
  expect(rows()[0].until).toBe(RESET);
  const later = RESET + 2 * 3600_000;
  hello({ reason: "codex_quota", until: later });
  expect(rows()[0].until).toBe(later);
  expect(hello({ reason: "codex_quota", until: later + 1000 }, RELEASE_AT, 1)).toEqual({ applied: false });
  expect(rows()[0].until).toBe(later);
  hello(null);
  expect(rows()[0].until).toBe(later);
  hello({ reason: "codex_quota", until: RELEASE_AT - 1 });
  expect(rows()[0].until).toBe(later);
  expect(borrowPeers(db, "p", [borrow], RELEASE_AT)[0].v2?.slots.codex).toBe(0);
});

test("reset hints honor UTC and explicit offset, cap eight days and reject unusable dates", () => {
  expect(peerCooldownUntil(ERROR, RELEASE_AT)).toBe(RESET);
  expect(peerCooldownUntil("try again at Oct 20th, 2026 1:41 AM", NOW)).toBe(NOW + 8 * 86400_000);
  expect(peerCooldownUntil("try again at Oct 3rd, 2026 1:41 AM +0900", NOW)).toBe(Date.parse("2026-10-02T16:41Z"));
  expect(peerCooldownUntil("try again at 2026-10-03T01:41", NOW)).toBe(Date.parse("2026-10-03T01:41Z"));
  expect(peerCooldownUntil("try again at 2026-10-03T01:41+09:00", NOW)).toBe(Date.parse("2026-10-02T16:41Z"));
  expect(peerCooldownUntil("try again at invalid", NOW)).toBe(NOW + 6 * 3600_000);
});

test("failed PM reoffer rolls back cooldown clear with the cancelled order", () => {
  const o = held("T1");
  cooldownReleaseNotices(db, o, ERROR, RELEASE_AT, []);
  expect(() => reofferLend(db, ctx(), { ...input("T1"), borrow: null, reason: "invalid" })).toThrow();
  expect(rows()).toHaveLength(1);
  expect(db.query("SELECT status FROM lend_orders WHERE orderId = ?").get(o.orderId)).toEqual({ status: "claimed" });
});


test.each([
  { peer: "other", family: "codex" as const, cleared: false },
  { peer: "mate", family: "claude" as const, cleared: false },
  { peer: "mate", family: "codex" as const, cleared: true },
])("PM reoffer $peer/$family clears old mate/Codex only for the same target", ({ peer, family, cleared }) => {
  const a = held("T1");
  held("T2", true);
  released(a.orderId);
  const destination = { ...input("T2"), pr: 7, peer, family, borrow: { ...borrow, peer }, reason: "PM chooses destination" };
  const order = reofferLend(db, ctx(), destination);
  expect(order).toMatchObject({ peer, family });
  expect(rows()).toHaveLength(cleared ? 0 : 1);
  expect(borrowPeers(db, "p", [borrow], RELEASE_AT)[0].v2?.slots.codex).toBe(cleared ? 4 : 0);
});

test("past reset falls back to six hours and repeated quota release emits one notice", () => {
  const a = held("T1"), b = held("T2");
  const pastError = ERROR.replace("Oct 9th", "Sep 30th");
  const first = released(a.orderId, pastError);
  expect(rows()[0].until).toBe(Date.parse("2026-10-02T05:07:00Z"));
  expect(first.notices.filter(n => n.text.includes("额度冷却"))).toHaveLength(1);
  expect(first.notices.some(n => n.text.includes("2026-10-02T05:07:00.000Z"))).toBe(true);
  expect(released(b.orderId, pastError).notices.filter(n => n.text.includes("额度冷却"))).toHaveLength(0);
  expect(borrowPeers(db, "p", [borrow], RELEASE_AT)[0].v2?.slots.codex).toBe(0);
  expect(peerCooldownUntil("try again at 2026-10-01T23:07Z", RELEASE_AT)).toBe(RELEASE_AT + 6 * 3600_000);
});
