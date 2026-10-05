import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask } from "../src/lib/ledger-store.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { H1 } from "./scheduler-auto-helpers.js";
import { pauseFixture } from "./scheduler-merge-retry-pause.test.js";

type Fixture = Awaited<ReturnType<typeof pauseFixture>>;

/** Every pause, fallback and resume below goes through the permission-checked ledger CLI on the temporary ledger. */
const revs = (f: Fixture, db?: Database) => {
  const d = db ?? f.db;
  return ["--rev", String(getTask(d, "T1")!.rev), "--workflow-rev", String(getWorkflow(d, "T1")!.rev)];
};
const cliPause = (f: Fixture, actor = "pm") => {
  const w = getWorkflow(f.db, "T1")!;
  return f.cli(actor, "workflow-set", "T1", ...revs(f), "--template", w.template, "--version", String(w.templateVersion),
    "--mode", "manual", "--author-family", w.authorFamily, "--fallback", w.fallback, "--reason", "temporary resource handoff");
};
const cliResume = (f: Fixture, actor = "pm") => f.cli(actor, "workflow-resume", "T1", ...revs(f), "--reason", "handoff finished");
/** What the pre-MRREST service did after the first handback: the planner escalated and the scheduler gave the card back to PM. */
const cliAutoFallback = (f: Fixture, id: string, actor = "scheduler") => f.cli(actor, "scheduler-fallback-manual", "T1",
  "--reason", `merge_retry_requires_pm：合并意图 ${id} 已取消，先由 PM 核对外部结果`);

describe("MRRESTP pause → cancel → resume → automatic fallback → explicit resume", () => {
  for (const phase of ["pending", "await_ci"] as const) {
    test(`[验收线 新增] ${phase}: a later explicit PM resume after the old automatic fallback releases once`, async () => {
      const f = await pauseFixture(phase);
      try {
        expect(await cliPause(f)).toMatchObject({ ok: true });
        if (phase !== "pending") f.step("resolved", "paused");
        expect(getIntent(f.db, f.id)!.status).toBe("cancelled");
        expect(f.db.query("SELECT * FROM scheduler_resources WHERE intentId=?").all(f.id)).toEqual([]);
        expect(f.released()).toBe(false);
        expect(await cliResume(f)).toMatchObject({ ok: true });
        expect(f.released()).toBe(true);
        expect(await cliAutoFallback(f, f.id)).toMatchObject({ ok: true });
        expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
        expect(f.released()).toBe(false);
        expect(planScheduler(f.snapshot())).toMatchObject({ kind: "wait", code: "manual" });
        const before = f.evidence();
        expect(await cliResume(f)).toMatchObject({ ok: true });
        expect(f.released()).toBe(true);
        const retry = f.plan().intent;
        expect(retry.id).not.toBe(f.id);
        expect(retry.head).toBe(H1);
        const restarted = new Database(f.dir + "/ledger.sqlite");
        try {
          expect(mergeRetryReleased(getTask(restarted, "T1")!, f.snapshot(restarted).events, getIntent(restarted, f.id)!)).toBe(true);
          expect(f.plan(restarted)).toMatchObject({ duplicate: true, intent: { id: retry.id } });
        } finally { restarted.close(); }
        for (let n = 0; n < 2; n++) expect(await f.tick()).toMatchObject({ step: "merge_queue" });
        expect(f.evidence()).toEqual(before);
        expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action='merge'").get()).toEqual({ n: 2 });
      } finally { f.close(); }
    });
  }

  test("[验收线 新增] the chain is checked link by link, not as any larger revision", async () => {
    const f = await pauseFixture("await_ci");
    try {
      await cliPause(f); f.step("resolved", "paused"); await cliResume(f); await cliAutoFallback(f, f.id); await cliResume(f);
      const s = f.snapshot(), intent = getIntent(f.db, f.id)!;
      const release = (events = s.events) => mergeRetryReleased(s.task, events, intent);
      expect(release()).toBe(true);
      const fallback = s.events.find((e) => e.data.op === "fallback_manual")!;
      const resumes = s.events.filter((e) => e.data.op === "workflow_resume");
      const patch = (target: typeof fallback, p: Record<string, unknown>, top: Record<string, unknown> = {}) =>
        s.events.map((e) => e === target ? { ...e, ...top, data: { ...e.data, ...p } } : e);
      for (const [target, p, top] of [
        [fallback, { reason: "agent session missing" }], [fallback, { reason: "merge_retry_requires_pm：合并意图 other 已取消" }],
        [fallback, { workflowRev: Number(fallback.data.workflowRev) + 1 }], [fallback, { from: "manual" }],
        [fallback, { cancelledIntents: ["x"] }], [fallback, { imported: true }], [fallback, {}, { actor: "pm" }],
        [fallback, { intentId: "other" }], [fallback, { manual: true }],
        [resumes[0], { workflowRev: 999 }], [resumes[1], { workflowRev: 999 }], [resumes[1], { manual: false }],
        [resumes[1], { from: "auto" }], [resumes[1], { stage: "fix" }], [resumes[1], { specRev: 2 }], [resumes[1], { imported: true }],
        [resumes[1], {}, { actor: "scheduler" }], [resumes[0], {}, { actor: "scheduler" }],
      ] as [typeof fallback, Record<string, unknown>, Record<string, unknown>?][]) expect(release(patch(target, p, top))).toBe(false);
      // Dropping or reordering a link breaks the chain.
      expect(release(s.events.filter((e) => e !== resumes[0]))).toBe(false);
      expect(release(s.events.filter((e) => e !== fallback))).toBe(false);
      // A further unrelated fallback or PM takeover after the last resume needs another resume.
      const last = s.events.at(-1)!;
      const tail = (data: Record<string, unknown>, actor: string) => [...s.events, { ...last, seq: last.seq + 1, actor, data }];
      expect(release(tail({ op: "fallback_manual", from: "auto", reason: "agent session missing", workflowRev: Number(resumes[1].data.workflowRev) + 1,
        intentId: null, cancelledIntents: [] }, "scheduler"))).toBe(false);
      expect(release(tail({ op: "workflow", mode: "manual", manual: true, takeover: "pm", workflowRev: Number(resumes[1].data.workflowRev) + 1 }, "pm"))).toBe(false);
    } finally { f.close(); }
  });

  test("[验收线 新增] official writers refuse forged actors at every link", async () => {
    const f = await pauseFixture("await_ci");
    try {
      await cliPause(f); f.step("resolved", "paused"); await cliResume(f);
      for (const actor of ["agent-task-one", "agent-pm-forged", "peer:fake"]) {
        expect(await cliAutoFallback(f, f.id, actor)).toMatchObject({ ok: false });
      }
      await cliAutoFallback(f, f.id);
      for (const actor of ["agent-task-one", "agent-pm-forged", "scheduler", "peer:fake"]) expect(await cliResume(f, actor)).toMatchObject({ ok: false });
      expect(f.released()).toBe(false);
      await cliResume(f, "master");
      expect(f.released()).toBe(true);
    } finally { f.close(); }
  });

  test("[验收线 新增] PM's own fallback, or a stale resume before the fallback, does not count", async () => {
    const f = await pauseFixture("await_ci");
    try {
      await cliPause(f); f.step("resolved", "paused"); await cliResume(f);
      expect(await cliAutoFallback(f, f.id, "pm")).toMatchObject({ ok: true });
      expect(f.released()).toBe(false);
      await cliResume(f);
      expect(f.released()).toBe(false);
      expect(planScheduler(f.snapshot())).toMatchObject({ kind: "escalate", code: "merge_retry_requires_pm" });
    } finally { f.close(); }
  });
});
