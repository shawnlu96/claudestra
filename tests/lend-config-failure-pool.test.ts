/** dispatch-recovery-LCFG1, borrower side: real ledger + pool planner + recordHello; per peer + family pause, explicit re-declaration recovery. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { claimLend, getLendOrder, leaseLend, offerLend, type OfferInput } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";
import { placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { HelloRequest } from "../src/lib/lend-wire-v2.js";
import { configRecoveredDecl, noteStartConfigFailure, providerConfigFailure, recoverProviderConfigFailure, setConfigFailurePolicy, startConfigRefusal } from "../src/lib/lend-config-failure.js";
import { openLendJournal as openJournal, type LendRow } from "../src/lib/lend-journal.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { noteClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { harness, polled } from "./lend-harness.js";
import { activeConfigFailures, configFailureView, configRecoveryGen } from "../src/lib/lend-config-failure-pool.js";

const NOW = Date.parse("2026-10-06T05:00:00Z");
const MODEL_400 = "创建失败: 引导轮失败：400 Bad Request {\"error\":{\"code\":\"model_not_enabled\",\"message\":\"The model `gpt-9` is not enabled for this account.\"}}";
const START = `起 worker 失败：${MODEL_400}`;
const setMode = (mode: "on" | "observe" | "off") => setConfigFailurePolicy(() => ({ mode, manualAfterMs: null, source: "config" }));
const borrow = (peer: string): BorrowEntry => ({ peer, projects: ["p"], roles: ["write", "review"], maxOpen: 10 });
let db: Database;
const seqs = new Map<string, number>();
const ctx = (now = NOW) => ({ actor: "owner", now });
type HelloOpts = { paused?: HelloRequest["paused"]; codexTotal?: number; claudeTotal?: number; seq?: number; noGrant?: boolean; recovered?: HelloRequest["configRecovered"] };
function hello(peer: string, boot = "boot-0001", opts: HelloOpts = {}) {
  const seq = opts.seq ?? (seqs.get(peer) ?? 0) + 1; // the lender's hello seq grows across its restarts (journal meta)
  seqs.set(peer, Math.max(seq, seqs.get(peer) ?? 0));
  return recordHello(db, peer, null, { v: 1, proto: 2, boot, seq, paused: opts.paused ?? null, ...(opts.recovered ? { configRecovered: opts.recovered } : {}),
    slots: { codex: { total: opts.codexTotal ?? 4, busy: 0 }, claude: { total: opts.claudeTotal ?? 3, busy: 0 } },
    grant: opts.noGrant ? null : { until: NOW + 7 * 86400_000, roles: ["write", "review"], repos: ["org/repo"], ordersPerDay: 50, ordersLeftToday: 50 } }, NOW);
}
let n = 0;
function buildTask(id = `T${++n}`) {
  createTask(db, ctx(), { id, project: "p", title: id, kind: "code", agent: "agent-dev" });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = ?", [id]);
  return id;
}
function offered(peer: string, family: "codex" | "claude" = "codex", id = buildTask()) {
  const input: OfferInput = { taskId: id, peer, family, repo: "org/repo", pr: null, spec: "Implement x; validate x", borrow: borrow(peer),
    write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: "b".repeat(40), report: null } };
  return offerLend(db, ctx(), input).orderId;
}
const claim = (peer: string, orderId: string) => (claimLend(db, ctx(), peer, { v: 1, orderId, worker: "agent-worker" }, () => borrow(peer)), orderId);
const held = (peer: string, family: "codex" | "claude" = "codex") => claim(peer, offered(peer, family));
/**
 * Volume orders (r4): offerLend's outbound gate costs ~1ms an order, which 500 orders turn into most of the test. So one real offer is the
 * template and each further order copies the rows that offer wrote (order + write lease) onto a fresh task; claim and release still run
 * for real. "bulk copies equal real offers" pins that a copy is byte-for-byte what offerLend would have written.
 */
