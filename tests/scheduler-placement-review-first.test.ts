/**
 * i28-W5c remote.reviewFirst in placeFor, table-driven: absent / [] leaves every placement and reason untouched; a listed
 * peer that can take the review gets it whatever its load, and one that cannot (full, no hello, no grant, tried, not
 * borrowed) falls back to the even spread with its reason; write / fix / pins and the planner's security and
 * independence rules are unchanged.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { explainPlacement } from "../src/lib/scheduler-placement-plan.js";
import { placeFor, type PeerFacts, type PlacementFacts, type PlaceRole } from "../src/lib/scheduler-placement.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";

type Family = "codex" | "claude";
const BASE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const WRITE = { ...BASE, roles: ["review", "write"] } as unknown as RemotePolicy;
const first = (names: string[], remote: RemotePolicy = BASE): RemotePolicy => ({ ...remote, reviewFirst: names });
const grant = (over: Partial<NonNullable<PeerFacts["v2"]>> = {}): PeerFacts["v2"] =>
  ({ why: null, slots: { codex: 2, claude: 2 }, roles: ["review", "write"], repos: ["O/R"], ...over });
const mk = (peer: string, open = 0, over: Partial<PeerFacts> = {}): PeerFacts => ({ peer, roles: ["review", "write"], open, v2: grant(), ...over });
const base = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
  remote: BASE, peers: [mk("a"), mk("b")], repo: "o/r", local: { running: 0, room: true }, pin: null, tried: [],
  lastPeer: null, writeLeasePeer: null, locksFree: true, ...over,
});

/** Every situation the W5 placement tests cover, as [name, facts, role, family]. */
const SCENES: [string, PlacementFacts, PlaceRole, Family][] = [
  ["idle peers", base(), "review", "codex"],
  ["loaded local", base({ local: { running: 3, room: true }, peers: [mk("a", 1), mk("b", 2)] }), "review", "codex"],
  ["re-review tie", base({ lastPeer: "b" }), "review", "codex"],
  ["re-review beaten by load", base({ lastPeer: "b", peers: [mk("a"), mk("b", 1)] }), "review", "codex"],
  ["peer named local", base({ peers: [mk("local")], local: { running: 5, room: true } }), "review", "codex"],
  ["full peer", base({ peers: [mk("a", 1, { v2: grant({ slots: { codex: 0, claude: 0 } }) })] }), "review", "codex"],
  ["offline peer, local full", base({ peers: [mk("a", 0, { v2: grant({ why: "hello 超过 90 秒没更新" }) })], local: { running: 9, room: false } }), "review", "codex"],
  ["proto 1", base({ peers: [mk("a", 0, { v2: null })] }), "review", "codex"],
  ["local full, busy peer", base({ local: { running: 2, room: false }, peers: [mk("a", 5)] }), "review", "codex"],
  ["remote off", base({ remote: { ...BASE, mode: "off" } }), "review", "codex"],
  ["no remote.roles", base({ remote: { ...BASE, roles: [] }, local: { running: 9, room: false } }), "review", "codex"],
  ["no repo", base({ repo: null }), "review", "codex"],
  ["claude reviewer", base({ peers: [mk("a", 0, { v2: grant({ slots: { codex: 0, claude: 1 } }) })] }), "review", "claude"],
  ["all tried", base({ tried: ["a", "b"], local: { running: 9, room: false } }), "review", "codex"],
  ["one tried", base({ tried: ["a"] }), "review", "codex"],
  ["write before W8", base({ local: { running: 9, room: false } }), "write", "claude"],
  ["fix to lease", base({ remote: WRITE, writeLeasePeer: "b" }), "fix", "claude"],
  ["write, locks held", base({ remote: WRITE, locksFree: false }), "write", "claude"],
  ["pinned write waits", base({ pin: "peer:a", remote: WRITE, peers: [mk("a", 0, { v2: grant({ why: "对方的授权已到期" }) }), mk("b")] }), "write", "claude"],
  ["pinned write goes", base({ pin: "peer:b", remote: WRITE }), "write", "claude"],
  ["pinned card's review", base({ pin: "peer:a", peers: [mk("a", 3), mk("b")] }), "review", "codex"],
];

