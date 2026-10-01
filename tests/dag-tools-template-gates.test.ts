/**
 * i28-N4: ui / security v3 keep every gate their v2 had — the gates key off the template name, the version only moves
 * approve_restate to restate_recorded. ui v3: no merge without screenshots and the owner's approval; security v3: review stays a
 * local, cross-family session out of the pool; v2 of all three is untouched. End to end on autoFixture where the ledger matters,
 * planner snapshots where only the decision does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkflow, type WorkflowTemplate } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { beginMergeRun } from "../src/lib/scheduler-merge.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import type { PoolFacts } from "../src/lib/scheduler-pool-plan.js";
import { FLOW_TEMPLATES, LATEST_TEMPLATE_VERSION, nodeAt, templateFor } from "../src/lib/scheduler-template.js";
import { autoFixture, H2 } from "./scheduler-auto-helpers.js";

let f: ReturnType<typeof autoFixture>;
afterEach(() => f?.close());

const setTemplate = async (template: WorkflowTemplate, version: string) => {
  const w = getWorkflow(f.db, "T1")!;
  return f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(w.rev), "--template", template,
    "--version", version, "--mode", "auto", "--author-family", "claude", "--fallback", "只报错不修");
};
const restate = () => f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述见 reviews/T1-restate.md");

/** A v3 card of this template, its restate order sent. */
async function v3Card(template: WorkflowTemplate, ownerVisual = false) {
  f = autoFixture({ template: template === "ui" ? "ui" : "code", ownerVisual });
  expect(await setTemplate(template, "3")).toMatchObject({ ok: true, workflow: { template, templateVersion: 3 } });
  await f.tick(); // ensure author session
  await f.tick(); // restate order
}

/** From the restate order to a passing review on H2: restate record → build with no PM, write, deliver, review. */
async function toPassedReview() {
  expect(await restate()).toMatchObject({ ok: true });
  await f.tick(); // restate → build
  expect(f.task().stage).toBe("build");
  expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "restate_approved")).toBe(false);
  await f.tick(); // write order
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  expect(await f.review("pass", H2, [])).toMatchObject({ ok: true });
}