type OfferRows = { task: string; order: Record<string, unknown>; lease: Record<string, unknown> };
function offerRows(orderId: string): OfferRows {
  const order = db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(orderId) as Record<string, unknown>;
  const task = order.taskId as string;
  return { task, order, lease: db.query("SELECT * FROM lend_write_leases WHERE taskId = ?").get(task) as Record<string, unknown> };
}
function rowsFor(t: OfferRows, task: string): Omit<OfferRows, "task"> {
  const swap = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? v.split(t.task).join(task) : v]));
  const order = swap(t.order);
  return { order: { ...order, sha256: createHash("sha256").update(order.text as string, "utf8").digest("hex") }, lease: swap(t.lease) };
}
function insertRow(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(cols.map((c) => row[c]) as SQLQueryBindings[]));
}
function heldCopy(peer: string, t: OfferRows) {
  const rows = rowsFor(t, buildTask());
  insertRow("lend_orders", rows.order);
  insertRow("lend_write_leases", rows.lease);
  return claim(peer, rows.order.orderId as string);
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

test("explicit declaration: clears exactly the faults of the orders it names; other peer / family / unnamed orders stay", () => {
  setMode("on");
  const first = held("mate");
  const id = held("mate");
  release("mate", first);
  release("mate", id);
  hello("mate", "boot-0001", { codexTotal: 0 });
  hello("mate", "boot-0001"); // withdraw → re-offer alone is not a declaration
  hello("mate", "boot-0001", { recovered: { claude: { gen: 1, orders: [id] } } }); // other family
  hello("other", "boot-0001", { recovered: { codex: { gen: 1, orders: [first, id] } } }); // other peer
  expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(id);
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
  hello("mate", "boot-0001", { recovered: { codex: { gen: 1, orders: [id] } } }); // names only the newest: the older fault shows
  expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(first);
  expect(slots()?.codex).toBe(0);
  hello("mate", "boot-0001", { recovered: { codex: { gen: 2, orders: [first] } } });
  expect(activeConfigFailures(db, "mate")).toEqual({});
  expect(configRecoveryGen(db, "mate", "codex")).toBe(2);
  expect(slots()).toEqual({ codex: 4, claude: 3 });
  expect(configRecoveryGen(db, "mate", "claude")).toBe(0); // no fault there, nothing written
  expect(configRecoveryGen(db, "other", "codex")).toBe(0);
});

test("recovery generations: a failure after recovery needs a newer declared generation naming it; old or repeated declarations are refused", () => {
  setMode("on");
  const late = held("mate");
  const a = held("mate");
  release("mate", a);
  hello("mate", "boot-0001", { recovered: { codex: { gen: 3, orders: [a] } } });
  expect(slots()?.codex).toBe(4);
  release("mate", late); // started before the recovery, its release lands after: a fresh fault, not cleared
  expect(slots()?.codex).toBe(0);
  hello("mate", "boot-0001", { recovered: { codex: { gen: 3, orders: [a] } } }); // the old declaration keeps coming
  hello("mate", "boot-0005", { recovered: { codex: { gen: 3, orders: [a, late] } } }); // same generation again: refused
  hello("mate", "boot-0005", { recovered: { codex: { gen: 2, orders: [late] } } }); // older generation: refused
  expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(late);
  expect(configRecoveryGen(db, "mate", "codex")).toBe(3);
  hello("mate", "boot-0005", { recovered: { codex: { gen: 4, orders: [late] } } });
  expect(configRecoveryGen(db, "mate", "codex")).toBe(4);
  expect(slots()?.codex).toBe(4);
});

test("two orders, other peer and other family keep separate state", () => {
  setMode("on");
  release("mate", held("mate"));
  release("mate", held("mate"));
  const c = held("other", "claude");
  release("other", c);
  expect(slots()).toEqual({ codex: 0, claude: 3 });
  expect(slots("other")).toEqual({ codex: 4, claude: 0 });
  hello("other", "boot-0001", { recovered: { claude: { gen: 1, orders: [c] } } });
  expect(slots("other")).toEqual({ codex: 4, claude: 3 });
  expect(slots()).toEqual({ codex: 0, claude: 3 });
});

test("observe: a declaration writes nothing and recovers nothing; switching to on still pauses the old fault", () => {
  const id = held("mate");
  release("mate", id);
  hello("mate", "boot-0001", { codexTotal: 0 });
  hello("mate", "boot-0001", { recovered: { codex: { gen: 1, orders: [id] } } });
  hello("mate", "boot-0002");
  expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'lend:config-%'").get()).toEqual({ n: 0 });
  expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(id);
  setMode("on");
  expect(slots()).toEqual({ codex: 0, claude: 3 });
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
});

test("off: recordHello records no recovery bookkeeping", () => {
  setMode("off");
  const id = held("mate");
  release("mate", id);
  hello("mate", "boot-0001", { recovered: { codex: { gen: 1, orders: [id] } } });
  hello("mate", "boot-0002");
  expect(db.query("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'lend:config-%'").get()).toEqual({ n: 0 });
});

test("end to end: lender's real release → borrower pause; one start, one notice; restart keeps it, owner recovery declares", async () => {
  setMode("on");
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
  const h = harness({ entry: { families: { codex: 2, claude: 1 }, ordersPerDay: 20 } });
  try {
    let starts = 0;
    const id = held("mate"); // A's order is the one B polls (same order id on both sides)
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled(id)], pollAfterMs: 30_000 } });
    h.d.worker.create = async () => (starts++, { ok: false, error: MODEL_400 });
    for (let i = 0; i < 4; i++) await h.tick();
    const rel = h.calls.find((c) => c.op === "lease" && c.body.action === "release")!;
    expect(rel.body).toMatchObject({ orderId: id, reason: "not_started" });
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
    // Only B's owner's explicit recovery makes B declare it (configRecovered naming the fault order), which A accepts.
    expect(helloBody(h.db, h.lend.lend[0], h.d.now()).configRecovered).toBeUndefined();
    expect(recoverProviderConfigFailure(h.db, "team-a", "codex", 1, h.d.now())).toBe(true);
    expect(helloBody(h.db, h.lend.lend[0], h.d.now()).configRecovered).toEqual({ codex: { gen: 1, orders: [id] } });
    fromB("b-boot-2");
    expect(configRecoveryGen(db, "mate", "codex")).toBe(1);
    expect(activeConfigFailures(db, "mate")).toEqual({});
    expect(bSlots()?.slots).toEqual({ codex: 2, claude: 1 });
  } finally { h.db.close(); noteClaudeReadiness(null); }
});

