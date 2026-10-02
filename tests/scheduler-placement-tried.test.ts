import { expect, test } from "bun:test";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { planScheduler, type PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { placementHistory } from "../src/lib/scheduler-placement-tried.js";

const HEAD = "c".repeat(40), REFUSED = 10_000;
function event(seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>, text = ""): LedgerEvent {
  return { seq, kind, data, text, ts: REFUSED, actor: "scheduler", project: "p", target: "T1", dedupKey: null };
}
function refusal(s: PlannerSnapshot, peer: string, code: string, id = `i-${peer}`) {
  const orderId = `order-${id}`;
  s.intents = [...s.intents, { id, taskId: "T1", project: "p", node: s.task.stage === "review" ? "adversarial_review" : "build",
    action: s.task.stage === "review" ? "review" : "dispatch", recipient: `peer:${peer}`, causalSeq: 10, eventSeq: 11,
    taskRev: 1, specRev: 1, head: s.task.headSHA, templateVersion: 2, status: "cancelled", attempts: 1,
    receipt: null, reason: "settled", createdAt: 100, updatedAt: REFUSED + 1000 } as SchedulerIntent];
  s.events = [...s.events, { ...event(12, "scheduler", { id, peer, orderId, op: "pool_offer" }), dedupKey: `scheduler:${id}:pool` },
    event(13, "note", { lend: { peer, orderId, op: "cancel", from: "pooled" } }, `出借：撤单（原状态 pooled）：推送被 ${peer} 拒收（${code}）`)];
}
function snapshot(stage: "review" | "build" = "review"): PlannerSnapshot {
  return {
    task: { id: "T1", project: "p", kind: "code", stage, round: 1, headSHA: stage === "build" ? null : HEAD, specRev: 1, extra: {} } as LedgerTask,
    workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "codex", fallback: "x",
      specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 },
    events: [event(1, "task", { op: "new" }), event(10, "stage", { to: stage, round: 1 })], intents: [], blockedBy: [], queueFrozen: false,
    fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author: null, reviewer: null,
    reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
    pool: { now: REFUSED + 120_000, remote: { mode: "balance", roles: ["review", "write"], poolTimeoutMin: 15, writeFamilies: ["claude"] },
      repo: "o/r", lastPeer: null, localReviewers: 0, peers: [{ peer: "mate", helloAt: REFUSED + 1, open: 0, maxOpen: 2, roles: ["review", "write"],
        v2: { why: null, slots: { claude: 2, codex: 0 }, roles: ["review", "write"], repos: ["o/r"] } }] },
  };
}
const wait = { kind: "wait", code: "placement", reason: expect.stringContaining("等 mate 空位") };

for (const stage of ["review", "build"] as const) {
  for (const code of ["no_slot", "paused", "daily", "lender_idle"]) test(`${stage}: ${code} retries only after two minutes AND a new hello`, () => {
    const s = snapshot(stage);
    refusal(s, "mate", code);
    s.pool!.now!--;
    expect(planScheduler(s)).toMatchObject(wait);
    s.pool!.now!++;
    s.pool!.peers[0].helloAt = REFUSED;
    expect(planScheduler(s)).toMatchObject(wait);
    s.pool!.peers[0].helloAt = REFUSED + 1;
    expect(planScheduler(s)).toMatchObject({ kind: "intent", recipient: "peer:mate", action: stage === "review" ? "review" : "dispatch" });
  });
  for (const code of ["no_grant", "family", "role", "write_closed", "repo", "closed", "id_conflict", "unknown"]) {
    test(`${stage}: permanent ${code} is spent even with fresh capacity`, () => {
      const s = snapshot(stage);
      refusal(s, "mate", code);
      expect(placementHistory(s, 10)).toEqual({ tried: ["mate"], retries: [] });
      expect(planScheduler(s)).toMatchObject({ action: "ensure_session" });
    });
  }
}

