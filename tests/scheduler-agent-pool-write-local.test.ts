/** dispatch-recovery-WRITELOCAL1: with writeLocalEqual on, this machine's author family competes with every peer family for a new write. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import { recordObserved, recoveryPolicy, RECOVERY_KEYS, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { drainWriteLocalObserved, resetWriteLocalObserved, writeLocalFacts, writeLocalPending } from "../src/lib/scheduler-agent-pool-write-local.js";
import { peersOnly } from "../src/lib/scheduler-agent-pool-plan.js";
import { createItem } from "../src/lib/ledger-write.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { placeFor, type Placement, type PlacementFacts, type PeerFacts } from "../src/lib/scheduler-placement.js";

/** Peer Sekai: one free Claude seat, one Claude running; no Codex seat. */
const sekai = (claudeBusy = 1): PeerFacts => ({
  peer: "Sekai", roles: [], priority: "off", open: 99,
  v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 1, codex: 0 }, familyTotals: { claude: 2, codex: 0 }, familyBusy: { claude: claudeBusy, codex: 0 } },
});
/** This machine writes with Codex only (no Claude seat): 8 seats, `running` taken. */
const facts = (running = 1, over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  remote: { mode: "balance", roles: [], poolTimeoutMin: 15, agents: { claude: 0, codex: 8 } },
  peers: [sekai()], local: { room: true, running, pool: { totals: { claude: 0, codex: 8 }, running: { claude: 0, codex: running } } },
  repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true, ...over,
});
const CARD = { project: "p", task: "T1", window: "build:r0" };
const policy = (mode: RecoveryMode) => () => ({ mode, manualAfterMs: null, source: "config" as const });
const at = (mode: RecoveryMode, f = facts(), card: Partial<typeof CARD> = {}) => writeLocalFacts(f, { ...CARD, ...card }, policy(mode));
const PEER_WINS: Placement = { kind: "peer", peer: "Sekai", family: "claude", reason: "claude 在跑 1，最少优先，平手 peer 先" };

beforeEach(resetWriteLocalObserved);
afterEach(resetWriteLocalObserved); // the queue is per process: never leave records for a later test file

test("red 1: on — peer Sekai Claude load 1, local Codex 1 / 8: a new unpinned card's writing is placed here on Codex", () => {
  expect(placeFor(at("on"), "write", "claude")).toMatchObject({ kind: "local", family: "codex" });
});

// ── keep tests ──
test("the key is registered and defaults to observe", () => {
  expect(RECOVERY_KEYS).toContain("writeLocalEqual");
  expect(recoveryPolicy("no-such-project", "writeLocalEqual", "/nonexistent/recovery-policy.json").mode).toBe("observe");
});

test("before this card (no switch on the facts): the peer, word for word", () => {
  expect(placeFor(facts(), "write", "claude")).toEqual(PEER_WINS);
});

test("observe: still the peer, word for word; one『本会派本机』record per card and window, replays add nothing", async () => {
  const db = openLedger(tempLedgerPath("write-local-"));
  createItem(db, { actor: "owner", now: 0 }, { project: "p", id: "T1", title: "T1", status: "doing", ownerWords: "write-local fixture" });
  expect(placeFor(at("observe"), "write", "claude")).toEqual(PEER_WINS);
  expect(placeFor(at("observe"), "write", "claude")).toEqual(PEER_WINS);
  expect(writeLocalPending()).toEqual([{ project: "p", mechanism: "writeLocalEqual", target: "T1", actionKey: "write-local:build:r0",
    action: "本会派本机：codex 本机在跑 1 / 名额 8，peer 最少 claude 负载 1",
    data: { family: "codex", running: 1, total: 8, peerFamily: "claude", peerLoad: 1, window: "build:r0" } }]);
  const write = (a: Parameters<typeof recordObserved>[1]) => { recordObserved(db, a, 10); };
  expect(await drainWriteLocalObserved(write)).toBe(1);
  placeFor(at("observe"), "write", "claude");
  expect(await drainWriteLocalObserved(write)).toBe(0);
  // A restarted process queues it again; the ledger's dedup key keeps the one record.
  resetWriteLocalObserved();
  placeFor(at("observe"), "write", "claude");
  expect(await drainWriteLocalObserved(write)).toBe(1);
  const notes = () => listEvents(db, { project: "p" }).filter((e) => e.kind === "note");
  expect(notes().map((e) => [e.target, e.data.mechanism, e.data.actionKey])).toEqual([["T1", "writeLocalEqual", "write-local:build:r0"]]);
  // Another stage window of the same card is a new record.
  placeFor(at("observe", facts(), { window: "fix:r1" }), "write", "claude");
  await drainWriteLocalObserved(write);
  expect(notes()).toHaveLength(2);
  db.close();
});

