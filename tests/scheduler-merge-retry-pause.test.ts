import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { resumeAutoWorkflow } from "../src/lib/ledger-scheduler-resume.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { advanceMergeRun, beginMergeRun, getMergeRun, resolveMergeRun, type MergePhase } from "../src/lib/scheduler-merge.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

/** All journal, pause, resume and review evidence comes from the existing writers on a temporary SQLite ledger. */
export async function pauseFixture(phase: "pending" | "ready" | "updating" | "await_ci" = "ready") {
  const f = autoFixture();
  try {
    await toBuild(f);
    expect(await f.tick()).toMatchObject({ step: "sent" });
    expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "session" });
    expect(await f.tick()).toMatchObject({ step: "sent" });
    expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    expect(await f.cli("pm", "task-set", "T1", "--rev", String(f.task().rev), "--pr", "https://github.com/example/repo/pull/42",
      "--branch", "task/T1")).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    const id = f.intents().at(-1)!.id;
    if (phase !== "pending") {
      settleIntent(f.db, f.at("scheduler"), { id, from: "pending", to: "submitted", receipt: "controller began journal" });
      beginMergeRun(f.db, f.at("scheduler"), id, ["check"]);
    }
    const step = (to: MergePhase, receipt?: string, newHead?: string) => {
      const run = getMergeRun(f.db, id)!;
      return advanceMergeRun(f.db, f.at("scheduler"), { intentId: id, from: run.phase, to, rev: run.rev, receipt, newHead });
    };
    if (phase === "updating" || phase === "await_ci") step(phase, phase === "await_ci" ? "same head; CI pending" : undefined);
    const pause = (actor = "pm", reason = "temporary resource handoff") => {
      const w = getWorkflow(f.db, "T1")!;
      return setWorkflow(f.db, f.at(actor), { taskId: "T1", taskRev: f.task().rev, workflowRev: w.rev,
        template: w.template, templateVersion: w.templateVersion, mode: "manual", authorFamily: w.authorFamily, fallback: w.fallback, reason });
    };
    const resume = (actor = "pm", db = f.db) => resumeAutoWorkflow(db, f.at(actor), { taskId: "T1", taskRev: getTask(db, "T1")!.rev,
      workflowRev: getWorkflow(db, "T1")!.rev, reason: "handoff finished", maxWorkers: 2 });
    const snapshot = (db = f.db) => autoSnapshot(db, getTask(db, "T1")!, { registry: [], maxWorkers: 2 });
    const plan = (db = f.db) => {
      const pending = f.intents().findLast((i) => i.action === "merge" && i.status === "pending");
      const existing = pending ? getIntent(db, pending.id) : null;
      const s = autoSnapshot(db, getTask(db, "T1")!, { registry: [], maxWorkers: 2 }, existing?.id), d = planScheduler(s);
      if (d.kind !== "intent") throw new Error(JSON.stringify(d));
      const causalSeq = (db.query("SELECT MAX(seq) AS n FROM events WHERE project='p'").get() as { n: number }).n;
      return planIntent(db, f.at("scheduler"), { id: d.id, taskId: "T1", taskRev: s.task.rev, workflowRev: s.workflow!.rev,
        causalSeq: existing?.causalSeq ?? causalSeq, node: d.node, action: d.action, reason: d.reason, resources: d.resources });
    };
    const evidence = () => ({ reviews: listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "review"),
      sessions: f.db.query("SELECT * FROM scheduler_sessions ORDER BY role").all(),
      reviewIntents: f.db.query("SELECT * FROM scheduler_intents WHERE action='review'").all() });
    const released = () => mergeRetryReleased(f.task(), snapshot().events, getIntent(f.db, id)!);
    return { ...f, id, step, pause, resume, snapshot, plan, evidence, released };
  } catch (e) {
    f.close();
    throw e;
  }
}

describe("MRREST controller cancellation and official PM resume", () => {
  for (const phase of ["ready", "updating", "await_ci"] as const) {
    test(`[验收线 1,3] ${phase} pause → cancel → resume → one durable retry`, async () => {
      const f = await pauseFixture(phase);
      try {
        const before = f.evidence();
        f.pause();
        expect(f.step("resolved", "opaque receipt unrelated to PM names")).toMatchObject({ phase: "resolved" });
        expect(getIntent(f.db, f.id)!.status).toBe("cancelled");
        expect(f.db.query("SELECT * FROM scheduler_resources WHERE intentId=?").all(f.id)).toEqual([]);
        expect(f.released()).toBe(false);
        f.resume();
        expect(f.released()).toBe(true);
        expect(planScheduler(f.snapshot())).toMatchObject({ kind: "intent", action: "merge", id: expect.stringContaining(":merge_deploy:a1") });
        const retry = f.plan().intent;
        expect(retry.id).not.toBe(f.id);
        expect(retry.head).toBe(H1);
        expect(f.db.query("SELECT intentId FROM scheduler_resources WHERE resource='merge:p'").get()).toEqual({ intentId: retry.id });
        expect(f.plan()).toMatchObject({ duplicate: true, intent: { id: retry.id } });
        for (let n = 0; n < 3; n++) expect(await f.tick()).toMatchObject({ step: "merge_queue" });
        expect(f.evidence()).toEqual(before);
        expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action='merge'").get()).toEqual({ n: 2 });
      } finally { f.close(); }
    });
  }

  test("[验收线 3] restart and two SQLite connections agree; a second cancellation needs a new resume", async () => {
    const f = await pauseFixture("updating");
    try {
      f.pause(); f.step("resolved", "paused"); f.resume();
      const other = new Database(f.dir + "/ledger.sqlite");
      try {
        const first = f.plan().intent;
        expect(f.plan(other)).toMatchObject({ duplicate: true, intent: { id: first.id } });
        const restarted = new Database(f.dir + "/ledger.sqlite");
        try {
          expect(f.plan(restarted)).toMatchObject({ duplicate: true, intent: { id: first.id } });
        } finally { restarted.close(); }
        settleIntent(f.db, f.at("scheduler"), { id: first.id, from: "pending", to: "submitted", receipt: "new journal" });
        beginMergeRun(f.db, f.at("scheduler"), first.id, ["check"]);
        f.pause();
        const row = getMergeRun(f.db, first.id)!;
        advanceMergeRun(f.db, f.at("scheduler"), { intentId: first.id, from: row.phase, to: "resolved", rev: row.rev, receipt: "again" });
        expect(planScheduler(f.snapshot())).toMatchObject({ kind: "wait", code: "manual" });
        const second = getIntent(f.db, first.id)!;
        expect(mergeRetryReleased(f.task(), f.snapshot().events, second)).toBe(false);
        f.resume();
        expect(f.plan().intent.id).toContain(":merge_deploy:a2");
      } finally { other.close(); }
    } finally { f.close(); }
  });

  test("[验收线 3] unknown → real human resolve → resume remains supported", async () => {
    const f = await pauseFixture();
    try {
      f.step("unknown", "external result uncertain");
      resolveMergeRun(f.db, f.at("pm"), { intentId: f.id, outcome: "cancelled", receipt: "PR open; mergedAt absent" });
      f.resume();
      expect(f.released()).toBe(true);
      expect(planScheduler({ ...f.snapshot(), queueFrozen: false })).toMatchObject({ kind: "intent", action: "merge" });
    } finally { f.close(); }
  });
});
