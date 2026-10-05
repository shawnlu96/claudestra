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
  const seq = Math.max(...s.events.map((e) => e.seq)) + 1;
  s.intents = [...s.intents, { id, taskId: "T1", project: "p", node: s.task.stage === "review" ? "adversarial_review" : "build",
    action: s.task.stage === "review" ? "review" : "dispatch", recipient: `peer:${peer}`, causalSeq: 10, eventSeq: seq,
    taskRev: 1, specRev: 1, head: s.task.headSHA, templateVersion: 2, status: "cancelled", attempts: 1,
    receipt: null, reason: "settled", createdAt: 100, updatedAt: REFUSED + 1000 } as SchedulerIntent];
  s.events = [...s.events, { ...event(seq + 1, "scheduler", { id, peer, orderId, op: "pool_offer" }), dedupKey: `scheduler:${id}:pool` },
    event(seq + 2, "note", { lend: { peer, orderId, op: "cancel", from: "pooled" } }, `出借：撤单（原状态 pooled）：推送被 ${peer} 拒收（${code}）`)];
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
        v2: { why: null, slots: { claude: 2, codex: 0 }, familyTotals: { claude: 2, codex: 0 }, roles: ["review", "write"], repos: ["o/r"] } }] },
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

test("latest refusal restarts delay; a later permanent attempt clears the gate; previous stage/head do not count", () => {
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

test("capacity waits exclude spent peers even when their latest outcome was temporary", () => {
  const s = snapshot();
  s.pool!.peers = [...s.pool!.peers, { ...s.pool!.peers[0], peer: "other" }];
  refusal(s, "mate", "repo", "spent");
  refusal(s, "mate", "no_slot");
  refusal(s, "other", "no_slot");
  s.pool!.now = REFUSED + 1;
  expect(planScheduler(s)).toMatchObject({ kind: "wait", reason: expect.stringContaining("等 other 空位") });
  expect(planScheduler(s).reason).not.toContain("等 mate 空位");
});

for (const stage of ["review", "build"] as const) test(`${stage}: capacity waits include the current refusal verbatim`, () => {
  for (const why of [null, "对方今天的单数用完了", "hello 超过 180 秒没更新"]) {
    const s = snapshot(stage);
    refusal(s, "mate", "no_slot");
    const p = s.pool!.peers[0];
    p.v2!.slots = { claude: 0, codex: 2 };
    p.v2!.why = why;
    expect(planScheduler(s)).toMatchObject(wait);
    expect(planScheduler(s).reason).toContain(why ?? (stage === "review" ? "对方没有空闲的 claude 槽" : "对方没有空闲的写代码槽（codex / claude）"));
    s.pool!.now = REFUSED + 1;
    expect(planScheduler(s).reason).toContain("至少等 2 分钟");
    if (why) expect(planScheduler(s).reason).toContain(why);
  }
});

for (const stage of ["review", "build"] as const) test(`${stage}: revoked policies follow the normal fallback, even during debounce`, () => {
  for (const blocked of ["repo", "role", "borrow", "off", "removed", "grant", "expired", "family", "unknown"] as const) {
    for (const elapsed of [1, 120_000]) {
      const s = snapshot(stage);
      refusal(s, "mate", "no_slot");
      s.pool!.now = REFUSED + elapsed;
      const p = s.pool!.peers[0];
      p.v2!.why = "hello 超过 180 秒没更新";
      if (blocked === "repo") p.v2!.repos = [];
      if (blocked === "role") p.v2!.roles = [];
      if (blocked === "borrow") p.roles = [stage === "review" ? "write" : "review"];
      if (blocked === "off") p.priority = "off";
      if (blocked === "removed") s.pool!.peers = [];
      if (blocked === "grant") p.v2!.why = "对方没有授权（或已收回）";
      if (blocked === "expired") p.v2!.why = "对方的授权已到期";
      if (blocked === "family") p.v2!.familyTotals = { claude: 0, codex: 2 };
      if (blocked === "unknown") p.v2!.why = "未知拒绝原因";
      expect(planScheduler(s)).toMatchObject({ action: "ensure_session" });
    }
  }
});

test("old snapshots without familyTotals keep treating zero free family slots as a capacity wait", () => {
  for (const stage of ["review", "build"] as const) {
    const s = snapshot(stage);
    refusal(s, "mate", "no_slot");
    const p = s.pool!.peers[0];
    p.v2!.slots = { claude: 0, codex: 2 };
    delete p.v2!.familyTotals;
    expect(planScheduler(s)).toMatchObject(wait);
    p.v2!.familyTotals = { claude: 0, codex: 2 };
    expect(planScheduler(s)).toMatchObject({ action: "ensure_session" });
  }
});

test("ADV-5: writing waits for file locks, not capacity, with or without a pin or debounce", () => {
  for (const pinned of [false, true]) for (const elapsed of [1, 120_000]) {
    const s = snapshot("build");
    refusal(s, "mate", "no_slot");
    if (pinned) s.task.extra.placement = "peer:mate";
    s.pool!.now = REFUSED + elapsed;
    s.heldResources = [{ taskId: "other", resource: "src/lib/x.ts" }];
    expect(planScheduler(s)).toMatchObject({ kind: "wait", reason: expect.stringContaining("文件锁") });
    expect(planScheduler(s).reason).not.toContain("等 mate 空位");
  }
});

for (const prior of ["timeout", "claimed_return"]) test(`pinned ${prior} then no_slot keeps gate; unpinned spent peer does not wait`, () => {
  const s = snapshot("build");
  refusal(s, "mate", "no_slot", "prior");
  if (prior === "timeout") s.events.at(-1)!.text = "出借：撤单（原状态 pooled）：挂池超时";
  else s.events = [...s.events, event(15, "note", { lend: { op: "claim", orderId: "order-prior" } })];
  refusal(s, "mate", "no_slot", "latest");
  s.intents = [...s.intents].reverse(); // Latest is determined by ledger sequence, not snapshot array order.
  s.pool!.now = REFUSED + 1;
  expect(placementHistory(s, 10)).toMatchObject({ tried: ["mate"], retries: [{ peer: "mate", gate: expect.stringContaining("2 分钟") }] });
  expect(planScheduler(s)).toMatchObject({ action: "ensure_session" });
  s.task.extra.placement = "peer:mate";
  expect(planScheduler(s)).toMatchObject({ ...wait, code: "placement_pinned" });
  s.pool!.now = REFUSED + 120_000;
  s.pool!.peers[0].helloAt = REFUSED;
  expect(planScheduler(s)).toMatchObject({ kind: "wait", reason: expect.stringContaining("新 hello") });
  s.pool!.peers[0].helloAt = REFUSED + 1;
  expect(planScheduler(s)).toMatchObject({ recipient: "peer:mate" });
  refusal(s, "mate", "repo", "last-permanent");
  expect(placementHistory(s, 10)).toEqual({ tried: ["mate"], retries: [] });
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

/** PC1: PM's lend-cancel of the unclaimed order (no withdrawnBy), then the scheduler's settle to cancelled. */
function pmCancel(s: PlannerSnapshot, peer: string, id = `pm-${peer}`) {
  refusal(s, peer, "no_slot", id);
  const cancel = s.events.at(-1)!;
  cancel.actor = "pm";
  cancel.data = { lend: { peer, orderId: `order-${id}`, op: "cancel", from: "pooled" } };
  cancel.text = "出借：撤单（原状态 pooled）：依赖未就绪";
  s.events[s.events.length - 2].data = { ...s.events[s.events.length - 2].data, head: s.task.headSHA, round: s.task.round };
  s.events = [...s.events, { ...event(cancel.seq + 1, "scheduler", { op: "settle", id, from: "pending", to: "cancelled", receipt: "returned" }),
    dedupKey: `scheduler:${id}:cancelled` }];
}

for (const stage of ["review", "build"] as const) test(`PC1 ${stage}: a settled PM cancel is neither spent nor a retry`, () => {
  const s = snapshot(stage);
  pmCancel(s, "mate");
  expect(placementHistory(s, 10)).toEqual({ tried: [], retries: [] });
  expect(planScheduler(s)).toMatchObject({ kind: "intent", recipient: "peer:mate", action: stage === "review" ? "review" : "dispatch" });
});

test("PC1: forged, mismatched, unsettled or live cancels keep the peer spent", () => {
  const cases: Record<string, (s: PlannerSnapshot) => void> = {
    withdrawn: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).withdrawnBy = "pm"; },
    stale: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).stale = true; },
    byScheduler: (s) => { s.events.at(-2)!.actor = "scheduler"; },
    textOnly: (s) => { s.events.at(-2)!.data = {}; },
    claimedFrom: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).from = "claimed"; },
    unknownFrom: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).from = "unknown"; },
    claimed: (s) => { s.events = [...s.events.slice(0, -2), event(13, "note", { lend: { peer: "mate", orderId: "order-pm-mate", op: "claim" } }), ...s.events.slice(-2)]; },
    wrongOrder: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).orderId = "order-other"; },
    wrongNotePeer: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).peer = "other"; },
    wrongLinkPeer: (s) => { s.events.at(-3)!.data.peer = "other"; },
    wrongHead: (s) => { s.events.at(-3)!.data.head = "e".repeat(40); },
    wrongRound: (s) => { s.events.at(-3)!.data.round = 0; },
    wrongTask: (s) => { s.events.at(-2)!.target = "T2"; },
    unsettled: (s) => { s.events = s.events.slice(0, -1); },
    settledOther: (s) => { s.events.at(-1)!.data.id = "other"; },
    settledBefore: (s) => { s.events.at(-1)!.seq = s.events.at(-2)!.seq - 1; },
    settledDone: (s) => { s.events.at(-1)!.data.to = "done"; },
    // peer-pr-push-record --data can mimic the lend object, but its note always carries op/key/result beside it (review cancel-note-source).
    peerPrRecord: (s) => { s.events.at(-2)!.data = { op: "peer_pr_push", key: "k", result: "sent", ...s.events.at(-2)!.data }; },
    extraLendKey: (s) => { (s.events.at(-2)!.data.lend as Record<string, unknown>).reason = "依赖未就绪"; },
    priorWithdrawal: (s) => { s.events = [...s.events.slice(0, -2), event(13, "note", { lend: { peer: "mate", orderId: "order-pm-mate", op: "cancel",
      from: "pooled", withdrawnBy: "owner" } }), ...s.events.slice(-2)]; },
    laterCancel: (s) => { s.events = [...s.events.slice(0, -1), { ...event(98, "note", { lend: { peer: "mate", orderId: "order-pm-mate", op: "cancel",
      from: "pooled" } }), actor: "pm" }, { ...s.events.at(-1)!, seq: 99 }]; },
    laterRelease: (s) => { s.events = [...s.events, event(99, "note", { lend: { peer: "mate", orderId: "order-pm-mate", op: "release" } })]; },
    ...Object.fromEntries((["pending", "submitted", "unknown", "done"] as const).map((st) => [st, (s: PlannerSnapshot) => { s.intents[0].status = st; }])),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const s = snapshot();
    pmCancel(s, "mate");
    mutate(s);
    expect([name, placementHistory(s, 10)]).toEqual([name, { tried: ["mate"], retries: [] }]);
  }
});