test("observe: a failed write keeps the record for the next drain; no card = a simulation that never records", async () => {
  placeFor(at("observe"), "write", "claude");
  expect(await drainWriteLocalObserved(() => { throw new Error("query_only"); })).toBe(0);
  expect(writeLocalPending()).toHaveLength(1);
  resetWriteLocalObserved();
  expect(placeFor(writeLocalFacts(facts(), { project: "p" }, policy("observe")), "write", "claude")).toEqual(PEER_WINS);
  expect(writeLocalPending()).toEqual([]);
});

test("off, or an unreadable policy: the peer, word for word, zero records", () => {
  expect(placeFor(at("off"), "write", "claude")).toEqual(PEER_WINS);
  const broken = writeLocalFacts(facts(), CARD, () => { throw new Error("bad file"); });
  expect(placeFor(broken, "write", "claude")).toEqual(PEER_WINS);
  expect(writeLocalPending()).toEqual([]);
});

test("on: no local seat (8 / 8, or Codex over its quota line = 0 seats) keeps the peer", () => {
  expect(placeFor(at("on", facts(8)), "write", "claude")).toEqual(PEER_WINS);
  const overLine = facts(1, { local: { room: true, running: 1, pool: { totals: { claude: 0, codex: 0 }, running: { claude: 0, codex: 1 } } } });
  expect(placeFor(at("on", overLine), "write", "claude")).toEqual(PEER_WINS);
  expect(placeFor(at("observe", facts(8)), "write", "claude")).toEqual(PEER_WINS);
  expect(writeLocalPending()).toEqual([]);
});

test("on: this machine busier than the least loaded peer family keeps the peer; a tie goes here", () => {
  expect(placeFor(at("on", facts(2)), "write", "claude")).toMatchObject({ kind: "peer", peer: "Sekai" });
  expect(placeFor(at("on", facts(1, { peers: [sekai(0)] })), "write", "claude")).toMatchObject({ kind: "peer", peer: "Sekai" });
  expect(placeFor(at("on", facts(0, { peers: [sekai(0)] })), "write", "claude")).toMatchObject({ kind: "local", family: "codex" });
});

test("on: a pinned peer, a pinned local card, a private card and a held write lease are placed as before", () => {
  for (const over of [{ pin: "peer:Sekai" }, { pin: "local" }, { writeLeasePeer: "Sekai" }] as Partial<PlacementFacts>[]) {
    expect(placeFor(at("on", facts(1, over)), "write", "claude")).toEqual(placeFor(facts(1, over), "write", "claude"));
  }
  expect(placeFor(at("on", peersOnly(facts())), "write", "claude")).toEqual(PEER_WINS);
  expect(writeLocalPending()).toEqual([]);
});

test("on: a fix follows the head's author family and its write lease as before; file locks still wait", () => {
  for (const family of ["claude", "codex"] as const) {
    expect(placeFor(at("on"), "fix", family)).toEqual(placeFor(facts(), "fix", family));
  }
  expect(placeFor(at("on", facts(1, { locksFree: false })), "write", "claude")).toEqual({ kind: "wait", reason: "文件锁被别的卡占着" });
});

