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
const setMode = (mode: "on" | "observe" | "off" | null, extra: Record<string, string> = {}) => mode === null ? rmSync(RECOVERY_POLICY_PATH, { force: true })
  : writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendRuntimeCooldown: mode, ...extra } } } }));
/** LENDBACK1 (lend-return-local.ts) drops any pin on a not_started peer; these pins are this mechanism's alone with it off. */
const OLD_PIN = { lendReturnLocal: "off" };

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

test("[验收线 5] [验收线 8] observe writes no row, keeps review unknown, one sample per order id carrying cooldown and release", () => {
  setMode("observe");
  const r = held("T1", { review: true });
  stopped(r, "x", auth());
  expect(status(r.orderId)).toBe("unknown");
  expect(rows()).toEqual([]);
  runtimeStopCooldown(db, ctx(), r as never, { reason: "stopped", detail: "x", failure: auth() }, NOW + MIN);
  expect(samples()).toHaveLength(1);
  expect(samples()[0]!.data).toMatchObject({ actionKey: `stop:${r.orderId}`, cooldown: { reason: "runtime:auth", until: NOW + RUNTIME_COOLDOWN_MS }, release: true });
  const w = held("T2");
  stopped(w, "x", auth());
  expect(samples().filter((e) => e.data.actionKey === `stop:${w.orderId}`).map((e) => e.data.release)).toEqual([false]);
});

test("[验收线 5] default (no policy file) is on", () => {
  stopped(held("T1"), "x", auth());
  expect(rows().map((r) => r.reason)).toEqual(["runtime:auth"]);
  expect(listEvents(db, { project: "p" }).some((e) => e.data.op === "recovery_default_on" && e.data.mechanism === "lendRuntimeCooldown")).toBe(true);
});

// NETCOOL1: a lender whose worker cannot fetch the card's commit cools too, and the write card's pin on that peer comes off.
const NET = "取不到 0123456789ab：fatal: unable to access 'https://github.com/org/repo/': Failure when receiving data from the peer";
const PUSH = "没有推送权限：出借人的 GitHub 登录推不了这个仓库（推到自己 fork 再发 PR 的路径 v1 不支持，只检测）：403";
const MISMATCH = "PR 分支的 head 不是这一单的起点";
function notStarted(o: { orderId: string; peer: string }, detail: string, failure?: LeaseRequest["failure"], now = NOW) {
  return leaseLend(db, ctx(now), o.peer, { v: 1, orderId: o.orderId, gen: 1, action: "release", reason: "not_started", detail, ...(failure ? { failure } : {}) });
}
const forget = () => db.run("DELETE FROM meta WHERE key LIKE 'lend:runtime-stops:%'");
const pin = (id: string, placement: string) => db.run("UPDATE tasks SET extra = json_set(extra, '$.placement', ?) WHERE id = ?", [placement, id]);
const card = (id: string) => {
  const t = db.query("SELECT agent, assigneeKind, assignee, extra FROM tasks WHERE id = ?").get(id) as { agent: string | null; assigneeKind: string | null; assignee: string | null; extra: string };
  return { ...t, extra: JSON.parse(t.extra) as Record<string, unknown> };
};

test("[验收线 1] not_started over the network cools 30 minutes; permission, start mismatch and non-fetch texts do not", () => {
  notStarted(held("T1"), "x", { class: "network", sessionId: "thr-1", failedAt: NOW });
  expect(rows()).toEqual([{ peer: "sekai", family: "claude", until: NOW + RUNTIME_COOLDOWN_MS, reason: "runtime:network" }]);
  const legacy = [NET, "取不到 0123456789ab：fatal: unable to access 'https://github.com/o/r/': SSL connection timeout",
    "取不到 0123456789ab：fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com"];
  for (const [i, detail] of legacy.entries()) {
    db.run("DELETE FROM lend_peer_cooldowns");
    notStarted(held(`L${i}`, { peer: "he", family: "codex" }), detail);
    expect(rows()).toEqual([{ peer: "he", family: "codex", until: NOW + RUNTIME_COOLDOWN_MS, reason: "runtime:network" }]);
    forget();
  }
  db.run("DELETE FROM lend_peer_cooldowns");
  const quiet = [PUSH, MISMATCH, "取不到推送权限：unable to access", "clone 失败：fatal: unable to access 'https://github.com/o/r/'",
    "取不到 0123456789ab：fatal: remote error: upload-pack: not our ref"];
  for (const [i, detail] of quiet.entries()) {
    notStarted(held(`Q${i}`), detail);
    forget(); // one each: the second-order rule is its own test
  }
  notStarted(held("Q9"), NET, { class: "other", sessionId: "thr-1", failedAt: NOW }); // a structured class decides alone
  expect(rows()).toEqual([]);
});

