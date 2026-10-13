/** dispatch-recovery-REVLOCAL1: with reviewLocalFirst on, a review goes to this machine whenever its family has a free seat here. */
import { beforeEach, expect, test } from "bun:test";
import { listEvents, openLedger } from "../src/lib/ledger-store.js";
import { recordObserved, recoveryPolicy, RECOVERY_KEYS, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { drainReviewLocalObserved, resetReviewLocalObserved, reviewLocalFacts, reviewLocalPending } from "../src/lib/scheduler-agent-pool-review-local.js";
import { createItem } from "../src/lib/ledger-write.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { placeFor, type Placement, type PlacementFacts, type PeerFacts } from "../src/lib/scheduler-placement.js";

const peer = (name: string, busy = { claude: 0, codex: 0 }): PeerFacts => ({
  peer: name, roles: [], priority: "off", open: 99,
  v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 4, codex: 4 }, familyTotals: { claude: 5, codex: 5 }, familyBusy: busy },
});
/** Local Codex: 8 seats, 2 running; the peer's Codex is idle. The card was written by Claude, so its review asks for codex. */
const facts = (mode: "on" | "observe" | "off"): PlacementFacts => ({
  remote: { mode: "balance", roles: [], poolTimeoutMin: 15, localPriority: "off", localFamilies: ["claude"],
    writeFamilies: ["codex"], agents: { claude: 4, codex: 8 } },
  peers: [peer("mate")], local: { room: true, running: 2, pool: { totals: { claude: 4, codex: 8 }, running: { claude: 0, codex: 2 } } },
  repo: "o/r", pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true,
  reviewLocal: { mode: () => mode },
} as PlacementFacts);

test("red 1: on — local codex 2 / 8 running, peer codex idle: the review of a Claude-written card is placed here", () => {
  expect(placeFor(facts("on"), "review", "codex")).toMatchObject({ kind: "local", family: "codex" });
});

// ── keep tests ──
const CARD = { project: "p", task: "T1", round: 2 };
const policy = (mode: RecoveryMode) => () => ({ mode, manualAfterMs: null, source: "config" as const });
/** The same facts without the switch: what placement was before this card. */
const bare = (f: PlacementFacts): PlacementFacts => { const { reviewLocal: _, ...rest } = f as PlacementFacts & { reviewLocal?: unknown }; return rest; };
const PEER_WINS: Placement = { kind: "peer", peer: "mate", family: "codex", reason: "codex 在跑 0，最少优先，平手 peer 先" };

beforeEach(resetReviewLocalObserved);

test("the key is registered and defaults to observe", () => {
  expect(RECOVERY_KEYS).toContain("reviewLocalFirst");
  expect(recoveryPolicy("no-such-project", "reviewLocalFirst", "/nonexistent/recovery-policy.json").mode).toBe("observe");
});

test("observe: still the peer, word for word; one『本会派本机』record per card and round, replays add nothing", async () => {
  const db = openLedger(tempLedgerPath("review-local-"));
  createItem(db, { actor: "owner", now: 0 }, { project: "p", id: "T1", title: "T1", status: "doing", ownerWords: "review-local fixture" });
  const f = reviewLocalFacts(bare(facts("off")), CARD, policy("observe"));
  expect(placeFor(f, "review", "codex")).toEqual(PEER_WINS);
  expect(placeFor(f, "review", "codex")).toEqual(PEER_WINS); // a replayed plan queues nothing new
  expect(reviewLocalPending()).toHaveLength(1);
  const write = (a: Parameters<typeof recordObserved>[1]) => { recordObserved(db, a, 10); };
  expect(await drainReviewLocalObserved(write)).toBe(1);
  expect(placeFor(reviewLocalFacts(bare(facts("off")), CARD, policy("observe")), "review", "codex")).toEqual(PEER_WINS);
  expect(await drainReviewLocalObserved(write)).toBe(0);
  // A restarted process queues it again; the ledger's dedup key keeps the one record.
  resetReviewLocalObserved();
  placeFor(reviewLocalFacts(bare(facts("off")), CARD, policy("observe")), "review", "codex");
  expect(await drainReviewLocalObserved(write)).toBe(1);
  const notes = listEvents(db, { project: "p" }).filter((e) => e.kind === "note");
  expect(notes.map((e) => [e.target, e.text, e.data.mechanism, e.data.actionKey])).toEqual([
    ["T1", "恢复观察（reviewLocalFirst）：本会 派本机：codex 本机在跑 2 / 名额 8", "reviewLocalFirst", "review-local:r2"]]);
  // The next review round of the same card is a new record.
  placeFor(reviewLocalFacts(bare(facts("off")), { ...CARD, round: 3 }, policy("observe")), "review", "codex");
  await drainReviewLocalObserved(write);
  expect(listEvents(db, { project: "p" }).filter((e) => e.kind === "note")).toHaveLength(2);
  db.close();
});

