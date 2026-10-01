/**
 * i28-W5 planner hooks over PlannerSnapshot: what reviewPlacement and remoteWork turn the pool facts into. Same-family
 * reviewers, security cards, bound local reviewers and proto-1 peers never enter the balance; a pinned card's write /
 * fix / restate dispatch waits instead of starting locally; one live pool intent per node.
 */
import { describe, expect, test } from "bun:test";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { explainPlacement } from "../src/lib/scheduler-placement-plan.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";

const HEAD = "a".repeat(40);
const REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "claude", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "复述", dedupKey: null });
const v2 = (slots = { codex: 1, claude: 1 }) => ({ why: null, slots, roles: ["review" as const], repos: ["o/r"] });
const pool = (over: Partial<PoolFacts> = {}): PoolFacts => ({ remote: REMOTE, localReviewers: 0, repo: "o/r", lastPeer: null,
  peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: v2() }], ...over });
const snap = (stage: Stage, over: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round: 1, agent: author.agent, assigneeKind: "agent",
    assignee: author.agent, pm: "pm", branch: "b", pr: "https://github.com/o/r/pull/7", headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" }), ev(11, "stage", { from: "build", to: stage, round: 1, specRev: 1 })], intents: [], blockedBy: [], queueFrozen: false,
  fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, pool: pool(), ...over,
});
const poolIntent = (status: SchedulerIntent["status"], peer: string): SchedulerIntent => ({ id: `i-${peer}`, taskId: "T1", project: "p",
  node: "adversarial_review", action: "review", recipient: `peer:${peer}`, causalSeq: 12, eventSeq: 13, taskRev: 1, specRev: 1, head: HEAD,
  templateVersion: 2, status, attempts: 0, receipt: null, reason: "x", createdAt: 1, updatedAt: 1 });

describe("review placement", () => {
  test("a usable v2 peer: pool intent to it with the cross-family reviewer and the loads in the reason", () => {
    expect(planScheduler(snap("review"))).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate", reviewMode: "adversarial",
      reason: expect.stringMatching(/^挂池：对抗式跨模型审查挂给 mate 的 codex worker（在跑：mate 0 \/ 本机 0；/) });
  });

  test("a Codex-authored card needs a Claude reviewer: pooled only where a Claude slot is free", () => {
    const s = snap("review", { author: { ...author, family: "codex" } });
    s.workflow = { ...s.workflow!, authorFamily: "codex" };
    s.pool = pool({ peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: v2({ codex: 2, claude: 0 }) }] });
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "ensure_session", sessionFamily: "claude" });
    s.pool = pool();
    expect(planScheduler(s)).toMatchObject({ kind: "intent", recipient: "peer:mate", reason: expect.stringContaining("的 claude worker") });
  });

  test("security cards and a card whose reviewer session is already bound stay local", () => {
    const sec = snap("review");
    sec.workflow = { ...sec.workflow!, template: "security" };
    expect(planScheduler(sec)).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer" });
    const bound = snap("review", { reviewer: { agent: "rv", sessionId: "s-rv", taskId: "T1", family: "codex", source: "local" } });
    expect(planScheduler(bound)).toMatchObject({ kind: "intent", action: "review", recipient: "rv" });
  });

  test("proto-1 peers stay out of the balance: local has room → local; local full → i28-R9's text and choice", () => {
    const legacy = { peer: "old", open: 0, maxOpen: 1 };
    expect(planScheduler(snap("review", { pool: pool({ peers: [legacy] }) }))).toMatchObject({ action: "ensure_session" });
    expect(planScheduler(snap("review", { pool: pool({ peers: [legacy], localReviewers: 2 }) })))
      .toMatchObject({ recipient: "peer:old", reason: "挂池：对抗式跨模型审查挂给 old 的 codex worker" });
    const mixed = pool({ localReviewers: 2, peers: [legacy, { peer: "mate", open: 3, maxOpen: 5, roles: ["review"], v2: v2() }] });
    expect(planScheduler(snap("review", { pool: mixed }))).toMatchObject({ recipient: "peer:mate" });
  });

  test("a v2 peer that is offline or revoked is not a proto-1 fallback either", () => {
    const off = { peer: "mate", open: 0, maxOpen: 2, roles: ["review" as const], v2: { ...v2(), why: "对方没有授权（或已收回）" } };
    expect(planScheduler(snap("review", { pool: pool({ localReviewers: 2, peers: [off] }) }))).toMatchObject({ action: "ensure_session" });
  });

  test("one live pool intent per node; after a cancelled try the next peer, all tried → local", () => {
    const two = pool({ peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: v2() }, { peer: "b", open: 0, maxOpen: 2, roles: ["review"], v2: v2() }] });
    expect(planScheduler(snap("review", { pool: two, intents: [poolIntent("submitted", "mate")] }))).toMatchObject({ kind: "wait" });
    expect(planScheduler(snap("review", { pool: two, intents: [poolIntent("cancelled", "mate")] }))).toMatchObject({ recipient: "peer:b" });
    expect(planScheduler(snap("review", { pool: two, intents: [poolIntent("cancelled", "mate"), { ...poolIntent("cancelled", "b"), id: "i2", eventSeq: 14 }] })))
      .toMatchObject({ action: "ensure_session" });
  });
});