const withFirst = (f: PlacementFacts, names: string[]): PlacementFacts => ({ ...f, remote: f.remote && first(names, f.remote) });

describe("absent or empty reviewFirst: placement and reason unchanged", () => {
  for (const [name, f, role, family] of SCENES) {
    test(name, () => expect(placeFor(withFirst(f, []), role, family)).toEqual(placeFor(f, role, family)));
  }
});

describe("reviewFirst [a]", () => {
  test("a can take it: a, even when it runs more than this machine and b", () => {
    const f = base({ remote: first(["a"]), peers: [mk("a", 5), mk("b", 0)], local: { running: 0, room: true } });
    expect(placeFor(f, "review", "codex")).toEqual({ kind: "peer", peer: "a", reason: "scheduler.json remote.reviewFirst 指定先给 a" });
    expect(placeFor({ ...f, local: { running: 9, room: false } }, "review", "codex")).toMatchObject({ kind: "peer", peer: "a" });
  });

  test("the first one that can take it, in list order", () => {
    const full = mk("a", 0, { v2: grant({ slots: { codex: 0, claude: 2 } }) });
    expect(placeFor(base({ remote: first(["b", "a"]) }), "review", "codex")).toMatchObject({ peer: "b" });
    expect(placeFor(base({ remote: first(["a", "b"]), peers: [full, mk("b", 4)] }), "review", "codex"))
      .toEqual({ kind: "peer", peer: "b", reason: "scheduler.json remote.reviewFirst 指定先给 b" });
  });

  const cannot: [string, Partial<PlacementFacts>, string][] = [
    ["full", { peers: [mk("a", 0, { v2: grant({ slots: { codex: 0, claude: 2 } }) }), mk("b", 3)] }, "a：对方没有空闲的 codex 槽"],
    ["no hello", { peers: [mk("a", 0, { v2: null }), mk("b", 3)] }, "a：没有 hello"],
    ["offline", { peers: [mk("a", 0, { v2: grant({ why: "hello 超过 90 秒没更新" }) }), mk("b", 3)] }, "a：hello 超过 90 秒没更新"],
    ["grant without review", { peers: [mk("a", 0, { v2: grant({ roles: ["write"] }) }), mk("b", 3)] }, "a：对方授权不含 review"],
    ["already tried", { tried: ["a"], peers: [mk("a"), mk("b", 3)] }, "a：本轮已试过"],
    ["not borrowed", { peers: [mk("b", 3)] }, "a：不在借入名单里"],
  ];
  for (const [name, over, why] of cannot) {
    test(`${name}: the even spread decides, and the reason says why a could not`, () => {
      const f = base({ local: { running: 1, room: true }, ...over });
      const placed = placeFor({ ...f, remote: first(["a"]) }, "review", "codex");
      const spread = placeFor(f, "review", "codex");
      expect(placed).toEqual({ ...spread, reason: expect.stringMatching(new RegExp(`^reviewFirst 里的 peer 都不能接（${why}`)) });
      expect(placed.reason.endsWith(`）；${spread.reason}`)).toBe(true);
    });
  }

  test("nobody can take it and this machine is full: queues locally, naming every listed peer", () => {
    const f = base({ remote: first(["a", "zz"]), peers: [mk("a", 0, { v2: grant({ slots: { codex: 0, claude: 0 } }) })], local: { running: 9, room: false } });
    expect(placeFor(f, "review", "codex")).toEqual({ kind: "local",
      reason: "reviewFirst 里的 peer 都不能接（a：对方没有空闲的 codex 槽；zz：不在借入名单里（或借入不含本项目））；本机满且没有可用的 peer：本机照常排队" });
  });

  test("remote off and remote.roles without review still win", () => {
    expect(placeFor(base({ remote: { ...first(["a"]), mode: "off" } }), "review", "codex")).toEqual({ kind: "local", reason: "scheduler.json remote.mode = off，只用本机" });
    expect(placeFor(base({ remote: { ...first(["a"]), roles: [] } }), "review", "codex")).toMatchObject({ kind: "local", reason: expect.stringContaining("remote.roles 不含 review") });
  });

  test("write, fix and pinned writing ignore it", () => {
    for (const [name, f, role, family] of SCENES.filter(([, , role]) => role !== "review")) {
      expect([name, placeFor(withFirst(f, ["a", "b"]), role, family)]).toEqual([name, placeFor(f, role, family)]);
    }
  });
});