test("PC1: refusals, gate refusals and real failures stay spent; earlier history is kept, later failures count", () => {
  const gate = snapshot();
  pmCancel(gate, "mate");
  gate.events = gate.events.filter((e) => e.kind !== "scheduler"); // offer refused at the materials gate: no order was ever linked
  expect(placementHistory(gate, 10).tried).toEqual(["mate"]);
  for (const code of ["repo", "content_policy", "unknown"]) {
    const s = snapshot();
    refusal(s, "mate", code, "first");
    pmCancel(s, "mate");
    expect(placementHistory(s, 10)).toEqual({ tried: ["mate"], retries: [] });
  }
  const later = snapshot();
  pmCancel(later, "mate");
  refusal(later, "mate", "repo", "after");
  expect(placementHistory(later, 10)).toEqual({ tried: ["mate"], retries: [] });
  const temp = snapshot();
  refusal(temp, "mate", "no_slot", "first");
  pmCancel(temp, "mate");
  temp.pool!.now = REFUSED + 1;
  expect(placementHistory(temp, 10)).toMatchObject({ tried: [], retries: [{ peer: "mate", gate: expect.stringContaining("2 分钟") }] });
  expect(planScheduler(temp)).toMatchObject(wait);
});

test("PC1: a released peer still passes off / pause / repo / role / grant / hello / file-lock gates", () => {
  for (const blocked of ["off", "repo", "role", "grant", "paused", "full", "lock", "mode-off"] as const) {
    const s = snapshot("build");
    pmCancel(s, "mate");
    const p = s.pool!.peers[0];
    if (blocked === "off") p.priority = "off";
    if (blocked === "repo") p.v2!.repos = [];
    if (blocked === "role") p.v2!.roles = ["review"];
    if (blocked === "grant") p.v2!.why = "对方没有授权（或已收回）";
    if (blocked === "paused") p.v2!.why = "对方暂停接单";
    if (blocked === "full") p.v2!.slots = { claude: 0, codex: 0 };
    if (blocked === "lock") s.heldResources = [{ taskId: "other", resource: "src/lib/x.ts" }];
    if (blocked === "mode-off") s.pool!.remote.mode = "off";
    expect([blocked, planScheduler(s)]).not.toMatchObject([blocked, { recipient: "peer:mate" }]);
  }
});
