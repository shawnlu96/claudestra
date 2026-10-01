/**
 * i28-W9 tiers in placeFor, pure: first → balance → low, off never (peers and this machine); every machine on balance (or
 * no priority at all) places and explains exactly as W5 did; hard constraints still come first; reviewFirst stays the
 * review-only `first` it was. Writing goes to the lender's first free family (codex, then claude); a fix only goes back to
 * the write-lease holder, and waits for it rather than moving.
 */
import { describe, expect, test } from "bun:test";
import type { Priority } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { placeFor, type PeerFacts, type PlacementFacts, type PlaceRole } from "../src/lib/scheduler-placement.js";

const REVIEW: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const WRITE: RemotePolicy = { ...REVIEW, roles: ["review", "write"], repo: "o/r" };
const grant = (over: Partial<NonNullable<PeerFacts["v2"]>> = {}): PeerFacts["v2"] =>
  ({ why: null, slots: { codex: 2, claude: 2 }, roles: ["review", "write"], repos: ["o/r"], ...over });
const mk = (peer: string, open = 0, over: Partial<PeerFacts> = {}): PeerFacts => ({ peer, roles: ["review", "write"], open, v2: grant(), ...over });
const tier = (p: PeerFacts, priority: Priority): PeerFacts => ({ ...p, priority });
const FULL = grant({ slots: { codex: 0, claude: 0 } });
const base = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  remote: WRITE, peers: [mk("a"), mk("b")], repo: "o/r", local: { running: 0, room: true }, pin: null, tried: [],
  lastPeer: null, writeLeasePeer: null, locksFree: true, ...over,
});
const local = (f: PlacementFacts, p: Priority): PlacementFacts => ({ ...f, remote: { ...(f.remote as RemotePolicy), localPriority: p } });
const where = (f: PlacementFacts, role: PlaceRole = "review") => {
  const p = placeFor(f, role, "codex");
  return p.kind === "peer" ? p.peer : p.kind;
};

describe("all balance = W5, word for word", () => {
  const scenes: [string, PlacementFacts, PlaceRole][] = [
    ["idle", base(), "review"],
    ["loaded local", base({ local: { running: 3, room: true }, peers: [mk("a", 1), mk("b", 2)] }), "review"],
    ["re-review", base({ lastPeer: "b" }), "review"],
    ["local full", base({ local: { running: 2, room: false }, peers: [mk("a", 5)] }), "review"],
    ["no usable peer", base({ peers: [mk("a", 0, { v2: FULL })] }), "write"],
    ["write", base({ local: { running: 1, room: true } }), "write"],
    ["review-only config writing", base({ remote: REVIEW }), "write"],
    ["reviewFirst", base({ remote: { ...WRITE, reviewFirst: ["b"] }, peers: [mk("a"), mk("b", 3)] }), "review"],
  ];
  for (const [name, f, role] of scenes) {
    test(name, () => {
      const explicit = local({ ...f, peers: f.peers.map((p) => tier(p, "balance")) }, "balance");
      expect(placeFor(explicit, role, "codex")).toEqual(placeFor(f, role, "codex"));
      expect(placeFor(f, role, "codex").reason).not.toContain("档位");
    });
  }
});

