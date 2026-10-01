/**
 * start_node's own placement keeps each peer's tier: whatever `auto` picks there is saved as the card's pin, so a tier lost
 * at this entry can never be corrected by the planner later. The answer must be the planner's (placeFor over the same
 * borrowPeers facts), and the pin it saves must place the build on that same peer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { BorrowEntry, Priority } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { placeFor, type PlacementFacts } from "../src/lib/scheduler-placement.js";
import { peerFacts } from "../src/lib/scheduler-placement-plan.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { borrowPeers } from "../src/lib/scheduler-pool-facts.js";

const now = 1000;
const remote: RemotePolicy = { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15 };
let db: Database;

beforeEach(() => {
  db = openLedger(":memory:");
  for (const peer of ["a", "b"]) recordHello(db, peer, null, { v: 1, proto: 2, boot: `boot-${peer}`, seq: 1, paused: null,
    slots: { codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: now + 3_600_000, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 9, ordersLeftToday: 9 } }, now);
});
afterEach(() => closeLedger(":memory:"));

const borrowOf = (tiers: Priority[]): BorrowEntry[] =>
  tiers.map((priority, i) => ({ peer: ["a", "b"][i], projects: ["p"], roles: ["review", "write"], maxOpen: 2, priority }));

async function both(tiers: Priority[]) {
  const borrow = borrowOf(tiers);
  const got = await startPlacement(db, { policy: () => ({ remote, maxWorkers: 2 }), borrow: async () => borrow, originRepo: async () => "o/r", now: () => now },
    { project: "p", repoDir: "/r", fileGlobs: ["src/lib/a.ts"], want: "auto" });
  const facts: PlacementFacts = { remote, repo: "o/r", peers: borrowPeers(db, "p", borrow, now).map(peerFacts), local: { running: 0, room: true },
    pin: null, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: true };
  return { got, planner: placeFor(facts, "write", "claude"), facts };
}

describe("start_node auto placement keeps the borrow entry's tier", () => {
  test("a idle at low, b idle at first: start picks b, the planner agrees, and the saved pin builds at b", async () => {
    const { got, planner, facts } = await both(["low", "first"]);
    expect(got).toMatchObject({ where: "peer", peer: "b", repo: "o/r" });
    expect(planner).toMatchObject({ kind: "peer", peer: "b" });
    expect(placeFor({ ...facts, pin: "peer:b" }, "write", "claude")).toMatchObject({ kind: "peer", peer: "b" });
  });

  test("the only peer is off: start lands local (no pin the planner would then refuse and wait on)", async () => {
    const { got, planner } = await both(["off"]);
    expect(got).toMatchObject({ where: "local" });
    expect(planner).toMatchObject({ kind: "local" });
  });

  test("first ahead of balance whatever the borrow order; all balance keeps the W5 order", async () => {
    expect((await both(["balance", "first"])).got).toMatchObject({ where: "peer", peer: "b" });
    expect((await both(["balance", "balance"])).got).toMatchObject({ where: "peer", peer: "a" });
  });
});
