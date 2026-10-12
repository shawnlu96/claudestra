/**
 * RECBASE1 [验收线 4] on the real merge_deploy guard: the card passed review, reached merge, queued its merge intent, and the PM put it
 * manual (pending intent cancelled). The planner's merge_retry_requires_pm must see the writer's sealed proof in the same transaction:
 * observe records would_resume and changes nothing, on hands back and the planner's next is the retry a1, a later cancel is not released.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents, type LedgerError } from "../src/lib/ledger-store.js";
import type { ExplicitPolicyPort } from "../src/lib/manual-recovery-policy.js";
import { proveRecovery, registerManualRecovery } from "../src/lib/manual-recovery-release.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { mergeRetryReleased } from "../src/lib/scheduler-merge-retry.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { recoveryFence } from "../src/lib/scheduler-recovery-ports.js";
import { writeManualRecovery } from "../src/lib/scheduler-recovery-write.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const port = (explicit: "on" | null): ExplicitPolicyPort => () => () => ({ policy: { mode: "on", manualAfterMs: null, source: "config" }, explicit });
const bound = { id: "" };
let drop: (() => void) | null = null;
beforeEach(() => {
  drop = registerManualRecovery({ id: "merge-fixture", key: "manualRecovery", codes: ["merge_unknown"], releasesCancel: true,
    judge: ({ entrySeq }) => ({ ok: true, episodeId: `ep-${entrySeq}`, subreason: "merge_cancel", cancelIntentId: bound.id, evidenceSeq: entrySeq, next: "merge" }) });
});
afterEach(() => { drop?.(); drop = null; });

/** Real writers only: review pass → merge → merge intent queued → PM manual with merge_unknown (the pending merge is cancelled). */
async function mergeManual(f: F): Promise<string> {
  await toBuild(f);
  expect(await f.tick()).toMatchObject({ step: "sent" });
  expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "session" });
  expect(await f.tick()).toMatchObject({ step: "sent" });
  expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.cli("pm", "task-set", "T1", "--rev", String(f.task().rev), "--pr", "https://github.com/example/repo/pull/42", "--branch", "task/T1")).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const id = f.intents().at(-1)!.id;
  const wf = getWorkflow(f.db, "T1")!;
  expect(await f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf.rev), "--template", wf.template, "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "merge_unknown", "--reason", `合并意图 ${id} 已取消`)).toMatchObject({ ok: true });
  expect(getIntent(f.db, id)).toMatchObject({ node: "merge_deploy", action: "merge", status: "cancelled" });
  return id;
}
const write = (f: F, mode: "on" | "observe", explicit: "on" | null = mode === "on" ? "on" : null) => {
  const v = proveRecovery(f.db, f.task(), getWorkflow(f.db, "T1"), "merge-fixture", null);
  if (v.kind === "refused") return { ok: false, why: v.why };
  try {
    return writeManualRecovery(f.db, f.at("scheduler"), { ...recoveryFence(f.db, f.task()), mechanism: "merge-fixture", mode, maxWorkers: 2,
      fingerprint: v.proof.fingerprint, external: null }, () => {}, port(explicit)) as Record<string, unknown>;
  } catch (e) { return { ok: false, why: (e as LedgerError).message }; }
};
const ops = (f: F, op: string) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === op);
const plan = (f: F) => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
const state = (f: F) => ({ intents: f.db.query("SELECT id, status FROM scheduler_intents ORDER BY id").all(),
  resources: f.db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  workflow: f.db.query("SELECT mode, rev, specRev FROM task_workflows WHERE taskId = 'T1'").get(), stage: f.task().stage });
const run = async (body: (f: F) => Promise<void>) => { const f = autoFixture(); try { await body(f); } finally { f.close(); } };

describe("[验收线 4] a proof bound to the cancelled merge_deploy intent clears merge_retry_requires_pm in its own transaction", () => {
  test("observe: would_resume with the retry as next; workflow / intents / resources / stage unchanged", () => run(async (f) => {
    bound.id = await mergeManual(f);
    const before = state(f);
    expect(write(f, "observe")).toMatchObject({ ok: true, recorded: true });
    expect(state(f)).toEqual(before);
    expect(ops(f, "workflow_resume")).toHaveLength(0);
    expect(ops(f, "manual_recovery_proof")).toHaveLength(0);
    expect(ops(f, "recovery_observe").at(-1)!.data).toMatchObject({ next: { kind: "intent", node: "merge_deploy", action: "merge" },
      recoveryProof: { cancelIntentId: bound.id } });
  }));

  test("on: hands back once, the planner retries the merge (a1); a later cancellation is not released by the same proof", () => run(async (f) => {
    bound.id = await mergeManual(f);
    expect(write(f, "on")).toMatchObject({ ok: true, next: { kind: "intent", node: "merge_deploy", action: "merge" }, proof: { cancelIntentId: bound.id } });
    expect(getWorkflow(f.db, "T1")!.mode).toBe("auto");
    expect(ops(f, "workflow_resume")).toHaveLength(1);
    expect(mergeRetryReleased(f.task(), listEvents(f.db, { project: "p", target: "T1" }), getIntent(f.db, bound.id) as SchedulerIntent)).toBe(true);
    const d = plan(f);
    expect(d).toMatchObject({ kind: "intent", action: "merge", id: expect.stringContaining(":merge_deploy:a1") });
    expect(write(f, "on")).toMatchObject({ ok: false });
    expect(ops(f, "workflow_resume")).toHaveLength(1);
    // the retry is cancelled too: the old proof binds the first cancellation only
    if (d.kind !== "intent") throw new Error("expected intent");
    const later = { ...(getIntent(f.db, bound.id) as SchedulerIntent), id: d.id };
    expect(mergeRetryReleased(f.task(), listEvents(f.db, { project: "p", target: "T1" }), later)).toBe(false);
  }));

  test("project-wide on without the mechanism's explicit on stays observe; a proof bound to another intent never hands back", () => run(async (f) => {
    const id = await mergeManual(f);
    bound.id = id;
    expect(write(f, "on", null)).toMatchObject({ ok: false, why: expect.stringContaining("observe") });
    bound.id = "I-other";
    expect(write(f, "on")).toMatchObject({ ok: false });
    expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
    expect(ops(f, "workflow_resume")).toHaveLength(0);
  }));
});
