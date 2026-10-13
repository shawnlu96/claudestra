/**
 * dispatch-recovery-CVCOUNT1 · 验收线 1 on a real (temp, in-process) ledger: the events are written by the ledger CLI and the tick,
 * so the `fallback_manual` / `workflow_resume` rows are the formal ones, and the swap materials read the same boundary as the planner.
 */
import { expect, test } from "bun:test";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { P1 } from "./scheduler-auto-helpers.js";

const H3 = "3".repeat(40), H4 = "4".repeat(40);
type Fixture = Awaited<ReturnType<typeof repeatedFix>>;
const ok = (r: unknown) => expect(r).toMatchObject({ ok: true });

/** Old spec: the same P1 in rounds 1 and 2, round 3 dispatched and cut off by PM's spec change; then the formal hand-back on spec 2. */
async function resumedOnNewSpec(): Promise<Fixture> {
  const f = await repeatedFix();
  ok(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H3));
  expect(await f.tick()).toMatchObject({ step: "sent" }); // round 3's review order is out
  ok(await f.cli("pm", "stage", "T1", "--from", "review", "--to", "spec")); // no verdict: specRev 2, the round is kept
  await f.tick(); // workflow_drift → manual
  ok(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--reason", "规格已改"));
  await f.tick(); await f.tick();
  ok(await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述"));
  ok(await f.cli("pm", "restate-approve", "T1"));
  await f.tick(); await f.tick();
  ok(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H4));
  await f.tick(); await f.tick();
  return f;
}
const plan = (f: Fixture) => planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));

test("[验收线 1] the recorded history is the formal one: an interrupted round 3, spec 2 entered by workflow_resume only", async () => {
  const f = await resumedOnNewSpec();
  try {
    const ops = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "scheduler");
    expect(ops.filter((e) => e.data.op === "workflow").map((e) => e.data.specRev)).toEqual([1]);
    expect(ops.find((e) => e.data.op === "fallback_manual")?.data.abortedReview).toEqual({ round: 3 });
    expect(ops.filter((e) => e.data.op === "workflow_resume").map((e) => [e.data.fromSpecRev, e.data.specRev])).toEqual([[1, 2]]);
    expect(f.task()).toMatchObject({ stage: "review", round: 4, specRev: 2 });
  } finally { f.close(); }
});

test("[验收线 1] the new spec's first P1 is a plain fix: no fix_swap, no two-round warning", async () => {
  const f = await resumedOnNewSpec();
  try {
    ok(await f.review("changes", H4, [P1]));
    expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix", workOrder: { fallbackWarning: null } });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
    expect(plan(f)).toMatchObject({ kind: "intent", action: "dispatch", recipient: "agent-task-one", workOrder: { fallbackWarning: null } });
    expect(await f.tick()).toMatchObject({ step: "sent" });
    expect(f.intents().some((i) => i.action === "fix_swap")).toBe(false);
    expect(getWorkflow(f.db, "T1")).toMatchObject({ mode: "auto", authorFamily: "claude", specRev: 2 });
  } finally { f.close(); }
});

test("[验收线 1] the swap runtime reads the same boundary: a fix_swap left over for this card finds no two-round P1 and stops nobody", async () => {
  const f = await resumedOnNewSpec();
  try {
    ok(await f.review("changes", H4, [P1]));
    await f.tick();
    expect(f.task()).toMatchObject({ stage: "fix", round: 4 });
    const p = convergenceProbe(f);
    const causalSeq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
    const intent = planIntent(f.db, f.at("scheduler"), { id: "fix-swap:s1:r4", node: "fix", action: "fix_swap", resources: ["task:s1"],
      reason: "换修复会话", taskId: "T1", taskRev: f.task().rev, workflowRev: getWorkflow(f.db, "T1")!.rev, causalSeq }).intent;
    await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow("没有连续两轮的 P1");
    expect(p.effects).toEqual([]);
    expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "fix_strategy")).toBe(false);
  } finally { f.close(); }
});