test("[验收线 2] a second not_started of the same (peer, family) in 30 minutes cools; done in between, a stop, or a start mismatch do not pair", () => {
  notStarted(held("T1"), PUSH);
  expect(rows()).toEqual([]);
  notStarted(held("T2", { now: NOW + 10 * MIN }), PUSH, undefined, NOW + 10 * MIN);
  expect(rows()).toEqual([{ peer: "sekai", family: "claude", until: NOW + 10 * MIN + RUNTIME_COOLDOWN_MS, reason: "runtime:not_started×2" }]);

  db.run("DELETE FROM lend_peer_cooldowns");
  const t = NOW + 60 * MIN;
  notStarted(held("T3", { now: t }), PUSH, undefined, t);
  done(held("T4", { now: t }).orderId, t + 5 * MIN);
  notStarted(held("T5", { now: t + 10 * MIN }), PUSH, undefined, t + 10 * MIN);
  expect(rows()).toEqual([]);
  stopped(held("T6", { now: t + 11 * MIN }), "worker 存活探测否定 2/2", undefined, t + 11 * MIN); // a stop keeps its own list
  expect(rows()).toEqual([]);
  notStarted(held("T7", { now: t + 12 * MIN }), MISMATCH, undefined, t + 12 * MIN); // ours, never counted
  expect(rows()).toEqual([]);
  notStarted(held("T8", { now: t + 13 * MIN }), PUSH, undefined, t + 13 * MIN);
  expect(rows().map((r) => r.reason)).toEqual(["runtime:not_started×2"]);
});

test("[验收线 3] a write order that cools its peer comes back unpinned with its assignee; no cooldown keeps the pin", () => {
  setMode("on", OLD_PIN);
  const o = held("T1");
  pin("T1", "peer:sekai");
  const before = card("T1");
  notStarted(o, NET);
  const after = card("T1");
  expect(after.extra).not.toHaveProperty("placement");
  expect(after.agent).toBe("agent-dev");
  expect(after.assigneeKind === "peer_agent").toBe(false);
  expect(before.extra.placement).toBe("peer:sekai");
  const lend = (e: { data: Record<string, unknown> }) => e.data.lend as Record<string, unknown> | undefined;
  expect(listEvents(db, { project: "p", target: "T1" }).map(lend).find((l) => l?.op === "send_back")?.unpinned).toBe("peer:sekai");

  const kept = held("T2", { peer: "he" });
  pin("T2", "peer:he");
  notStarted(kept, "clone failed"); // grant valid, first plain not_started: pinned as before
  expect(card("T2").extra.placement).toBe("peer:he");

  const other = held("T3", { peer: "he" });
  pin("T3", "peer:sekai"); // only a pin on the cooled peer comes off
  notStarted(other, PUSH, undefined, NOW + MIN);
  expect(rows().find((r) => r.peer === "he")?.reason).toBe("runtime:not_started×2");
  expect(card("T3").extra.placement).toBe("peer:sekai");
});

test("[验收线 4] observe writes no row and keeps the pin, one sample per order across two rounds", () => {
  setMode("observe", OLD_PIN);
  const o = held("T1");
  pin("T1", "peer:sekai");
  notStarted(o, NET);
  expect(rows()).toEqual([]);
  expect(card("T1").extra.placement).toBe("peer:sekai");
  runtimeStopCooldown(db, ctx(), o as never, { reason: "not_started", detail: NET }, NOW + MIN);
  expect(samples().filter((e) => e.data.actionKey === `stop:${o.orderId}`).map((e) => e.data.cooldown))
    .toEqual([{ reason: "runtime:network", until: NOW + RUNTIME_COOLDOWN_MS }]);
});

test("[验收线 2] not_started kinds another mechanism owns never pair: model config failure, its refusal, a quota wall", () => {
  const config = "起 worker 失败：创建失败: 400 {\"error\":{\"code\":\"model_not_enabled\",\"message\":\"The model `gpt-9` is not enabled for this account.\"}}";
  const refusal = "配置故障未恢复，没有再启动（第 1 代，单 o-1）";
  for (const [i, detail] of [config, config, refusal, refusal, QUOTA, QUOTA].entries()) notStarted(held(`C${i}`, { family: "codex" }), detail);
  expect(rows().filter((r) => r.reason.startsWith("runtime:"))).toEqual([]);
});

test("[验收线 2] a network not_started counts toward the window: a plain failure 5 minutes later cools as the second (mixed-start-count)", () => {
  for (const failure of [{ class: "network", sessionId: "thr-1", failedAt: NOW } as const, undefined]) {
    db.run("DELETE FROM lend_peer_cooldowns"); forget();
    notStarted(held(`M${failure ? 1 : 3}`), failure ? "x" : NET, failure);
    const second = held(`M${failure ? 2 : 4}`, { now: NOW + 5 * MIN });
    pin(second.taskId, "peer:sekai");
    notStarted(second, "起 worker 失败：临时启动错误", undefined, NOW + 5 * MIN);
    expect(rows()).toEqual([{ peer: "sekai", family: "claude", until: NOW + 5 * MIN + RUNTIME_COOLDOWN_MS, reason: "runtime:not_started×2" }]);
    expect(card(second.taskId).extra).not.toHaveProperty("placement");
  }
});