test("observe: a failed write keeps the record for the next drain", async () => {
  placeFor(reviewLocalFacts(bare(facts("off")), CARD, policy("observe")), "review", "codex");
  expect(await drainReviewLocalObserved(() => { throw new Error("query_only"); })).toBe(0);
  expect(reviewLocalPending()).toHaveLength(1);
});

test("observe records only what on would change: no record when the local seat already wins or there is none", () => {
  const idle = reviewLocalFacts(bare(facts("off")), CARD, policy("observe")); idle.peers = [peer("mate", { claude: 0, codex: 3 })];
  expect(placeFor(idle, "review", "codex")).toMatchObject({ kind: "local" }); // local 2 < peer 3: already here
  const full = reviewLocalFacts(bare(facts("off")), CARD, policy("observe")); full.local.pool!.running.codex = 8;
  expect(placeFor(full, "review", "codex")).toEqual(PEER_WINS);
  expect(reviewLocalPending()).toEqual([]);
});

test("off: the peer, word for word, and nothing recorded; a policy read that throws or is unknown counts as off", () => {
  const boom = () => { throw new Error("bad file"); };
  for (const p of [policy("off"), boom, policy("yes" as RecoveryMode)]) {
    expect(placeFor(reviewLocalFacts(bare(facts("off")), CARD, p), "review", "codex")).toEqual(PEER_WINS);
  }
  expect(placeFor(bare(facts("off")), "review", "codex")).toEqual(PEER_WINS); // no switch attached at all
  expect(reviewLocalPending()).toEqual([]);
});

test("on: a full local family still goes to the least loaded peer, ties to the peer; no peer and no seat waits", () => {
  const f = facts("on"); f.local.pool!.running.codex = 8;
  expect(placeFor(f, "review", "codex")).toEqual(PEER_WINS);
  f.peers = [];
  expect(placeFor(f, "review", "codex")).toEqual({ kind: "wait", reason: "等 codex 空位" });
  expect(placeFor(facts("on"), "review", "codex")).toEqual({ kind: "local", family: "codex", reason: "codex 本机在跑 2 / 名额 8，审查本机有空位先派本机" });
});

test("on: the cross family is kept — a review asking for claude never takes a local codex seat", () => {
  const f = facts("on"); f.local.pool = { totals: { claude: 0, codex: 8 }, running: { claude: 0, codex: 2 } };
  expect(placeFor(f, "review", "claude")).toMatchObject({ kind: "peer", peer: "mate", family: "claude" });
});

test("on: a pinned card's review is placed as before", () => {
  for (const pin of ["peer:mate", "local"]) {
    const f = { ...facts("on"), pin };
    expect(placeFor(f, "review", "codex")).toEqual(placeFor(bare(f), "review", "codex"));
    expect(placeFor(f, "review", "codex")).toEqual(PEER_WINS);
  }
});

test("on: write and fix placement is unchanged, and the switch is never read for them", () => {
  let reads = 0;
  const shapes: Partial<PlacementFacts>[] = [{}, { writeLeasePeer: "mate" }, { pin: "peer:mate" }, { pin: "local" }, { locksFree: false },
    { local: { room: true, running: 8, pool: { totals: { claude: 4, codex: 8 }, running: { claude: 4, codex: 8 } } } },
    { local: { room: true, running: 2, family: "codex", pool: { totals: { claude: 4, codex: 8 }, running: { claude: 0, codex: 2 } } } }];
  for (const over of shapes) for (const role of ["write", "fix"] as const) for (const family of ["claude", "codex"] as const) {
    const f = { ...facts("on"), ...over, reviewLocal: { card: CARD, mode: () => { reads++; return "on" as const; } } } as PlacementFacts;
    expect(placeFor(f, role, family)).toEqual(placeFor(bare(f), role, family));
  }
  expect(reads).toBe(0);
  expect(reviewLocalPending()).toEqual([]);
});

test("a card bound to its local reviewer (planned with no peers) stays here in every mode, with no record", () => {
  for (const mode of ["on", "observe", "off"] as const) {
    const f = { ...reviewLocalFacts(bare(facts("off")), CARD, policy(mode)), peers: [] };
    expect(placeFor(f, "review", "codex")).toEqual({ kind: "local", family: "codex", reason: "codex 本机在跑 2，有空位且负载最少" });
  }
  expect(reviewLocalPending()).toEqual([]);
});

test("the policy file is read lazily and at most once per placement facts", () => {
  let reads = 0;
  const f = reviewLocalFacts(bare(facts("off")), CARD, () => { reads++; return { mode: "on", manualAfterMs: null, source: "config" }; });
  expect(reads).toBe(0);
  placeFor(f, "review", "codex"); placeFor(f, "review", "codex");
  expect(reads).toBe(1);
});
