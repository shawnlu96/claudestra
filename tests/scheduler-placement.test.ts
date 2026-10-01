/**
 * i28-W5 placeFor, pure and table-driven: even spread over this machine + usable peers (fewest running, ties to peers),
 * full / offline / expired / revoked peers → local and never stuck, every hard constraint (borrow, remote.roles, grant
 * roles and repos, family slots, file locks, no writing before W8), pins that wait instead of moving, one try per peer.
 */
import { describe, expect, test } from "bun:test";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { peerRefusal, placeFor, type PeerFacts, type PlacementFacts } from "../src/lib/scheduler-placement.js";

const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
/** A config W8 has not made possible yet; only for checking the write-side constraints behind remote.roles. */
const WRITE_REMOTE = { ...REMOTE, roles: ["review", "write"] } as unknown as RemotePolicy;
const v2 = (over: Partial<NonNullable<PeerFacts["v2"]>> = {}): PeerFacts["v2"] =>
  ({ why: null, slots: { codex: 2, claude: 2 }, roles: ["review", "write"], repos: ["O/R"], ...over });
const peer = (name: string, open = 0, over: Partial<PeerFacts> = {}): PeerFacts => ({ peer: name, roles: ["review", "write"], open, v2: v2(), ...over });
const facts = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  remote: REMOTE, peers: [peer("a"), peer("b")], repo: "o/r", local: { running: 0, room: true }, pin: null, tried: [],
  lastPeer: null, writeLeasePeer: null, locksFree: true, ...over,
});
const where = (f: PlacementFacts, role: "review" | "write" | "fix" = "review", family: "codex" | "claude" = "codex") => {
  const p = placeFor(f, role, family);
  return p.kind === "peer" ? p.peer : p.kind;
};

/** Places `n` orders one after another, each raising the running count where it went. */
function spread(f: PlacementFacts, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = where(f);
    out.push(w);
    if (w === "local") f.local = { ...f.local, running: f.local.running + 1 };
    else f.peers = f.peers.map((p) => (p.peer === w ? { ...p, open: p.open + 1 } : p));
  }
  return out;
}

describe("even spread", () => {
  test("local + two usable peers at zero: three reviews go one per machine, peers first", () => {
    expect(spread(facts(), 3)).toEqual(["a", "b", "local"]);
  });

  test("keeps choosing the machine with the fewest running orders", () => {
    const f = facts({ local: { running: 3, room: true }, peers: [peer("a", 1), peer("b", 2)] });
    const loads = () => ({ local: f.local.running, a: f.peers[0].open, b: f.peers[1].open });
    for (let i = 0; i < 12; i++) {
      const before = loads();
      const w = spread(f, 1)[0] as keyof ReturnType<typeof loads>;
      expect(before[w]).toBe(Math.min(...Object.values(before)));
    }
    expect(loads()).toEqual({ local: 6, a: 6, b: 6 });
  });

  test("ties: a peer before this machine, borrow order between peers, re-review back to the last peer, fix to the lease holder", () => {
    expect(where(facts({ peers: [peer("a")] }))).toBe("a");
    expect(where(facts({ peers: [peer("b"), peer("a")] }))).toBe("b");
    expect(where(facts({ lastPeer: "b" }))).toBe("b");
    expect(where(facts({ lastPeer: "b", peers: [peer("a"), peer("b", 1)] }))).toBe("a");
    const write = facts({ remote: WRITE_REMOTE, writeLeasePeer: "b" });
    expect(where(write, "fix", "claude")).toBe("b");
    expect(where(write, "write", "claude")).toBe("a");
    expect(placeFor(facts(), "review", "codex")).toMatchObject({ kind: "peer", reason: expect.stringContaining("本机 0") });
  });

  test("a peer named local is still a peer: this machine is a flag, never the name", () => {
    const named = facts({ peers: [peer("local")], local: { running: 5, room: true } });
    expect(placeFor(named, "review", "codex")).toMatchObject({ kind: "peer", peer: "local", reason: expect.stringContaining("在跑：local 0 / 本机 5") });
    expect(placeFor({ ...named, local: { running: 5, room: false } }, "review", "codex")).toMatchObject({ kind: "peer", peer: "local" });
    expect(placeFor({ ...named, peers: [peer("local", 5)], local: { running: 5, room: true } }, "review", "codex")).toMatchObject({ kind: "peer", peer: "local" });
    expect(placeFor({ ...named, peers: [peer("local", 6)], lastPeer: "local" }, "review", "codex")).toMatchObject({ kind: "local" });
  });
});

