import { expect, test } from "bun:test";
import { readTask } from "../src/shared-ledger/exec-tasks";
import { saveRow } from "../src/shared-ledger/exec-tasks/storage";
import { applyDagVersion, readDag } from "../src/shared-ledger/exec-workflows";
import { command, fixtureTask, harness, nodes, unchanged, type Harness } from "./shared-ledger-v2-workflows-harness.test";

const init = (h: Harness) => h.run(command("dag.init", { nodes }));
const bind = (payload: Record<string, unknown> = {}, requestId?: string) =>
  command("dag.bind", { nodeKey: "a", taskId: "task", baseVersion: 1, expectedRev: 2, expectedTaskRev: 1, ...payload }, requestId);
const rewrite = (h: Harness, dagNodes: unknown[], bindings: unknown[], requestId = "rewrite") => {
  const f = h.featureRow();
  return h.run(command("dag.rewrite", { expectedRev: f.rev, baseVersion: f.currentVersion,
    dag: { version: f.currentVersion + 1, nodes: dagNodes, bindings } }, requestId));
};
/** Bind node a to task, then complete it with a review conclusion directly in X1's row. */
function doneBinding(h: Harness) {
  init(h); h.run(bind());
  h.tx(ctx => {
    const t = readTask(ctx, "task");
    saveRow(ctx, "tasks", { ...t, stage: "done", rev: t.rev + 1, updatedAt: 2000,
      review: { verdict: "pass", reviewedHead: t.head, reportArtifactId: "artifact" } }, t.rev);
  });
}

test("dag.init writes version 1 for an execution feature and rejects cycles, stale revs and planning features", () => {
  const h = harness();
  unchanged(h, () => h.run(command("dag.init", { nodes: [{ ...nodes[0], deps: ["c"] }, { ...nodes[2], deps: ["a"] }] })), "invalid_field");
  unchanged(h, () => h.run(command("dag.init", { nodes, expectedRev: 2 })), "conflict");
  const receipt = init(h);
  expect(receipt.result).toMatchObject({ entityId: "feature", rev: 2, version: 1 });
  expect(h.featureRow()).toMatchObject({ rev: 2, currentVersion: 1 });
  expect(h.tx(ctx => readDag(ctx, "feature", 1))).toEqual({ version: 1, nodes, bindings: [] });
  unchanged(h, () => h.run(command("dag.init", { nodes, expectedRev: 2 }, "again")), "conflict");
  const p = harness(); p.putFeature({ authorityMode: "planning" });
  unchanged(p, () => init(p), "execution_not_shared");
});

test("dag.bind updates feature.rev, task.rev and the binding row in one transaction", () => {
  const h = harness();
  init(h);
  const receipt = h.run(bind());
  expect(receipt.result).toMatchObject({ entityId: "feature", rev: 3, version: 1 });
  expect(h.featureRow().rev).toBe(3);
  expect(h.tx(ctx => readTask(ctx, "task"))).toMatchObject({ rev: 2, updatedAt: 2000 });
  expect(h.row("exec_dag_bindings")).toEqual([{ teamId: "team", projectId: "project", featureId: "feature", nodeKey: "a",
    taskId: "task", boundVersion: 1, boundBy: "person", boundAt: 2000 }]);
  expect(h.tx(ctx => readDag(ctx, "feature", 1)).bindings).toEqual([{ nodeKey: "a", taskId: "task" }]);
  expect(h.row("exec_events").length).toBe(2);
  expect(h.run(bind())).toEqual(receipt);
});

test("a stale feature.rev or task.rev rolls the whole bind back", () => {
  const h = harness();
  init(h);
  unchanged(h, () => h.run(bind({ expectedRev: 1 })), "conflict");
  unchanged(h, () => h.run(bind({ expectedTaskRev: 2 })), "conflict");
  unchanged(h, () => h.run(bind({ baseVersion: 2 })), "conflict");
  // Concurrent task write between read and write: the X1 row CAS fails after the feature row was already updated.
  h.deps.task = (ctx, id) => ({ ...readTask(ctx, id) });
  const save = h.deps.saveTask;
  h.deps.saveTask = (ctx, next, expectedRev) => save(ctx, next, expectedRev + 1);
  unchanged(h, () => h.run(bind()), "conflict");
  h.deps.saveTask = save;
  expect(h.featureRow().rev).toBe(2);
  expect(h.row("exec_dag_bindings")).toEqual([]);
});