test("r2 probe: B switching on→observe re-offers without owner recovery; A (on) keeps the fault", async () => {
  setMode("on");
  noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
  const h = harness({ entry: { families: { codex: 2, claude: 1 }, ordersPerDay: 20 } });
  try {
    h.d.worker.create = async () => ({ ok: false, error: MODEL_400 });
    for (let i = 0; i < 4; i++) await h.tick();
    const rel = h.calls.find((c) => c.op === "lease" && c.body.action === "release")!;
    release("mate", held("mate"), String(rel.body.detail));
    let seq = 100;
    const fromB = () => recordHello(db, "mate", null, { v: 1, boot: "b-boot-1", seq: ++seq, ...helloBody(h.db, h.lend.lend[0], h.d.now()) }, h.d.now());
    fromB(); // on: B withdraws codex (total 0)
    setMode("observe");
    const body = helloBody(h.db, h.lend.lend[0], h.d.now()); // B under observe: positive slots, no owner recovery
    expect(body.slots.codex.total).toBe(2);
    setMode("on"); // A is a different instance and stays on
    recordHello(db, "mate", null, { v: 1, boot: "b-boot-1", seq: ++seq, ...body }, h.d.now());
    expect(activeConfigFailures(db, "mate").codex).toBeDefined();
    expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
  } finally { h.db.close(); noteClaudeReadiness(null); }
});