describe("full, offline, expired, revoked → local, never stuck", () => {
  const unusable: [string, PeerFacts][] = [
    ["full", peer("a", 1, { v2: v2({ slots: { codex: 0, claude: 0 } }) })],
    ["offline", peer("a", 0, { v2: v2({ why: "hello 超过 90 秒没更新" }) })],
    ["expired", peer("a", 0, { v2: v2({ why: "对方的授权已到期" }) })],
    ["revoked", peer("a", 0, { v2: v2({ why: "对方没有授权（或已收回）" }) })],
    ["out of orders today", peer("a", 0, { v2: v2({ why: "对方今天的单数用完了" }) })],
    ["proto 1", peer("a", 0, { v2: null })],
  ];
  for (const [name, p] of unusable) {
    test(name, () => {
      expect(placeFor(facts({ peers: [p] }), "review", "codex")).toMatchObject({ kind: "local" });
      expect(placeFor(facts({ peers: [p], local: { running: 9, room: false } }), "review", "codex"))
        .toEqual({ kind: "local", reason: "本机满且没有可用的 peer：本机照常排队" });
    });
  }

  test("with this machine full, a usable peer takes it whatever its load", () => {
    expect(where(facts({ local: { running: 2, room: false }, peers: [peer("a", 5)] }))).toBe("a");
  });

  test("remote off is the master switch: local even with idle peers", () => {
    expect(where(facts({ remote: { ...REMOTE, mode: "off" }, local: { running: 9, room: false } }))).toBe("local");
    expect(where(facts({ remote: null }))).toBe("local");
  });
});

describe("hard constraints", () => {
  const refused: [string, Partial<PlacementFacts>, string][] = [
    ["borrow does not allow review", { peers: [peer("a", 0, { roles: ["write"] })] }, "借入名单"],
    ["remote.roles without review", { remote: { ...REMOTE, roles: [] } }, "remote.roles"],
    ["grant roles without review", { peers: [peer("a", 0, { v2: v2({ roles: ["write"] }) })] }, "授权不含 review"],
    ["grant repos without the card's repo", { peers: [peer("a", 0, { v2: v2({ repos: ["o/other"] }) })] }, "仓库不含"],
    ["no repo on the card", { repo: null, peers: [peer("a")] }, "仓库坐标"],
    ["no free slot in the reviewer's family", { peers: [peer("a", 0, { v2: v2({ slots: { codex: 0, claude: 3 } }) })] }, "codex 槽"],
  ];
  for (const [name, over, why] of refused) {
    test(name, () => {
      const f = facts({ local: { running: 9, room: false }, ...over });
      expect(placeFor(f, "review", "codex").kind).toBe("local");
      expect(peerRefusal(f, f.peers[0], "review", "codex")).toContain(why);
    });
  }

  test("the reviewer's family is the one that must have a slot", () => {
    const f = facts({ peers: [peer("a", 0, { v2: v2({ slots: { codex: 0, claude: 1 } }) })], local: { running: 9, room: false } });
    expect(where(f, "review", "claude")).toBe("a");
    expect(where(f, "review", "codex")).toBe("local");
  });

  test("before W8 no writing or fixing ever goes to a peer, whatever the grant says", () => {
    for (const role of ["write", "fix"] as const) {
      expect(where(facts({ local: { running: 9, room: false } }), role, "claude")).toBe("local");
      expect(peerRefusal(facts(), peer("a"), role, "claude")).toContain("remote.roles 不含 write");
    }
  });

  test("remote writing needs the card's file locks; review does not", () => {
    const f = facts({ remote: WRITE_REMOTE, locksFree: false, local: { running: 9, room: false } });
    expect(where(f, "write", "claude")).toBe("local");
    expect(peerRefusal(f, f.peers[0], "write", "claude")).toContain("文件锁");
    expect(where(f, "review", "codex")).toBe("a");
  });
});

describe("pins and tries", () => {
  test("a pin to a peer that cannot take it waits with the reason, never moves to another peer or local", () => {
    const f = facts({ pin: "peer:a", peers: [peer("a", 0, { v2: v2({ why: "对方的授权已到期" }) }), peer("b")] });
    expect(placeFor(f, "write", "claude")).toEqual({ kind: "wait", reason: "固定放在 peer:a，它现在不能接：scheduler.json remote.roles 不含 write" });
    expect(placeFor({ ...f, remote: WRITE_REMOTE }, "write", "claude")).toEqual({ kind: "wait", reason: "固定放在 peer:a，它现在不能接：对方的授权已到期" });
    expect(placeFor({ ...f, remote: WRITE_REMOTE, pin: "peer:zz" }, "fix", "claude")).toMatchObject({ kind: "wait", reason: expect.stringContaining("借入名单") });
    expect(placeFor({ ...f, remote: WRITE_REMOTE, pin: "peer:b" }, "write", "claude")).toMatchObject({ kind: "peer", peer: "b" });
  });

  test("the pin governs writing only: the card's review is balanced like any other", () => {
    expect(where(facts({ pin: "peer:a", peers: [peer("a", 3), peer("b", 0)] }), "review", "codex")).toBe("b");
  });

  test("each peer is tried once per round and head, then the next, then local", () => {
    expect(where(facts({ tried: ["a"] }))).toBe("b");
    expect(where(facts({ tried: ["a", "b"], local: { running: 9, room: false } }))).toBe("local");
  });
});