// ── r1 review: on is one global minimum over both peer families and this machine ──
/** Peer Sekai with a free seat in both families: Claude 5 busy, Codex idle. */
const sekaiBoth = (): PeerFacts => ({
  peer: "Sekai", roles: [], priority: "off", open: 99,
  v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 1, codex: 1 }, familyTotals: { claude: 6, codex: 1 }, familyBusy: { claude: 5, codex: 0 } },
});

test("on: both peer families free, peer Codex 0 beats local Codex 2 and peer Claude 5 — peer Codex, not the Claude-first result", () => {
  const f = facts(2, { peers: [sekaiBoth()] });
  expect(placeFor(f, "write", "claude")).toMatchObject({ kind: "peer", peer: "Sekai", family: "claude" });
  expect(placeFor(at("on", f), "write", "claude")).toMatchObject({ kind: "peer", peer: "Sekai", family: "codex" });
  // observe / off: the legacy result word for word, and no『本会派本机』record (on would not place here either)
  expect(placeFor(at("observe", f), "write", "claude")).toEqual(placeFor(f, "write", "claude"));
  expect(placeFor(at("off", f), "write", "claude")).toEqual(placeFor(f, "write", "claude"));
  expect(writeLocalPending()).toEqual([]);
});

test("on: the legacy result is already local (Claude 3 / 4) but peer Codex has load 0 — the peer wins", () => {
  const sekaiCodex: PeerFacts = { ...sekaiBoth(), v2: { ...sekaiBoth().v2!, slots: { claude: 0, codex: 1 } } };
  const f = facts(0, { peers: [sekaiCodex], remote: { mode: "balance", roles: [], poolTimeoutMin: 15, agents: { claude: 4, codex: 8 } },
    local: { room: true, running: 3, pool: { totals: { claude: 4, codex: 8 }, running: { claude: 3, codex: 0 } } } });
  expect(placeFor(f, "write", "claude")).toMatchObject({ kind: "local", family: "claude" });
  expect(placeFor(at("on", f), "write", "claude")).toMatchObject({ kind: "peer", peer: "Sekai", family: "codex" });
  expect(placeFor(at("observe", f), "write", "claude")).toEqual(placeFor(f, "write", "claude"));
  expect(writeLocalPending()).toEqual([]);
});

test("on: local Codex 0 still ties the idle peer Codex and stays here", () => {
  expect(placeFor(at("on", facts(0, { peers: [sekaiBoth()] })), "write", "claude")).toMatchObject({ kind: "local", family: "codex" });
});

// ── r2 review: a private card (peersOnly takes this machine out) is exempt, even with both peer families free ──
test("on: a private card with both peer families free keeps the legacy Claude-first peer, as off does", () => {
  const both = sekaiBoth();
  const f = facts(2, { peers: [{ ...both, v2: { ...both.v2!, repos: ["o/r", "o/private"] } }], repo: "o/private" });
  const legacy = placeFor(peersOnly(f), "write", "claude");
  expect(legacy).toMatchObject({ kind: "peer", peer: "Sekai", family: "claude" });
  for (const mode of ["on", "observe", "off"] as const) expect(placeFor(peersOnly(at(mode, f)), "write", "claude")).toEqual(legacy);
  expect(writeLocalPending()).toEqual([]);
});

test("on: a public card whose local seats are all taken (Codex 8 / 8, room false) still ranks both peer families", () => {
  const f = facts(8, { peers: [sekaiBoth()], local: { room: false, running: 8, pool: { totals: { claude: 0, codex: 8 }, running: { claude: 0, codex: 8 } } } });
  expect(placeFor(at("on", f), "write", "claude")).toMatchObject({ kind: "peer", peer: "Sekai", family: "codex" });
});
