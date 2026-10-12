/** S2F7: makeIntent's attempt count — home intents unchanged, this round's key prefix counts, other prefixes do not. */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { SchedulerIntent, TaskWorkflow } from "../src/lib/ledger-scheduler.js";
import { planScheduler, type PlannerSnapshot, type WorkerRef } from "../src/lib/scheduler-plan.js";
import { intentAttempt, intentKeyPrefix } from "../src/lib/scheduler-plan-attempt.js";

const HEAD = "a".repeat(40);
const author: WorkerRef = { agent: "agent-author", sessionId: "session-author", taskId: "T1", family: "claude", source: "local" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, kind, data, ts: seq, actor: "agent-author", project: "p", target: "T1", text: "", dedupKey: null });
const task: LedgerTask = {
  id: "T1", project: "p", itemId: null, title: "T68", kind: "code", stage: "spec", stageBefore: null, round: 0,
  agent: author.agent, assigneeKind: "agent", assignee: author.agent, pm: "agent-pm", branch: "task/T1", pr: null,
  headSHA: HEAD, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 1, updatedAt: 1,
};
const workflow: TaskWorkflow = { taskId: "T1", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude",
  fallback: "收窄为只报错", specRev: 1, rev: 1, createdAt: 1, updatedAt: 1 };
const snapshot = (intents: SchedulerIntent[] = []): PlannerSnapshot => ({
  task: structuredClone(task), workflow: structuredClone(workflow), events: [event(1, "task", { op: "new" })],
  intents, blockedBy: [], queueFrozen: false, fileGlobs: ["src/lib/*.ts"], heldResources: [],
  workerCount: 0, maxWorkers: 2, freeWorkerSlot: "slot:p:0", author, reviewer: null,
  reviewDispatches: [], uiGate: { state: "none" }, screenshotsDigest: null,
});
const intent = (id: string, node: string, causalSeq: number, status: SchedulerIntent["status"] = "cancelled"): SchedulerIntent => ({
  id, taskId: "T1", project: "p", node, action: "dispatch", recipient: null, causalSeq, eventSeq: causalSeq + 1, taskRev: 1,
  specRev: 1, head: HEAD, templateVersion: 2, status, attempts: 0, receipt: null, reason: "x", createdAt: causalSeq, updatedAt: causalSeq,
});
/** The pre-S2F7 count: same node and planned at or after `since`. */
const homeOnly = (intents: SchedulerIntent[], node: string, since: number) => intents.filter((i) => i.node === node && i.causalSeq >= since).length;
const planned = (s: PlannerSnapshot) => {
  const d = planScheduler(s);
  if (d.kind !== "intent") throw new Error(`expected an intent, got ${JSON.stringify(d)}`);
  return d;
};

describe("S2F7 intent attempt", () => {
  test("[验收线 2] a home-only card keeps its keys verbatim: fresh, and after a cancelled home intent", () => {
    const first = planned(snapshot());
    expect(first.id).toBe("t68:s1:r0:restate:a0");
    // Home intents are planned after `since`, so (a) already covers (b): the next key is the old count's key.
    const cancelled = [intent(first.id, first.node, 1)];
    const next = planned(snapshot(cancelled));
    expect(next.id).toBe(`t68:s1:r0:restate:a${homeOnly(cancelled, "restate", 1)}`);
    expect(next.id).toBe("t68:s1:r0:restate:a1");
    const twice = [...cancelled, intent(next.id, next.node, 2)];
    expect(planned(snapshot(twice)).id).toBe(`t68:s1:r0:restate:a${homeOnly(twice, "restate", 1)}`);
  });

  test("[验收线 2] home intents from an older stage entry keep being ignored, as before", () => {
    const s = snapshot([intent("t68:s0:r0:restate:a0", "restate", 0)]);
    expect(planned(s).id).toBe("t68:s1:r0:restate:a0");
  });

  test("[验收线 1] a projected central intent with a center causalSeq below `since` and this round's prefix counts", () => {
    const projected = [intent("t68:s1:r0:restate:a0", "restate", 0)];
    expect(homeOnly(projected, "restate", 1)).toBe(0);
    expect(planned(snapshot(projected)).id).toBe("t68:s1:r0:restate:a1");
    expect(planned(snapshot([...projected, intent("t68:s1:r0:restate:a1", "restate", 0)])).id).toBe("t68:s1:r0:restate:a2");
  });

  test("[验收线 3] projected intents of another node, round or since prefix do not count", () => {
    const others = [
      intent("t68:s1:r0:write:a0", "restate", 0),
      intent("t68:s1:r0:restate:a0", "write", 0),
      intent("t68:s1:r1:restate:a0", "restate", 0),
      intent("t68:s0:r0:restate:a0", "restate", 0),
      intent("t68:s11:r0:restate:a0", "restate", 0),
      intent("t68:s1:r0:restate_x:a0", "restate", 0),
      intent("op-1234", "restate", 0),
    ];
    expect(intentAttempt(others, "restate", 1, 0)).toBe(0);
    expect(planned(snapshot(others)).id).toBe("t68:s1:r0:restate:a0");
  });

  test("[验收线 1] an intent matching both rules counts once", () => {
    const both = [intent("t68:s5:r2:write:a0", "write", 7)];
    expect(intentAttempt(both, "write", 5, 2)).toBe(1);
    expect(intentKeyPrefix(5, 2, "write")).toBe("t68:s5:r2:write:a");
  });
});