describe("the planner keeps its own gates", () => {
  const author: WorkerRef = { agent: "w", sessionId: "s-w", taskId: "T1", family: "claude", source: "local" };
  const peers = [{ peer: "mate", open: 4, maxOpen: 9, roles: ["review" as const], v2: { why: null, slots: { codex: 1, claude: 1 }, roles: ["review" as const], repos: ["o/r"] } }];
  const reviewSnap = (template: "code" | "security", reviewer: WorkerRef | null = null, pool: Partial<PoolFacts> = {}): PlannerSnapshot => {
    const task = { id: "T1", project: "p", kind: "code", stage: "review", round: 1, agent: "w", assignee: "w", assigneeKind: "agent", pm: "pm",
      pr: "https://github.com/o/r/pull/7", headSHA: "f".repeat(40), specRev: 1, rev: 1, extra: {}, createdAt: 1, updatedAt: 1 } as unknown as LedgerTask;
    const e = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>) => ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "", dedupKey: null });
    return { task, author, reviewer, events: [e(1, "task", { op: "new" }), e(9, "stage", { from: "build", to: "review", round: 1, specRev: 1 })],
      workflow: { taskId: "T1", project: "p", template, templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 },
      intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0",
      reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
      pool: { remote: first(["mate"]), localReviewers: 0, repo: "o/r", lastPeer: null, peers, ...pool } };
  };

  test("a code card's review goes to the listed peer over an idle local machine", () => {
    expect(planScheduler(reviewSnap("code"))).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate",
      reason: "挂池：对抗式跨模型审查挂给 mate 的 codex worker（scheduler.json remote.reviewFirst 指定先给 mate）" });
  });

  test("a proto-1 listed peer with this machine full: R9 may still pool it, and the reason carries both causes", () => {
    const s = reviewSnap("code", null, { remote: first(["old"]), localReviewers: 2, peers: [{ peer: "old", open: 0, maxOpen: 1 }] });
    const reason = "挂池：对抗式跨模型审查挂给 old 的 codex worker（reviewFirst 里的 peer 都不能接（old：没有 hello（proto 1，只按老规则在本机满时接审查））；"
      + "本机满且没有可用的 peer：本机照常排队）";
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review", recipient: "peer:old", reason });
    expect(explainPlacement(s)).toEqual({ role: "review", where: "peer:old", reason });
    expect(planScheduler({ ...s, pool: { ...s.pool!, remote: BASE } })).toMatchObject({ recipient: "peer:old", reason: "挂池：对抗式跨模型审查挂给 old 的 codex worker" });
  });

  test("a security card stays local; a same-family or non-local reviewer is still escalated", () => {
    expect(planScheduler(reviewSnap("security"))).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer" });
    expect(planScheduler(reviewSnap("code", { ...author, agent: "rv", sessionId: "s-rv" }))).toMatchObject({ kind: "escalate", code: "reviewer_independence" });
    const remoteReviewer: WorkerRef = { agent: "rv", sessionId: "s-rv", taskId: "T1", family: "codex", source: "peer_claim" };
    expect(planScheduler(reviewSnap("security", remoteReviewer))).toMatchObject({ kind: "escalate", code: "reviewer_independence" });
  });
});