describe("tiers", () => {
  test("a first peer that can take it wins over idle balance machines, whatever its load", () => {
    const f = base({ peers: [mk("a"), tier(mk("b", 4), "first")] });
    expect(placeFor(f, "write", "claude")).toMatchObject({ kind: "peer", peer: "b", family: "codex", reason: expect.stringContaining("档位 first") });
    expect(where(f)).toBe("b");
  });

  test("two first peers: fewest running among them", () => {
    expect(where(base({ peers: [tier(mk("a", 3), "first"), tier(mk("b", 1), "first"), mk("c")] }))).toBe("b");
  });

  test("first full (no slot) → balance, local and peers spread as before", () => {
    const f = base({ peers: [tier(mk("a", 0, { v2: FULL }), "first"), mk("b", 1)], local: { running: 0, room: true } });
    expect(placeFor(f, "write", "claude")).toEqual({ kind: "local", reason: "在跑：b 1 / 本机 0；选最少，平手按 peer 先于本机 > 借入顺序" });
    expect(where({ ...f, local: { running: 2, room: true } }, "write")).toBe("b");
  });

  test("local on first: this machine first while it has room, then the peers", () => {
    const f = local(base({ peers: [mk("a")] }), "first");
    expect(where({ ...f, local: { running: 5, room: true } }, "write")).toBe("local");
    expect(where({ ...f, local: { running: 5, room: false } }, "write")).toBe("a");
  });

  test("low only when every balance machine is full", () => {
    const low = tier(mk("l"), "low");
    expect(where(base({ peers: [low, mk("b", 2)] }))).toBe("local");
    expect(where(base({ peers: [low, mk("b", 2)], local: { running: 0, room: false } }))).toBe("b");
    expect(where(base({ peers: [low, mk("b", 0, { v2: FULL })], local: { running: 0, room: true } }))).toBe("local");
    expect(where(base({ peers: [low, mk("b", 0, { v2: FULL })], local: { running: 0, room: false } }))).toBe("l");
    expect(where(local(base({ peers: [low] }), "low"))).toBe("l"); // both low: fewest running, peer before this machine
  });

  test("off never gets anything: peer off, even when it is the only one; local off waits instead of running here", () => {
    const f = base({ peers: [tier(mk("a"), "off")], local: { running: 0, room: false } });
    expect(placeFor(f, "write", "claude")).toEqual({ kind: "local", reason: "本机满且没有可用的 peer：本机照常排队" });
    expect(where(base({ peers: [tier(mk("a"), "off"), tier(mk("b", 9), "low")] }))).toBe("local");
    const lonely = local(base({ peers: [tier(mk("a"), "off")] }), "off");
    expect(placeFor(lonely, "write", "claude")).toEqual({ kind: "wait", reason: "scheduler.json remote.localPriority = off，又没有能接的 peer：等" });
    expect(where(local(base({ peers: [mk("a", 7)] }), "off"), "write")).toBe("a");
  });

  test("off peer is refused even when pinned or listed in reviewFirst", () => {
    const off = tier(mk("a"), "off");
    expect(placeFor(base({ pin: "peer:a", peers: [off] }), "write", "claude")).toMatchObject({ kind: "wait", reason: expect.stringContaining("设成 off") });
    expect(where(base({ remote: { ...WRITE, reviewFirst: ["a"] }, peers: [off, mk("b")] }))).toBe("b");
  });

  test("hard constraints before tiers: a first peer without the write grant / locks / repo never gets the write", () => {
    const a = tier(mk("a", 0, { v2: grant({ roles: ["review"] }) }), "first");
    expect(where(base({ peers: [a, mk("b", 3)], local: { running: 9, room: false } }), "write")).toBe("b");
    expect(where(base({ peers: [tier(mk("a"), "first")], locksFree: false }), "write")).toBe("local");
    expect(where(base({ peers: [tier(mk("a", 0, { roles: ["review"] }), "first")] }), "write")).toBe("local");
    expect(where(base({ remote: REVIEW, peers: [tier(mk("a"), "first")] }), "write")).toBe("local");
    expect(where(base({ peers: [tier(mk("a"), "first")], repo: null }), "write")).toBe("local");
  });

  test("reviewFirst keeps its order for reviews and beats a first-tier peer; writes ignore it", () => {
    const f = base({ remote: { ...WRITE, reviewFirst: ["b"] }, peers: [tier(mk("a"), "first"), mk("b", 5)] });
    expect(where(f)).toBe("b");
    expect(where(f, "write")).toBe("a");
  });
});

describe("writing families and the write lease", () => {
  test("the lender's codex first, claude when codex is full; neither = not a candidate", () => {
    expect(placeFor(base({ peers: [mk("a")], local: { running: 9, room: true } }), "write", "claude")).toMatchObject({ peer: "a", family: "codex" });
    const claudeOnly = mk("a", 0, { v2: grant({ slots: { codex: 0, claude: 1 } }) });
    expect(placeFor(base({ peers: [claudeOnly], local: { running: 9, room: true } }), "write", "claude")).toMatchObject({ peer: "a", family: "claude" });
    expect(placeFor(base({ peers: [mk("a", 0, { v2: FULL })] }), "write", "claude")).toMatchObject({ kind: "local" });
  });

  test("review keeps the family asked for (across from the head's writer)", () => {
    const codexOnly = mk("a", 0, { v2: grant({ slots: { codex: 2, claude: 0 } }) });
    expect(placeFor(base({ peers: [codexOnly], local: { running: 9, room: true } }), "review", "codex")).toMatchObject({ peer: "a", family: "codex" });
    expect(placeFor(base({ peers: [codexOnly], local: { running: 9, room: true } }), "review", "claude")).toMatchObject({ kind: "local" });
  });

  test("a fix goes back to the lease holder only; when it cannot take it the card waits (lend-reclaim to move)", () => {
    const f = base({ writeLeasePeer: "b", peers: [tier(mk("a"), "first"), mk("b", 4)] });
    expect(placeFor(f, "fix", "claude")).toMatchObject({ kind: "peer", peer: "b", reason: "写租约在 b，修复单派回它" });
    const busy = { ...f, peers: [tier(mk("a"), "first"), mk("b", 4, { v2: FULL })] };
    expect(placeFor(busy, "fix", "claude")).toEqual({ kind: "wait", reason: expect.stringContaining("写租约在 b，修复单只派回它；它现在不能接") });
    expect(placeFor({ ...f, tried: ["b"] }, "fix", "claude")).toMatchObject({ kind: "wait" });
  });

  test("no lease: a fix never goes to a peer (it could not push the card's branch)", () => {
    expect(placeFor(base({ peers: [tier(mk("a"), "first")] }), "fix", "claude")).toMatchObject({ kind: "local" });
  });

  test("a project without write: a held lease changes nothing (fix stays local as before)", () => {
    expect(placeFor(base({ remote: REVIEW, writeLeasePeer: "a" }), "fix", "claude")).toMatchObject({ kind: "local" });
  });
});