describe("pinned card", () => {
  const pinned = (stage: Stage) => snap(stage, { task: { ...snap(stage).task, extra: { placement: "peer:mate", fileGlobs: ["src/lib/x.ts"] } } });

  test("restate / write / fix dispatch waits on the pin instead of a local session or order, even with a free slot", () => {
    for (const stage of ["spec", "build", "fix"] as const) {
      expect(planScheduler(pinned(stage))).toEqual({ kind: "wait", code: "placement_pinned", reason: "固定放在 peer:mate，它现在不能接：scheduler.json remote.roles 不含 write" });
    }
    expect(planScheduler({ ...pinned("build"), author: null })).toMatchObject({ kind: "wait", code: "placement_pinned" });
  });

  test("a pin that is not a peer string is ignored (no pin)", () => {
    const s = snap("build", { task: { ...snap("build").task, extra: { placement: "local" } } });
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "dispatch", recipient: author.agent });
  });
});

describe("explainPlacement (the lend-orders column)", () => {
  test("says what the planner does: pooled review, local review with the cause, pinned writing that waits, stages without placement", () => {
    expect(explainPlacement(snap("review"))).toMatchObject({ role: "review", where: "peer:mate", reason: expect.stringContaining("在跑：mate 0 / 本机 0") });
    expect(explainPlacement(snap("review", { pool: null }))).toEqual({ role: "review", where: "local", reason: "没有借入信息" });
    const pinned = snap("build", { task: { ...snap("build").task, extra: { placement: "peer:mate" } } });
    expect(explainPlacement(pinned)).toEqual({ role: "write", where: "peer:mate", reason: "等：固定放在 peer:mate，它现在不能接：scheduler.json remote.roles 不含 write" });
    expect(explainPlacement(snap("fix"))).toMatchObject({ role: "fix", where: "local" });
    expect(explainPlacement(snap("merge"))).toEqual({ role: null, where: "-", reason: "merge 阶段不放置" });
  });

  test("a live review intent is shown as where the review is, not a fresh pick that skips its peer", () => {
    const two = pool({ peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: v2() }, { peer: "b", open: 0, maxOpen: 2, roles: ["review"], v2: v2() }] });
    for (const p of [pool(), two]) {
      const s = snap("review", { pool: p, intents: [poolIntent("submitted", "mate")] });
      expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "in_flight" });
      expect(explainPlacement(s)).toEqual({ role: "review", where: "peer:mate", reason: "已派给 peer:mate，等台账结果（submitted）" });
    }
    const local = { ...poolIntent("pending", "x"), recipient: "rv" };
    expect(explainPlacement(snap("review", { intents: [local] }))).toEqual({ role: "review", where: "local", reason: "已派给 rv，等台账结果（pending）" });
    expect(explainPlacement(snap("review", { pool: two, intents: [poolIntent("cancelled", "mate")] }))).toMatchObject({ where: "peer:b" });
  });
});