test("old snapshots retain the previous tried behavior", () => {
  for (const missing of ["now", "helloAt"] as const) {
    const s = snapshot();
    refusal(s, "mate", "no_slot");
    if (missing === "now") delete s.pool!.now;
    else delete s.pool!.peers[0].helloAt;
    expect(placementHistory(s, 10)).toEqual({ tried: ["mate"], retries: [] });
  }
});

test("claimed, returned, timeout, unrelated note, and live intents cannot turn into retries", () => {
  for (const outcome of ["claim", "released", "claimed_cancel", "timeout", "unlinked", "pending", "submitted", "done", "unknown"]) {
    const s = snapshot();
    refusal(s, "mate", "no_slot");
    const cancel = s.events.at(-1)!;
    if (outcome === "claim") s.events = [...s.events, event(14, "note", { lend: { orderId: "order-i-mate", op: "claim" } })];
    else if (outcome === "released") (cancel.data.lend as Record<string, unknown>).op = "release";
    else if (outcome === "claimed_cancel") (cancel.data.lend as Record<string, unknown>).from = "claimed";
    else if (outcome === "timeout") cancel.text = "出借：撤单（原状态 pooled）：挂池超时";
    else if (outcome === "unlinked") s.events[2].dedupKey = "other";
    else s.intents[0].status = outcome as SchedulerIntent["status"];
    expect(placementHistory(s, 10)).toEqual({ tried: ["mate"], retries: [] });
  }
});

test("latest refusal restarts delay; a permanent attempt dominates; previous stage/head do not count", () => {
  const s = snapshot();
  refusal(s, "mate", "no_slot");
  refusal(s, "mate", "paused", "second");
  s.events.at(-1)!.ts = s.pool!.now! - 1;
  expect(planScheduler(s)).toMatchObject(wait);
  refusal(s, "mate", "repo", "third");
  expect(placementHistory(s, 10)).toEqual({ tried: ["mate"], retries: [] });
  expect(placementHistory(s, 11)).toEqual({ tried: [], retries: [] });
  s.task.headSHA = "d".repeat(40);
  expect(placementHistory(s, 10)).toEqual({ tried: [], retries: [] });
});

test("all temporarily refused peers wait despite local capacity; a different eligible peer can take the card", () => {
  const s = snapshot();
  s.pool!.peers = [...s.pool!.peers, { ...s.pool!.peers[0], peer: "other" }];
  refusal(s, "mate", "no_slot");
  s.pool!.now = REFUSED + 1;
  expect(planScheduler(s)).toMatchObject({ recipient: "peer:other" });
  refusal(s, "other", "daily");
  expect(planScheduler(s)).toMatchObject(wait);
  expect(planScheduler(s).reason).toContain("等 other 空位");
});

test("capacity, grants and family checks still gate a retry after debounce", () => {
  for (const blocked of ["slots", "why", "repo", "role", "off"] as const) {
    const s = snapshot();
    refusal(s, "mate", "no_slot");
    const p = s.pool!.peers[0];
    if (blocked === "slots") p.v2!.slots = { claude: 0, codex: 2 };
    if (blocked === "why") p.v2!.why = "daily / paused / stale";
    if (blocked === "repo") p.v2!.repos = [];
    if (blocked === "role") p.v2!.roles = [];
    if (blocked === "off") p.priority = "off";
    expect(planScheduler(s)).toMatchObject(wait);
  }
});

test("pinned writing also observes the retry delay; disabled remote stays local", () => {
  const s = snapshot("build");
  refusal(s, "mate", "no_slot");
  s.task.extra.placement = "peer:mate";
  s.pool!.now = REFUSED + 1;
  expect(planScheduler(s)).toMatchObject({ ...wait, code: "placement_pinned" });
  s.pool!.now = REFUSED + 120_000;
  s.pool!.peers[0].helloAt = REFUSED;
  expect(planScheduler(s)).toMatchObject({ ...wait, code: "placement_pinned" });
  s.pool!.peers[0].helloAt = REFUSED + 1;
  expect(planScheduler(s)).toMatchObject({ recipient: "peer:mate" });
  delete s.task.extra.placement;
  s.pool!.remote.mode = "off";
  expect(planScheduler(s)).toMatchObject({ action: "ensure_session" });
});
