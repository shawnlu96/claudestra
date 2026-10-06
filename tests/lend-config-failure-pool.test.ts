/** dispatch-recovery-LCFG1, borrower side: real ledger + pool planner + recordHello; per peer + family pause, explicit re-declaration recovery. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { claimLend, getLendOrder, leaseLend, offerLend, type OfferInput } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";
import { placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { HelloRequest } from "../src/lib/lend-wire-v2.js";
import { recoverProviderConfigFailure, setConfigFailurePolicy } from "../src/lib/lend-config-failure.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { noteClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { harness } from "./lend-harness.js";
import { activeConfigFailures, configFailureView, configRecoveryGen } from "../src/lib/lend-config-failure-pool.js";

const NOW = Date.parse("2026-10-06T05:00:00Z");
const MODEL_400 = "创建失败: 引导轮失败：400 Bad Request {\"error\":{\"code\":\"model_not_enabled\",\"message\":\"The model `gpt-9` is not enabled for this account.\"}}";
const START = `起 worker 失败：${MODEL_400}`;
const setMode = (mode: "on" | "observe" | "off") => setConfigFailurePolicy(() => ({ mode, manualAfterMs: null, source: "config" }));
const borrow = (peer: string): BorrowEntry => ({ peer, projects: ["p"], roles: ["write", "review"], maxOpen: 10 });
let db: Database;
const seqs = new Map<string, number>();
const ctx = (now = NOW) => ({ actor: "owner", now });
function hello(peer: string, boot = "boot-0001", opts: { paused?: HelloRequest["paused"]; codexTotal?: number; claudeTotal?: number; seq?: number; noGrant?: boolean } = {}) {
  const seq = opts.seq ?? (seqs.get(peer) ?? 0) + 1; // the lender's hello seq grows across its restarts (journal meta)
  seqs.set(peer, Math.max(seq, seqs.get(peer) ?? 0));
  return recordHello(db, peer, null, { v: 1, proto: 2, boot, seq, paused: opts.paused ?? null,
    slots: { codex: { total: opts.codexTotal ?? 4, busy: 0 }, claude: { total: opts.claudeTotal ?? 3, busy: 0 } },
    grant: opts.noGrant ? null : { until: NOW + 7 * 86400_000, roles: ["write", "review"], repos: ["org/repo"], ordersPerDay: 50, ordersLeftToday: 50 } }, NOW);
}
let n = 0;
function held(peer: string, family: "codex" | "claude" = "codex") {
  const id = `T${++n}`;
  createTask(db, ctx(), { id, project: "p", title: id, kind: "code", agent: "agent-dev" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = ?", [id]);
  const input: OfferInput = { taskId: id, peer, family, repo: "org/repo", pr: null, spec: "Implement x; validate x", borrow: borrow(peer),
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: "b".repeat(40), report: null } };
  const o = offerLend(db, ctx(), input);
  claimLend(db, ctx(), peer, { v: 1, orderId: o.orderId, worker: "agent-worker" }, () => borrow(peer));
  return o.orderId;
}
const release = (peer: string, orderId: string, detail = START) =>
  leaseLend(db, ctx(), peer, { v: 1, orderId, gen: 1, action: "release", reason: "not_started", detail });
const getLendPeerBoot = (peer: string) => (db.query("SELECT boot FROM lend_peers WHERE peer = ?").get(peer) as { boot: string }).boot;
const slots = (peer = "mate") => borrowPeers(db, "p", [borrow(peer)], NOW)[0].v2?.slots;

beforeEach(() => { db = openLedger(":memory:"); seqs.clear(); hello("mate"); hello("other"); });
afterEach(() => { closeLedger(":memory:"); setConfigFailurePolicy(null); });

test("default observe: the planner sees unchanged slots, the view reports the would-be pause, nothing is written", () => {
  const id = held("mate");
  release("mate", id);
  expect(slots()).toEqual({ codex: 4, claude: 3 });
  const view = configFailureView(db, "mate");
  expect(view.mode).toBe("observe");
  expect(view.families).toMatchObject([{ family: "codex", paused: false, failure: { orderId: id, category: "model_not_enabled" } }]);
  expect(db.query("SELECT COUNT(*) AS n FROM lend_peer_cooldowns").get()).toEqual({ n: 0 });
  setMode("off");
  expect(configFailureView(db, "mate").families).toEqual([]);
  expect(slots()).toEqual({ codex: 4, claude: 3 });
});

test("on: a 400 model_not_enabled release pauses that peer's family only; evidence is the original release", () => {
  setMode("on");
  const id = held("mate");
  release("mate", id);
  expect(slots()).toEqual({ codex: 0, claude: 3 });
  expect(slots("other")).toEqual({ codex: 4, claude: 3 });
  const f = activeConfigFailures(db, "mate").codex!;
  expect(f).toMatchObject({ orderId: id, family: "codex", at: NOW, category: "model_not_enabled" });
  expect(f.text).toContain("model_not_enabled");
  expect(getLendOrder(db, id)?.status).toBe("released");
  const peers = borrowPeers(db, "p", [borrow("mate")], NOW);
  const facts: PlacementFacts = { peers: peers.map((p) => ({ ...p, roles: p.roles ?? [], v2: p.v2 ?? null })),
    remote: { mode: "balance", roles: ["review", "write"], reviewFirst: [], poolTimeoutMin: 30 },
    repo: "org/repo", local: { running: 0, room: true }, pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
  expect(placeFor(facts, "review", "codex").kind).toBe("local");
  expect(placeFor(facts, "review", "claude")).toMatchObject({ kind: "peer", peer: "mate", family: "claude" });
});

test("on: quota, network, cyber refusals and non-start releases never pause as configuration", () => {
  setMode("on");
  for (const d of ["起 worker 失败：You've hit your usage limit. model_not_enabled", "起 worker 失败：fetch failed ECONNRESET",
    "起 worker 失败：flagged for possible cybersecurity risk, model is not enabled", "clone failed: model_not_enabled"]) release("mate", held("mate"), d);
  expect(activeConfigFailures(db, "mate")).toEqual({});
});

test("on: a live (claimed) order of the paused family is untouched", () => {
  setMode("on");
  const live = held("mate");
  release("mate", held("mate"));
  expect(slots()?.codex).toBe(0);
  expect(getLendOrder(db, live)).toMatchObject({ status: "claimed", leaseGen: 1 });
  expect(leaseLend(db, ctx(), "mate", { v: 1, orderId: live, gen: 1, action: "renew", reason: null, detail: null }).lease).not.toBeNull();
});

test("time alone never recovers; same-boot hellos never recover", () => {
  setMode("on");
  release("mate", held("mate"));
  hello("mate");
  hello("mate");
  expect(borrowPeers(db, "p", [borrow("mate")], NOW + 30 * 86400_000)[0].v2?.slots.codex ?? 0).toBe(0);
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
});

test("a plain restart is not recovery: new boots offering the family, quota pause, revoke→regrant keep the fault", () => {
  setMode("on");
  release("mate", held("mate"));
  hello("mate", "boot-0002");
  hello("mate", "boot-0003", { codexTotal: 2 });
  hello("mate", "boot-0003", { paused: { reason: "codex_quota", until: NOW + 3600_000 } });
  hello("mate", "boot-0003");
  hello("mate", "boot-0004", { codexTotal: 0, noGrant: true }); // no grant = 0 slots everywhere: not a family withdrawal
  hello("mate", "boot-0004");
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
  expect(slots()).toEqual({ codex: 0, claude: 3 });
});

test("explicit re-declaration: withdraw (total 0) after the fault, then offer again recovers; a delayed pre-withdrawal hello does not", () => {
  setMode("on");
  release("mate", held("mate"));
  hello("mate", "boot-0001", { seq: 10 });
  hello("mate", "boot-0001", { seq: 11, codexTotal: 0 }); // the lender withdraws codex
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  hello("mate", "boot-0000", { seq: 5 }); // an older boot's hello replayed late (applied: different boot)
  expect(getLendPeerBoot("mate")).toBe("boot-0000");
  hello("mate", "boot-0001", { seq: 10 }); // the withdrawing boot's own older hello, applied after the boot switch
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  hello("mate", "boot-0001", { seq: 12, paused: { reason: "codex_quota", until: NOW + 3600_000 } }); // offered but paused for it
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  hello("mate", "boot-0001", { seq: 13 });
  expect(activeConfigFailures(db, "mate")).toEqual({});
  expect(configRecoveryGen(db, "mate", "codex")).toBe(1);
  expect(slots()).toEqual({ codex: 4, claude: 3 });
  expect(configRecoveryGen(db, "mate", "claude")).toBe(0); // no fault there, nothing written
});

test("re-declaration from a fresh boot after the withdrawal also counts; the withdrawal alone does not", () => {
  setMode("on");
  release("mate", held("mate"));
  hello("mate", "boot-0002", { codexTotal: 0 });
  hello("mate", "boot-0002", { codexTotal: 0 });
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
  hello("mate", "boot-0003");
  expect(configRecoveryGen(db, "mate", "codex")).toBe(1);
  expect(slots()?.codex).toBe(4);
});

test("recovery generations: a failure after recovery is new and needs its own withdrawal; an old withdrawal never clears it", () => {
  setMode("on");
  const late = held("mate");
  release("mate", held("mate"));
  hello("mate", "boot-0001", { codexTotal: 0 });
  hello("mate", "boot-0001");
  expect(slots()?.codex).toBe(4);
  release("mate", late); // started before the recovery, its release lands after: a fresh fault, not cleared
  expect(slots()?.codex).toBe(0);
  expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(late);
  hello("mate", "boot-0001");
  hello("mate", "boot-0005"); // new boot without a withdrawal of this fault
  expect(configRecoveryGen(db, "mate", "codex")).toBe(1);
  hello("mate", "boot-0005", { codexTotal: 0 });
  hello("mate", "boot-0005");
  expect(configRecoveryGen(db, "mate", "codex")).toBe(2);
  expect(slots()?.codex).toBe(4);
});

test("two orders, other peer and other family keep separate state", () => {
  setMode("on");
  release("mate", held("mate"));
  release("mate", held("mate"));
  release("other", held("other", "claude"));
  expect(slots()).toEqual({ codex: 0, claude: 3 });
  expect(slots("other")).toEqual({ codex: 4, claude: 0 });
  hello("other", "boot-0001", { claudeTotal: 0 });
  hello("other", "boot-0001");
  expect(slots("other")).toEqual({ codex: 4, claude: 3 });
  expect(slots()).toEqual({ codex: 0, claude: 3 });
});

test("observe: withdraw → re-offer writes nothing and recovers nothing; switching to on still pauses the old fault", () => {
  const id = held("mate");
  release("mate", id);
  hello("mate", "boot-0001", { codexTotal: 0 });
  hello("mate", "boot-0001");
  hello("mate", "boot-0002");
  expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'lend:config-%'").get()).toEqual({ n: 0 });
  expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(id);
  setMode("on");
  expect(slots()).toEqual({ codex: 0, claude: 3 });
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
});

test("off: recordHello records no recovery bookkeeping", () => {
  setMode("off");
  release("mate", held("mate"));
  hello("mate", "boot-0001", { codexTotal: 0 });
  hello("mate", "boot-0002");
  expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'lend:config-%'").get()).toEqual({ n: 0 });
});

test("end to end: lender's real release → borrower pause; one start, one notice; restart keeps it, owner recovery re-declares", async () => {
  setMode("on");
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
  const h = harness({ entry: { families: { codex: 2, claude: 1 }, ordersPerDay: 20 } });
  try {
    let starts = 0;
    h.d.worker.create = async () => (starts++, { ok: false, error: MODEL_400 });
    for (let i = 0; i < 4; i++) await h.tick();
    const rel = h.calls.find((c) => c.op === "lease" && c.body.action === "release")!;
    expect(rel.body.reason).toBe("not_started");
    const id = held("mate");
    release("mate", id, String(rel.body.detail));
    expect(slots()).toEqual({ codex: 0, claude: 3 });
    expect(starts).toBe(1);
    expect(h.log.notices.filter((x) => x.why?.startsWith("配置不可用"))).toHaveLength(1);
    // B's real hello body carried to A: an ordinary restart (new boot, same journal) still withdraws codex, never recovers.
    let seq = 100;
    const fromB = (boot: string) => recordHello(db, "mate", null, { v: 1, boot, seq: ++seq, ...helloBody(h.db, h.lend.lend[0], h.d.now()) }, h.d.now());
    const bSlots = () => borrowPeers(db, "p", [borrow("mate")], h.d.now())[0].v2;
    fromB("b-boot-1");
    fromB("b-boot-2");
    expect(bSlots()).toMatchObject({ slots: { codex: 0, claude: 1 }, familyTotals: { codex: 0, claude: 1 } });
    expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
    // Only B's owner's explicit recovery makes B offer codex again, which A takes as the re-declaration.
    expect(recoverProviderConfigFailure(h.db, "team-a", "codex", 1, h.d.now())).toBe(true);
    fromB("b-boot-2");
    expect(configRecoveryGen(db, "mate", "codex")).toBe(1);
    expect(activeConfigFailures(db, "mate")).toEqual({});
    expect(bSlots()?.slots).toEqual({ codex: 2, claude: 1 });
  } finally { h.db.close(); noteClaudeReadiness(null); }
});