describe("ui v3: restate like code v3, merge still behind the owner screenshot gate", () => {
  test("restate record releases build with no PM; review pass opens the owner ask and waits on it", async () => {
    await v3Card("ui", true);
    await toPassedReview();
    expect(await f.tick()).toMatchObject({ step: "ask" });
    for (let i = 0; i < 2; i++) expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 owner 看前后截图" });
    expect(f.intents().some((i) => i.action === "merge")).toBe(false);
    expect(f.task().stage).toBe("review");
  });

  test("no screenshots and no digest: the pass escalates ui_missing_screenshots instead of moving to merge", async () => {
    await v3Card("ui");
    f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ fileGlobs: ["src/lib/x.ts"] }));
    await toPassedReview();
    expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("ui_missing_screenshots") });
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    expect(f.task().stage).toBe("review");
  });

  test("restate-hold stops a ui v3 card until PM releases it", async () => {
    await v3Card("ui");
    expect(await f.cli("pm", "restate-hold", "T1", "--reason", "截图规格再对一下")).toMatchObject({ ok: true });
    expect(await restate()).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "waiting", detail: "PM 拦住了复述：截图规格再对一下" });
    expect(f.task().stage).toBe("restate");
    expect(await f.cli("pm", "restate-approve", "T1")).toMatchObject({ ok: true });
    await f.tick();
    expect(f.task().stage).toBe("build");
  });

  test("merge-begin still refuses a ui v3 card outright", () => {
    const dir = mkdtempSync(join(tmpdir(), "i28-n4-merge-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    try {
      const ctx = { actor: "owner", now: 100 };
      createTask(db, ctx, { project: "p", id: "T1", title: "ui", kind: "code", agent: "agent-author" });
      setWorkflow(db, ctx, { taskId: "T1", taskRev: 1, template: "ui", templateVersion: 3, mode: "auto", authorFamily: "claude", fallback: "x" });
      db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr=?, branch='task/T1', extra=? WHERE id='T1'")
        .run(H2, "https://github.com/example/repo/pull/42", JSON.stringify({ screenshotsDigest: "d".repeat(64) }));
      db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,
        templateVersion,status,reason,createdAt,updatedAt) VALUES ('merge-one','T1','p','merge_deploy','merge',3,4,2,1,?,3,'submitted','ready',100,100)`).run(H2);
      expect(() => beginMergeRun(db, ctx, "merge-one", ["check"])).toThrow(/UI 截图 owner 许可/);
    } finally {
      closeLedger(path);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "s-a", taskId: "T1", family: "claude", source: "local" };
const reviewer: WorkerRef = { agent: "agent-review", sessionId: "s-r", taskId: "T1", family: "codex", source: "local" };
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "x", project: "p", target: "T1", text: "复述", dedupKey: null });
const pool: PoolFacts = { remote: { mode: "balance", roles: ["review"], poolTimeoutMin: 15 }, localReviewers: 0, repo: "o/r", lastPeer: null,
  peers: [{ peer: "mate", open: 0, maxOpen: 2, roles: ["review"], v2: { why: null, slots: { codex: 1, claude: 1 }, roles: ["review"], repos: ["o/r"] } }] };
const snap = (template: WorkflowTemplate, version: 2 | 3, stage: Stage, over: Partial<PlannerSnapshot> = {}): PlannerSnapshot => ({
  task: { id: "T1", project: "p", itemId: null, title: "t", kind: "code", stage, stageBefore: null, round: stage === "restate" ? 0 : 1, agent: author.agent,
    assigneeKind: "agent", assignee: author.agent, pm: "pm", branch: "b", pr: null, headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1,
    extra: {}, createdAt: 1, updatedAt: 1 } as LedgerTask,
  workflow: { taskId: "T1", project: "p", template, templateVersion: version, mode: "auto", authorFamily: "claude", fallback: "x", specRev: 1,
    rev: 1, createdAt: 1, updatedAt: 1 },
  events: [ev(1, "task", { op: "new" }), stage === "restate" ? ev(11, "stage", { from: "spec", to: "restate", specRev: 1 })
    : ev(11, "stage", { from: "build", to: stage, round: 1, specRev: 1 })],
  intents: [], blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/x.ts"], heldResources: [], workerCount: 0, maxWorkers: 2,
  freeWorkerSlot: "slot:p:0", author, reviewer: null, reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null, ...over,
});

describe("security v3: review stays local and cross-family", () => {
  test("a usable peer in the pool still gets no security review: a local reviewer session is made instead", () => {
    expect(planScheduler(snap("code", 3, "review", { pool }))).toMatchObject({ kind: "intent", action: "review", recipient: "peer:mate" });
    expect(planScheduler(snap("security", 3, "review", { pool }))).toMatchObject({ kind: "intent", action: "ensure_session", sessionRole: "reviewer", sessionFamily: "codex" });
  });

  test("a peer-sourced or same-family reviewer is refused as reviewer_independence; a local codex session reviews", () => {
    const refused = { kind: "escalate", code: "reviewer_independence" };
    expect(planScheduler(snap("security", 3, "review", { reviewer: { ...reviewer, source: "peer_claim" } }))).toMatchObject(refused);
    expect(planScheduler(snap("security", 3, "review", { reviewer: { ...reviewer, family: "claude" } }))).toMatchObject(refused);
    expect(planScheduler(snap("security", 3, "review", { reviewer }))).toMatchObject({ kind: "intent", action: "review", recipient: "agent-review" });
  });

  test("restate like code v3: the executor's record releases build with no PM approval", async () => {
    await v3Card("security");
    expect(await restate()).toMatchObject({ ok: true });
    await f.tick();
    expect(f.task().stage).toBe("build");
    expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "restate_approved")).toBe(false);
  });
});

describe("v2 is untouched", () => {
  test("templateFor(t, 2) is the same object with the same nodes; every v3 is the latest and differs only at approve_restate", () => {
    for (const t of ["code", "ui", "security"] as const) {
      expect(templateFor(t, 2)).toBe(FLOW_TEMPLATES[t]);
      expect(nodeAt(FLOW_TEMPLATES[t], "restate")?.gate).toBe("pm_restate");
      const v3 = templateFor(t, LATEST_TEMPLATE_VERSION[t])!;
      expect(v3).toMatchObject({ id: t, version: 3, uiGate: t === "ui" });
      expect(v3.nodes.filter((n, i) => JSON.stringify(n) !== JSON.stringify(FLOW_TEMPLATES[t].nodes[i])).map((n) => [n.id, n.gate]))
        .toEqual([["approve_restate", "restate_recorded"]]);
    }
  });

  test("ui / security v2 in restate still wait for PM; v3 of the same moves on", () => {
    for (const t of ["ui", "security"] as const) {
      expect(planScheduler(snap(t, 2, "restate"))).toMatchObject({ kind: "wait", code: "pm_restate" });
      expect(planScheduler(snap(t, 3, "restate"))).toMatchObject({ kind: "intent", action: "stage", targetStage: "build" });
    }
  });

  test("ui / security v2 cards: restate-hold refused, a restate record alone waits for PM", async () => {
    for (const t of ["ui", "security"] as const) {
      f = autoFixture({ template: t === "ui" ? "ui" : "code" });
      if (t === "security") expect(await setTemplate("security", "2")).toMatchObject({ ok: true });
      await f.tick();
      await f.tick();
      expect(await f.cli("pm", "restate-hold", "T1", "--reason", "v2 不需要")).toMatchObject({ ok: false, code: "invalid" });
      expect(await restate()).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 PM 放行复述" });
      expect(f.task().stage).toBe("restate");
      f.close();
    }
  });
});