test("r2 probe: a static capacity change (family set to 0, later back) is not owner recovery", () => {
  setMode("on");
  release("mate", held("mate"));
  hello("mate", "boot-0001", { codexTotal: 0 }); // owner set codex to 0 for an unrelated reason
  hello("mate", "boot-0001", { codexTotal: 2 });
  hello("mate", "boot-0002", { codexTotal: 3 });
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
});

test("r2 probe: replayed hellos of older boots (seq below the high-water mark) never clear a current fault", () => {
  setMode("on");
  hello("mate", "boot-cur1", { seq: 100, codexTotal: 2 });
  release("mate", held("mate"));
  expect(hello("mate", "boot-old1", { seq: 1, codexTotal: 2 }).applied).toBe(true);
  expect(hello("mate", "boot-old2", { seq: 2, codexTotal: 0 }).applied).toBe(true);
  expect(hello("mate", "boot-old3", { seq: 3, codexTotal: 2 }).applied).toBe(true);
  expect(activeConfigFailures(db, "mate").codex).toBeDefined();
  expect(configRecoveryGen(db, "mate", "codex")).toBe(0);
});

test("r3 probe: reordered releases + an early old declaration never clear a newer generation's fault (real B journal)", async () => {
  setMode("on");
  const bdb = openJournal(":memory:");
  try {
    const old = held("mate");
    const fresh = held("mate");
    const row = (orderId: string) => ({ orderId, peer: "mate", family: "codex" }) as LendRow;
    const d = { db: bdb, now: () => NOW, notify: async () => ({ ok: true as const }), log: () => {} };
    await noteStartConfigFailure(d, row(old), MODEL_400); // B: generation 1
    expect(recoverProviderConfigFailure(bdb, "mate", "codex", 1, NOW)).toBe(true);
    const decl1 = configRecoveredDecl(bdb, "mate")!;
    expect(decl1).toEqual({ codex: { gen: 1, orders: [old] } });
    hello("mate", "boot-0001", { recovered: decl1 }); // reaches A before old's release
    await noteStartConfigFailure(d, row(fresh), MODEL_400); // B: generation 2, unrecovered
    expect(providerConfigFailure(bdb, "mate", "codex")).toMatchObject({ gen: 2, recoveredAt: null });
    release("mate", fresh);
    release("mate", old); // delayed
    expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(fresh);
    hello("mate", "boot-0001", { recovered: decl1 }); // the saved generation-1 declaration replayed
    hello("mate", "boot-0002", { recovered: decl1 });
    expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(fresh);
    expect(slots()?.codex).toBe(0);
    expect(configRecoveryGen(db, "mate", "codex")).toBe(1);
    expect(recoverProviderConfigFailure(bdb, "mate", "codex", 2, NOW)).toBe(true);
    hello("mate", "boot-0002", { recovered: configRecoveredDecl(bdb, "mate") });
    expect(activeConfigFailures(db, "mate")).toEqual({});
    expect(configRecoveryGen(db, "mate", "codex")).toBe(2);
  } finally { bdb.close(); }
});

