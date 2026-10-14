/** Shared synthetic fixtures for `features/{id}/task-facts`. The center (SUBDAG9) runs these same values instead of its own copy:
 * it loads `TASK_FACTS_SCENARIO.input`, then compares its answer with `TASK_FACTS_SCENARIO.expected`. Synthetic ids only.
 */
import type { SharedLedgerTaskFacts } from "./shared-ledger-contract-task-facts.js";

const t0 = 1_790_000_000_000;
/** Keys in contract order: a parsed response re-serializes byte-identical. */
export const TASK_FACTS_FIXTURE: SharedLedgerTaskFacts = {
  schemaVersion: 1, teamId: "team-a", projectId: "project-a", featureId: "feature-a", serverSeq: 40,
  tasks: [
    // build: stage → review → note; note is not a fact kind, and the old home's later event does not count.
    { taskId: "task-build-a", stageSince: t0 + 100, doneAt: null, lastEvent: { at: t0 + 200, kind: "review" } },
    // done: the second stage event is the move into done; a done card carries no stage time or last event.
    { taskId: "task-done-a", stageSince: null, doneAt: t0 + 50, lastEvent: null },
    // spec: no events yet.
    { taskId: "task-spec-a", stageSince: null, doneAt: null, lastEvent: null },
    // build without any stage event: stage time unknown, the last event still shows.
    { taskId: "task-build-b", stageSince: null, doneAt: null, lastEvent: { at: t0 + 500, kind: "deliver" } },
  ],
};

interface TaskFactsSourceEvent { sourceInstanceId: string; sourceSeq: number; sourceTaskId: string; type: string; at: number }
export const TASK_FACTS_SCENARIO: {
  input: { homeInstanceId: string; tasks: { taskId: string; sourceTaskId: string; stage: string }[]; events: TaskFactsSourceEvent[] };
  expected: SharedLedgerTaskFacts;
} = {
  input: {
    homeInstanceId: "instance-home",
    tasks: [
      { taskId: "task-build-a", sourceTaskId: "source-build-a", stage: "build" },
      { taskId: "task-done-a", sourceTaskId: "source-done-a", stage: "done" },
      { taskId: "task-spec-a", sourceTaskId: "source-spec-a", stage: "spec" },
      { taskId: "task-build-b", sourceTaskId: "source-build-b", stage: "build" },
    ],
    events: [
      { sourceInstanceId: "instance-home", sourceSeq: 1, sourceTaskId: "source-done-a", type: "stage", at: t0 + 10 },
      { sourceInstanceId: "instance-home", sourceSeq: 2, sourceTaskId: "source-done-a", type: "stage", at: t0 + 50 },
      { sourceInstanceId: "instance-home", sourceSeq: 3, sourceTaskId: "source-build-a", type: "stage", at: t0 + 100 },
      { sourceInstanceId: "instance-home", sourceSeq: 4, sourceTaskId: "source-build-a", type: "review", at: t0 + 200 },
      { sourceInstanceId: "instance-home", sourceSeq: 5, sourceTaskId: "source-build-a", type: "note", at: t0 + 300 },
      // A former home of the same feature: never a fact, even when newer.
      { sourceInstanceId: "instance-old-home", sourceSeq: 90, sourceTaskId: "source-build-a", type: "deploy", at: t0 + 400 },
      { sourceInstanceId: "instance-home", sourceSeq: 6, sourceTaskId: "source-build-b", type: "deliver", at: t0 + 500 },
    ],
  },
  expected: TASK_FACTS_FIXTURE,
};

const row = TASK_FACTS_FIXTURE.tasks[0]!;
const withRow = (patch: Record<string, unknown>) => ({ ...TASK_FACTS_FIXTURE, tasks: [{ ...row, ...patch }] });
/** Every one must fail closed (invalid_field). */
export const TASK_FACTS_INVALID_RESPONSES: Record<string, unknown> = {
  topLevelExtraKey: { ...TASK_FACTS_FIXTURE, truncated: false },
  rowActor: withRow({ actor: "worker-a" }),
  rowText: withRow({ text: "原文" }),
  lastEventSummary: withRow({ lastEvent: { ...row.lastEvent!, summary: "摘要" } }),
  duplicateTaskId: { ...TASK_FACTS_FIXTURE, tasks: [row, row] },
  doneWithStageSince: withRow({ doneAt: t0 + 600, lastEvent: null }),
  kindNotAllowed: withRow({ lastEvent: { at: t0, kind: "note" } }),
  atZero: withRow({ lastEvent: { at: 0, kind: "stage" } }),
  atFraction: withRow({ lastEvent: { at: t0 + 0.5, kind: "stage" } }),
  schemaVersion2: { ...TASK_FACTS_FIXTURE, schemaVersion: 2 },
  tooManyTasks: { ...TASK_FACTS_FIXTURE, tasks: Array.from({ length: 1001 }, (_, i) => ({ ...row, taskId: `task-${i}` })) },
};

/** An old center has no task-facts route: its router falls through to forbidden, so the path answers 403 (not 404). */
export const TASK_FACTS_OLD_CENTER_STATUS = 403;
