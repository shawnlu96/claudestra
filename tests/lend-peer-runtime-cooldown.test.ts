import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { claimLend, leaseLend, offerLend, type OfferInput } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";
import { placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { cooldownPeerSlots, cooldownReleaseNotices } from "../src/lib/lend-peer-cooldown.js";
import { RUNTIME_COOLDOWN_MS, runtimeStopCooldown } from "../src/lib/lend-peer-runtime-cooldown.js";
import { CLAUDE_AUTH_STOP_LEAD } from "../src/lib/lend-claude-pause-worker.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import type { BorrowEntry, LendFamily } from "../src/lib/lend-config.js";
import type { HelloRequest } from "../src/lib/lend-wire-v2.js";
import type { LeaseRequest } from "../src/lib/lend-wire.js";

const NOW = Date.parse("2026-10-16T04:00:00Z");
const MIN = 60_000;
const AUTH_TEXT = `${CLAUDE_AUTH_STOP_LEAD}，没交结论：本机 Claude 登录失效（authentication_error / OAuth 刷新失败），请重新登录`;
const QUOTA = "起 worker 失败：You’ve hit your usage limit. try again at Oct 17th, 2026 1:41 AM.";
const borrow = (peer: string): BorrowEntry => ({ peer, projects: ["p"], roles: ["write", "review"], maxOpen: 10 });
let db: Database;
let seq: number;
const ctx = (now = NOW) => ({ actor: "owner", now });
const rows = () => db.query("SELECT peer, family, until, reason FROM lend_peer_cooldowns ORDER BY peer, family").all() as
  { peer: string; family: string; until: number; reason: string }[];
const setMode = (mode: "on" | "observe" | "off" | null) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendRuntimeCooldown: mode } } } }));