test("r3 probe: declaration order vs release order — late old release after a late declaration, and B refusals tie to their root", async () => {
  setMode("on");
  const bdb = openJournal(":memory:");
  try {
    const row = (orderId: string) => ({ orderId, peer: "mate", family: "codex" }) as LendRow;
    const d = { db: bdb, now: () => NOW, notify: async () => ({ ok: true as const }), log: () => {} };
    const ids = [held("mate")];
    await noteStartConfigFailure(d, row(ids[0]), MODEL_400);
    for (let i = 0; i < 24; i++) { // 24 refusals arrive first, the root's release still pending
      const id = held("mate");
      ids.push(id);
      const refusal = startConfigRefusal(d, row(id))!;
      expect(refusal).toContain(`单 ${ids[0]}）`); // every refusal names the root order
      release("mate", id, refusal);
    }
    expect(slots()?.codex).toBe(0);
    expect(recoverProviderConfigFailure(bdb, "mate", "codex", 1, NOW)).toBe(true);
    const decl = configRecoveredDecl(bdb, "mate")!;
    expect(decl.codex!.orders).toHaveLength(20); // evidence was truncated, the root is kept first
    expect(decl.codex!.orders[0]).toBe(ids[0]);
    hello("mate", "boot-0001", { recovered: decl });
    expect(activeConfigFailures(db, "mate")).toEqual({});
    release("mate", ids[0]); // the root's own release arrives after the declaration: covered, still recovered
    expect(activeConfigFailures(db, "mate")).toEqual({});
    expect(slots()?.codex).toBe(4);
  } finally { bdb.close(); }
});

test("r4 probe: 501 covered orders retain old recovery and refusal roots across ledger reopen", async () => {
  setMode("on");
  const dir = mkdtempSync(join(tmpdir(), "lcfg1-coverage-"));
  const path = join(dir, "ledger.sqlite");
  const bdb = openJournal(":memory:");
  closeLedger(":memory:");
  db = openLedger(path);
  try {
    hello("mate");
    const root = held("mate");
    const refused = held("mate");
    const delayed = held("mate");
    const row = (orderId: string) => ({ orderId, peer: "mate", family: "codex" }) as LendRow;
    const d = { db: bdb, now: () => NOW, notify: async () => ({ ok: true as const }), log: () => {} };
    await noteStartConfigFailure(d, row(root), MODEL_400);
    const refusal = startConfigRefusal(d, row(root))!;
    release("mate", root);
    release("mate", refused, refusal);
    expect(recoverProviderConfigFailure(bdb, "mate", "codex", 1, NOW)).toBe(true);
    const first = configRecoveredDecl(bdb, "mate")!;
    // Root coverage also recovers refusals absent from the bounded declaration.
    expect(first.codex!.orders).toEqual([root]);
    hello("mate", "boot-0001", { recovered: first });
    expect(activeConfigFailures(db, "mate")).toEqual({});
    const template = offerRows(offered("mate"));
    db.transaction(() => { // one commit for the 500-order fixture; each write inside keeps its own savepoint
      for (let gen = 2; gen <= 26; gen++) {
        const orders: string[] = [];
        for (let i = 0; i < 20; i++) {
          const id = gen === 2 && i === 0 ? claim("mate", template.order.orderId as string) : heldCopy("mate", template);
          release("mate", id);
          orders.push(id);
        }
        hello("mate", "boot-0001", { recovered: { codex: { gen, orders } } });
      }
    })();
    expect(configRecoveryGen(db, "mate", "codex")).toBe(26);
    expect(activeConfigFailures(db, "mate")).toEqual({});
    expect(slots()?.codex).toBe(4);
    closeLedger(path);
    db = openLedger(path);
    release("mate", delayed, refusal); // late refusal still refers to the oldest recovered root
    hello("mate", "boot-0002", { recovered: first }); // replay must neither be needed nor lower gen
    expect(configRecoveryGen(db, "mate", "codex")).toBe(26);
    expect(activeConfigFailures(db, "mate")).toEqual({});
    expect(slots()?.codex).toBe(4);
    const fresh = held("mate");
    release("mate", fresh);
    hello("mate", "boot-0002", { recovered: first });
    expect(activeConfigFailures(db, "mate").codex?.orderId).toBe(fresh);
    expect(slots()?.codex).toBe(0);
  } finally { closeLedger(path); bdb.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("bulk copies equal real offers: the r4 volume fixture writes exactly the rows offerLend would", () => {
  const template = offerRows(offered("mate"));
  const real = offerRows(offered("mate"));
  expect(real.order.text).toContain(real.task);
  expect(rowsFor(template, real.task)).toEqual({ order: real.order, lease: real.lease });
});
