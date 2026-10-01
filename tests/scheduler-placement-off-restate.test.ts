/**
 * i28-W9c: with this machine's localPriority `off` a new unpinned card gets no local author session and no restate order;
 * it waits in spec with the build stage's wording (or, when a peer could take the writing, says no peer restates).
 * first / balance / low (and no localPriority) restate locally exactly as before; remote.mode off stays local-only.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { Priority } from "../src/lib/lend-config.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { explainPlacement, remoteWork } from "../src/lib/scheduler-placement-plan.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";

const WRITE: RemotePolicy = { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, repo: "o/r" };
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "claude", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "", dedupKey: null });
const writer = (peer: string, slots = { codex: 1, claude: 1 }, priority?: Priority) => ({ peer, open: 0, maxOpen: 2, roles: ["review" as const, "write" as const],
  v2: { why: null, slots, roles: ["review" as const, "write" as const], repos: ["o/r"] }, ...(priority ? { priority } : {}) });
const pool = (remote: RemotePolicy, peers: PoolFacts["peers"] = []): PoolFacts => ({ remote, localReviewers: 0, repo: "o/r", lastPeer: null, peers });
const snap = (p: PoolFacts | null, over: Partial<PlannerSnapshot> = {}, stage: Stage = "spec"): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round: 0, agent: author.agent, assigneeKind: "agent",
    assignee: author.agent, pm: "pm", branch: "b", pr: null, headSHA: null, spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 3, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" })], intents: [], blockedBy: [], queueFrozen: false,
  fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author: null, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool: p, ...over,
});
const off = (peers: PoolFacts["peers"] = []) => pool({ ...WRITE, localPriority: "off" }, peers);
const LONELY = "scheduler.json remote.localPriority = off，又没有能接的 peer：等";

describe("localPriority off: a new card is not restated here", () => {
  test("no peer can write: waits in spec with the build stage's wording, no author session", () => {
    for (const peers of [[], [writer("mate", { codex: 0, claude: 0 })], [writer("mate", undefined, "off")]]) {
      const s = snap(off(peers));
      expect(planScheduler(s)).toEqual({ kind: "wait", code: "placement", reason: LONELY });
      expect(planScheduler({ ...s, task: { ...s.task, stage: "build" } })).toEqual({ kind: "wait", code: "placement", reason: LONELY });
    }
  });

  test("a bound author and a free slot change nothing: still no restate order", () => {
    expect(planScheduler(snap(off(), { author }))).toEqual({ kind: "wait", code: "placement", reason: LONELY });
  });

  test("this machine writes nothing when remote.roles has no write: the restate waits on the same reason", () => {
    const s = snap(pool({ ...WRITE, roles: ["review"], localPriority: "off" }, [writer("mate")]));
    expect(planScheduler(s)).toEqual({ kind: "wait", code: "placement", reason: LONELY });
  });

  test("a peer could take the writing: the restate still waits here, naming the peer and how to move on", () => {
    const decision = planScheduler(snap(off([writer("mate")])));
    expect(decision).toMatchObject({ kind: "wait", code: "placement" });
    expect((decision as { reason: string }).reason).toBe("scheduler.json remote.localPriority = off：本机不复述新卡；写单可派给 mate，" +
      "但 peer 不接复述单：等本机重新启用，或 PM 用 start_node placement=peer:mate 固定放置");
    expect(explainPlacement(snap(off([writer("mate")])))).toMatchObject({ role: "write", where: "-", reason: expect.stringContaining("本机不复述新卡") });
  });

  test("remote.mode off means this machine only: the restate stays local, as build would", () => {
    const s = snap(pool({ ...WRITE, mode: "off", localPriority: "off" }, [writer("mate")]));
    expect(remoteWork(s, 0, "write")).toBeNull();
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "author" });
  });
});

describe("other tiers restate locally as before", () => {
  const tiers: (Priority | undefined)[] = ["first", "balance", "low", undefined];
  for (const tier of tiers) {
    test(`localPriority ${tier ?? "(unset)"}: author session first, then the local restate order`, () => {
      const remote = { ...WRITE, ...(tier ? { localPriority: tier } : {}) };
      for (const p of [pool(remote), pool(remote, [writer("mate")])]) {
        expect(remoteWork(snap(p), 0, "write")).toBeNull();
        expect(planScheduler(snap(p))).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "author" });
        expect(planScheduler(snap(p, { author }))).toMatchObject({ kind: "intent", action: "dispatch", node: "restate", recipient: author.agent });
      }
    });
  }

  test("balance with a usable writer: build goes to the peer, the restate still stays local", () => {
    const p = pool({ ...WRITE, localPriority: "balance" }, [writer("mate")]);
    expect(planScheduler(snap(p, { author }, "build"))).toMatchObject({ kind: "intent", action: "dispatch", recipient: "peer:mate" });
    expect(planScheduler(snap(p, { author }))).toMatchObject({ kind: "intent", action: "dispatch", node: "restate", recipient: author.agent });
  });

  test("no pool facts at all: local as before", () => {
    expect(planScheduler(snap(null, { author }))).toMatchObject({ kind: "intent", action: "dispatch", node: "restate", recipient: author.agent });
  });
});