function hello(peer: string, now = NOW, quota?: HelloRequest["quota"]) {
  return recordHello(db, peer, null, { v: 1, proto: 2, boot: "boot", seq: ++seq, paused: null, ...(quota ? { quota } : {}),
    slots: { codex: { total: 4, busy: 0 }, claude: { total: 3, busy: 0 } },
    grant: { until: now + 7 * 86400_000, roles: ["write", "review"], repos: ["org/repo"], ordersPerDay: 50, ordersLeftToday: 50 } }, now);
}
function input(id: string, peer: string, family: LendFamily): OfferInput {
  return { taskId: id, peer, family, repo: "org/repo", pr: null, spec: "Implement x; validate x", borrow: borrow(peer),
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: "b".repeat(40), report: null } };
}
/** A claimed order: review = a review order on a card in review, otherwise a write (build) order. */
function held(id: string, { peer = "sekai", family = "claude" as LendFamily, review = false, now = NOW } = {}) {
  createTask(db, ctx(now), { id, project: "p", title: id, kind: "code", agent: "agent-dev" });
  db.run("UPDATE tasks SET stage = ?, headSHA = ? WHERE id = ?", [review ? "review" : "build", review ? "b".repeat(40) : null, id]);
  const order = offerLend(db, ctx(now), { ...input(id, peer, family), pr: review ? 7 : null });
  claimLend(db, ctx(now), peer, { v: 1, orderId: order.orderId, worker: "agent-worker" }, () => borrow(peer));
  return order;
}
function stopped(o: { orderId: string; peer: string }, detail: string, failure?: LeaseRequest["failure"], now = NOW) {
  return leaseLend(db, ctx(now), o.peer, { v: 1, orderId: o.orderId, gen: 1, action: "release", reason: "stopped", detail, ...(failure ? { failure } : {}) });
}
const auth = (cls: "auth" | "other" = "auth"): LeaseRequest["failure"] => ({ class: cls, sessionId: "thr-1", failedAt: NOW });
const status = (orderId: string) => (db.query("SELECT status FROM lend_orders WHERE orderId = ?").get(orderId) as { status: string }).status;
const slots = (peer: string, now = NOW) => cooldownPeerSlots(db, peer, { codex: 4, claude: 3 }, now);
const done = (orderId: string, at: number) => db.run("UPDATE lend_orders SET status = 'done', updatedAt = ? WHERE orderId = ?", [at, orderId]);
const samples = () => listEvents(db, { project: "p" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "lendRuntimeCooldown");

beforeEach(() => { db = openLedger(":memory:"); seq = 0; hello("sekai"); hello("he"); setMode(null); });
afterEach(() => { closeLedger(":memory:"); setMode(null); });

test("[验收线 1] structured auth cools only Sekai's claude for 30 minutes; placement skips it", () => {
  const o = held("T1");
  stopped(o, "worker 停了", auth());
  expect(rows()).toEqual([{ peer: "sekai", family: "claude", until: NOW + RUNTIME_COOLDOWN_MS, reason: "runtime:auth" }]);
  const peers = borrowPeers(db, "p", [borrow("sekai"), borrow("he")], NOW);
  expect(peers.map((p) => [p.peer, p.v2?.slots])).toEqual([["sekai", { codex: 4, claude: 0 }], ["he", { codex: 4, claude: 3 }]]);
  const only = peers.filter((p) => p.peer === "sekai");
  const facts: PlacementFacts = { peers: only.map((p) => ({ ...p, roles: p.roles ?? [], v2: p.v2 ?? null })),
    remote: { mode: "balance", roles: ["review", "write"], reviewFirst: [], poolTimeoutMin: 30 },
    repo: "org/repo", local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
  expect(placeFor(facts, "review", "claude").kind).toBe("local");
  expect(listEvents(db, { project: "p", target: "T1" }).filter((e) => e.text.startsWith("出借：sekai 的 claude 冷却到")).map((e) => e.text))
    .toEqual([`出借：sekai 的 claude 冷却到 ${new Date(NOW + RUNTIME_COOLDOWN_MS).toISOString()}（runtime:auth）`]);
});

test("[验收线 2] an old lender's shared auth text cools at once; a structured class decides alone", () => {
  stopped(held("T1"), AUTH_TEXT);
  expect(rows().map((r) => r.reason)).toEqual(["runtime:auth"]);
  db.run("DELETE FROM lend_peer_cooldowns");
  stopped(held("T2", { family: "codex" }), AUTH_TEXT, auth("other")); // class other wins over the text
  stopped(held("T3", { peer: "he" }), `出借方说：${AUTH_TEXT}`); // not the lead: no keyword match
  expect(rows()).toEqual([]);
});

test("[验收线 2] other stops: one never cools, two order ids in 30 minutes do, a done order in between resets", () => {
  stopped(held("T1"), "worker 存活探测否定 2/2");
  expect(rows()).toEqual([]);
  stopped(held("T2", { now: NOW + 10 * MIN }), "worker 存活探测否定 2/2", undefined, NOW + 10 * MIN);
  expect(rows()).toEqual([{ peer: "sekai", family: "claude", until: NOW + 10 * MIN + RUNTIME_COOLDOWN_MS, reason: "runtime:stopped×2" }]);

  db.run("DELETE FROM lend_peer_cooldowns");
  const t = NOW + 60 * MIN;
  stopped(held("T3", { now: t }), "超过 2 小时没交结论", undefined, t);
  done(held("T4", { now: t }).orderId, t + 5 * MIN);
  stopped(held("T5", { now: t + 10 * MIN }), "超过 2 小时没交结论", undefined, t + 10 * MIN);
  expect(rows()).toEqual([]);
  // An old stop outside the window never pairs with a new one
  stopped(held("T6", { now: t + 50 * MIN }), "超过 2 小时没交结论", undefined, t + 50 * MIN);
  expect(rows()).toEqual([]);
});

test("[验收线 3] runtime rows survive claims and quota hellos, end on expiry or a later done order", () => {
  stopped(held("T1"), "x", auth());
  const t2 = held("T2"); // claim of the same peer + family runs clearPeerCooldown
  hello("sekai", NOW + MIN, { claude: { weekUsedPct: 10, resetAt: NOW + 86400_000 }, codex: { weekUsedPct: 10, resetAt: NOW + 86400_000 } });
  expect(rows().map((r) => r.reason)).toEqual(["runtime:auth"]);
  expect(slots("sekai", NOW + 2 * MIN).claude).toBe(0);
  expect(slots("sekai", NOW + RUNTIME_COOLDOWN_MS).claude).toBe(3); // expired

  const t = NOW + 2 * MIN;
  done(t2.orderId, t);
  expect(slots("sekai", t).claude).toBe(3); // a verdict entered after the cooldown started
});

test("[验收线 3] a longer quota cooldown is never shortened; a longer quota wall replaces a runtime row", () => {
  const q = held("T1", { family: "codex" });
  const a = held("T2", { family: "codex" }); // claimed first: a claim clears quota rows by design
  cooldownReleaseNotices(db, q as never, QUOTA, NOW, []);
  const quota = rows()[0];
  expect(quota.reason).toBe(QUOTA);
  stopped(a, "x", auth());
  expect(rows()).toEqual([quota]);

  stopped(held("T3"), "x", auth());
  const c = held("T4");
  expect(cooldownReleaseNotices(db, c as never, QUOTA, NOW, []).some((n) => n.text.includes("额度冷却"))).toBe(true);
  expect(rows().find((r) => r.family === "claude")?.reason).toBe(QUOTA);
});

test("[验收线 6] a stopped write order stays unknown and the PM notice is word for word as before", () => {
  const o = held("T1");
  const r = stopped(o, AUTH_TEXT, auth());
  expect(status(o.orderId)).toBe("unknown");
  expect(r.notices).toEqual([{ project: "p", taskId: "T1", text: `出借单 ${o.orderId}（T1 开工单）sekai 报 worker 已停：${AUTH_TEXT}，结果不明，交你核对：`
    + "ledger lend-reoffer T1 或 lend-cancel" }]);
});

test("[验收线 8] an auth-stopped review order is released and can go elsewhere; others stay unknown", () => {
  const r = held("T1", { review: true });
  const res = stopped(r, "x", auth());
  expect(status(r.orderId)).toBe("released");
  expect(res.notices.every((n) => !n.text.includes("结果不明"))).toBe(true);
  expect(db.query("SELECT COUNT(*) AS n FROM task_steps WHERE taskId = 'T1' AND executorKind = 'peer' AND state = 'assigned'").get()).toEqual({ n: 0 });
  const again = offerLend(db, ctx(), { ...input("T1", "he", "claude"), pr: 7 });
  expect(again.peer).toBe("he");

  const legacy = held("T2", { review: true });
  stopped(legacy, AUTH_TEXT);
  expect(status(legacy.orderId)).toBe("released");
  const other = held("T3", { review: true });
  stopped(other, "worker 存活探测否定 2/2");
  expect(status(other.orderId)).toBe("unknown");
});

test("[验收线 5] [验收线 8] off restores today's behaviour: no rows, no stop memory, review stays unknown", () => {
  setMode("off");
  const r = held("T1", { review: true });
  stopped(r, "x", auth());
  stopped(held("T2"), "a");
  stopped(held("T3"), "b");
  expect(status(r.orderId)).toBe("unknown");
  expect(rows()).toEqual([]);
  expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'lend:runtime-stops:%'").get()).toEqual({ n: 0 });
  expect(samples()).toEqual([]);
});

test("[验收线 5] [验收线 8] observe writes no row, keeps review unknown, one sample per order id and action", () => {
  setMode("observe");
  const r = held("T1", { review: true });
  stopped(r, "x", auth());
  expect(status(r.orderId)).toBe("unknown");
  expect(rows()).toEqual([]);
  runtimeStopCooldown(db, ctx(), r as never, { reason: "stopped", detail: "x", failure: auth() }, NOW + MIN);
  expect(samples().map((e) => e.data.actionKey).sort()).toEqual([`cooldown:${r.orderId}`, `release:${r.orderId}`]);
});

test("[验收线 5] default (no policy file) is on", () => {
  stopped(held("T1"), "x", auth());
  expect(rows().map((r) => r.reason)).toEqual(["runtime:auth"]);
  expect(listEvents(db, { project: "p" }).some((e) => e.data.op === "recovery_default_on" && e.data.mechanism === "lendRuntimeCooldown")).toBe(true);
});
