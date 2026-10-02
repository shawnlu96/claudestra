import { expect, test } from "bun:test";
import { readEvents } from "../src/shared-ledger/exec-tasks";
import { attachSourceObservations, readSourceObservations, readWorkflow } from "../src/shared-ledger/exec-workflows";
import { command, harness, nodes } from "./shared-ledger-v2-workflows-harness.test";

const observation = (seq: number, patch: Record<string, unknown> = {}) => ({ instanceId: "peer-a", seq, origin: null, originSeq: null,
  observedAt: 1500, claimedCommand: "workflow.set", summary: "源端观测", artifactIds: [], ...patch });

test("X1 and X14 commands share one central serverSeq in commit order", () => {
  const h = harness();
  const seqs = [
    h.run(command("workflow.set", { mode: "observe" })),
    h.runTask(command("task.set", { patch: { title: "改名" } })),
    h.run(command("dag.init", { nodes })),
    h.run(command("step.assign", { expectedRev: 2, expectedWorkflowRev: 2 })),
  ].map(r => r.serverSeq);
  expect(seqs).toEqual([1, 2, 3, 4]);
  const events = h.tx(ctx => readEvents(ctx));
  expect(events.map(e => [e.seq, e.kind, e.command])).toEqual([
    [1, "workflow", "workflow.set"], [2, "task", "task.set"], [3, "dag", "dag.init"], [4, "step", "step.assign"],
  ]);
  expect(events.every(e => e.source === null && e.timestamp === 2000)).toBe(true);
});

test("command bodies cannot carry serverSeq, source sequence or a source command", () => {
  const h = harness();
  const base = command("workflow.set", { mode: "observe" });
  for (const extra of [{ serverSeq: 99 }, { source: { instanceId: "peer-a", seq: 7 } }, { seq: 1 }]) {
    expect(() => h.run({ ...base, ...extra })).toThrow("invalid_field");
    expect(() => h.run({ ...base, payload: { ...base.payload, ...extra } })).toThrow("invalid_field");
  }
  expect(() => h.run({ ...base, payload: { ...base.payload, command: { type: "workflow.set", mode: "auto" } } })).toThrow("invalid_field");
  expect(h.row("exec_events")).toEqual([]);
  expect(h.tx(ctx => readWorkflow(ctx, "task")).mode).toBe("manual");
});

test("source events are observation attachments ordered by the central serverSeq, never by source seq", () => {
  const h = harness();
  const first = h.run(command("workflow.set", { mode: "observe" }));
  const second = h.run(command("step.assign", { expectedWorkflowRev: 2 }));
  // The source numbers run backwards and claim an auto-mode command; neither affects order or state.
  h.tx(ctx => attachSourceObservations(ctx, second, [observation(900, { claimedCommand: "workflow.set mode=auto" })]));
  h.tx(ctx => attachSourceObservations(ctx, first, [observation(1000), observation(5, { instanceId: "peer-b" })]));
  const attached = h.tx(ctx => readSourceObservations(ctx));
  expect(attached.map(a => [a.serverSeq, a.observation.instanceId, a.observation.seq])).toEqual([
    [first.serverSeq, "peer-a", 1000], [first.serverSeq, "peer-b", 5], [second.serverSeq, "peer-a", 900],
  ]);
  expect(h.tx(ctx => readWorkflow(ctx, "task"))).toMatchObject({ mode: "observe", rev: 2 });
  expect(h.row("exec_events").map(r => r.seq)).toEqual([1, 2]);
});

test("source keys dedupe idempotently, conflicting replays and forged receipts are rejected", () => {
  const h = harness();
  const receipt = h.run(command("workflow.set", { mode: "observe" }));
  const once = h.tx(ctx => attachSourceObservations(ctx, receipt, [observation(3)]));
  expect(h.tx(ctx => attachSourceObservations(ctx, receipt, [observation(3)]))).toEqual(once);
  expect(() => h.tx(ctx => attachSourceObservations(ctx, receipt, [observation(3, { summary: "改过" })]))).toThrow("dedup_mismatch");
  expect(() => h.tx(ctx => attachSourceObservations(ctx, { ...receipt, serverSeq: 42 }, [observation(4)]))).toThrow("not_found");
  expect(() => h.tx(ctx => attachSourceObservations(ctx, { ...receipt, projectId: "other" }, [observation(4)]))).toThrow("forbidden");
  expect(() => h.tx(ctx => attachSourceObservations(ctx, receipt, [{ ...observation(4), command: "x" }]))).toThrow("invalid_field");
  expect(h.row("exec_source_events").length).toBe(1);
  expect(() => h.db.run("UPDATE exec_source_events SET serverSeq=0")).toThrow("immutable");
  expect(() => h.db.run("DELETE FROM exec_source_events")).toThrow("immutable");
});