test("faults after the feature or task write and in the binding insert leave nothing behind", () => {
  const h = harness();
  init(h);
  for (const fault of ["afterFeature", "afterTask"]) {
    h.faults.add(fault);
    unchanged(h, () => h.run(bind()), `injected after ${fault === "afterFeature" ? "feature" : "task"} write`);
    h.faults.clear();
  }
  // A card already bound to another node is refused; the UNIQUE(taskId) binding row backs the same rule.
  h.db.run("INSERT INTO exec_dag_bindings VALUES ('team','project','feature','c','task',1,'person',1)");
  unchanged(h, () => h.run(bind()), "conflict");
  h.db.run("DELETE FROM exec_dag_bindings");
  h.run(bind());
  unchanged(h, () => h.run(bind({ expectedRev: 3, expectedTaskRev: 2, nodeKey: "a", taskId: "task-two" }, "taken")), "conflict");
});

test("bind only accepts a card of the same project, feature and home", () => {
  const h = harness();
  init(h);
  h.tx(ctx => {
    saveRow(ctx, "tasks", fixtureTask({ id: "other-feature", featureId: "feature-two" }));
    saveRow(ctx, "tasks", fixtureTask({ id: "other-home", homeInstanceId: "peer-b" }));
  });
  unchanged(h, () => h.run(bind({ taskId: "other-feature" })), "conflict");
  unchanged(h, () => h.run(bind({ taskId: "other-home" })), "conflict");
  unchanged(h, () => h.run(bind({ taskId: "missing" })), "not_found");
  unchanged(h, () => h.run(bind({ nodeKey: "missing" })), "conflict");
  h.deps.task = () => fixtureTask({ projectId: "other" });
  unchanged(h, () => h.run(bind()), "forbidden");
});

test("a completed node is inherited unchanged: state, card id and conclusion survive a rewrite", () => {
  const h = harness();
  doneBinding(h);
  const doneTask = h.tx(ctx => readTask(ctx, "task"));
  const bindings = [{ nodeKey: "a", taskId: "task" }];
  unchanged(h, () => rewrite(h, [{ ...nodes[0], oneLine: "改写" }, nodes[1], nodes[2]], bindings), "conflict");
  unchanged(h, () => rewrite(h, [{ ...nodes[0], deps: ["c"] }, nodes[1], nodes[2]], bindings), "conflict");
  unchanged(h, () => rewrite(h, [nodes[2]], []), "conflict");
  unchanged(h, () => rewrite(h, nodes, []), "conflict");
  unchanged(h, () => rewrite(h, nodes, [{ nodeKey: "a", taskId: "task-two" }]), "conflict");
  unchanged(h, () => rewrite(h, nodes, [...bindings, { nodeKey: "c", taskId: "task-two" }]), "conflict");
  const next = [{ ...nodes[0], deps: [], fileGlobs: [...nodes[0].fileGlobs] }, { ...nodes[2], oneLine: "c 改" },
    { key: "d", oneLine: "新节点", deps: ["a"], fileGlobs: [], estimate: "" }];
  const receipt = rewrite(h, next, bindings);
  expect(receipt.result).toMatchObject({ version: 2 });
  expect(h.tx(ctx => readDag(ctx, "feature", 2))).toEqual({ version: 2, nodes: next, bindings });
  expect(h.tx(ctx => readTask(ctx, "task"))).toEqual(doneTask);
  expect(h.featureRow()).toMatchObject({ currentVersion: 2 });
});

test("an approved version may cancel open bound nodes but never a completed one", () => {
  const h = harness();
  doneBinding(h);
  h.run(bind({ nodeKey: "c", taskId: "task-two", expectedRev: 3 }, "bind-c"));
  const apply = (cancels: string[], dagNodes = nodes) => h.tx(ctx => applyDagVersion(ctx, h.deps, h.deps.feature(ctx, "feature"), dagNodes, cancels));
  unchanged(h, () => apply(["a"], [nodes[2]]), "conflict");
  unchanged(h, () => apply(["b"]), "invalid_field");
  unchanged(h, () => apply([], [nodes[0], nodes[1]]), "conflict");
  const result = apply(["c"], [nodes[0], nodes[1]]);
  expect(result.dag.bindings).toEqual([{ nodeKey: "a", taskId: "task" }]);
  expect(h.row("exec_dag_bindings").map(r => r.taskId)).toEqual(["task"]);
  expect(h.tx(ctx => readTask(ctx, "task")).stage).toBe("done");
});
