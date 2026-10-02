import { expect, test } from "bun:test";
import {
  parseTask, parseItem, parseDependency, parseReceipt, parseEvent, parseFeature, parseWorkflow, V2ContractError,
  type V2TransactionContext,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { readTask, readEvents } from "../src/shared-ledger/exec-tasks";
import { saveRow } from "../src/shared-ledger/exec-tasks/storage";
import { command, harness, fixtureTask } from "./shared-ledger-v2-tasks-harness.test";

function unchanged(h: ReturnType<typeof harness>, fn: () => unknown, code: string) {
  const before = h.snapshot(); expect(fn).toThrow(code); expect(h.snapshot()).toEqual(before);
}
test("member creates spec task, edits planning and item description without changing source words", () => {
  const h = harness();
  const created = h.run(command("task.new"));
  const t = h.tx(ctx => readTask(ctx, created.result.entityId));
  expect(t.stage).toBe("spec"); expect(t.homeInstanceId).toBe("local"); expect(t.rev).toBe(1);
  expect(t.executor).toBeNull(); expect(t.head).toBeNull();
  const receipt = h.run(command("task.set", { patch: { title: "Updated", plan: "Plan" } }));
  expect(receipt.result.rev).toBe(2); expect(h.task().title).toBe("Updated");
  const item = h.run(command("item.new")); expect(item.result.rev).toBe(1);
  h.run(command("item.set", { description: "Member clarification" }));
  const saved = h.db.query("SELECT * FROM items WHERE id='item'").get() as Record<string, unknown>;
  expect(parseItem(saved).ownerWords).toBe(""); expect(saved.descriptionBy).toBe("person");
  expect(h.tx(ctx => readEvents(ctx)).map(parseEvent)).toHaveLength(4);
  expect(parseReceipt(receipt).serverSeq).toBe(2);
});
test("white lists reject extra and unknown nested DTO/command fields before any writes", () => {
  const h = harness();
  for (const [table, fixture, parser] of [
    ["items", V2_DTO_FIXTURES.item, parseItem], ["tasks", V2_DTO_FIXTURES.task, parseTask],
    ["task_deps", V2_DTO_FIXTURES.dependency, parseDependency],
  ] as const) {
    for (const key of ["extra", "unknown"]) {
      const raw = { ...fixture.valid as object, [key]: { local: "metadata" } };
      expect(() => parser(raw)).toThrow("invalid_field");
      unchanged(h, () => h.tx(ctx => saveRow(ctx, table, raw as never)), "invalid_field");
    }
  }
  for (const field of ["stage", "head", "homeInstanceId", "executor", "authorizationAskId", "mode", "workflow", "specRev"]) {
    const c = command("task.set");
    unchanged(h, () => h.run({ ...c, payload: { ...c.payload, patch: { title: "x", [field]: "x" } } }), "invalid_field");
  }
  unchanged(h, () => h.run({ ...command("task.assign"), actor: { role: "owner" } }), "invalid_field");
  unchanged(h, () => h.run({ ...command("task.new"), payload: { ...command("task.new").payload, extra: {} } }), "invalid_field");
});
test("stage CAS rejects every stale coordinate; blocked/round/specRev use canonical stage rules", () => {
  const h = harness();
  const base = { from: "spec", to: "restate", round: 0 };
  for (const changed of [{ expectedRev: 2 }, { expectedSpecRev: 2 }, { from: "build" }, { round: 1 }, { expectedWorkflowRev: 2 }]) {
    unchanged(h, () => h.run(command("task.stage", { ...base, ...changed })), "conflict");
  }
  const first = h.run(command("task.stage", base)); expect(first.result.rev).toBe(2);
  h.run(command("task.stage", { from: "restate", to: "build", round: 0, expectedRev: 2 }, "build"));
  h.run(command("task.stage", { from: "build", to: "blocked", round: 0, expectedRev: 3 }, "block"));
  expect(h.task().stageBefore).toBe("build");
  h.run(command("task.stage", { from: "blocked", to: "build", round: 0, expectedRev: 4 }, "resume"));
  h.run(command("task.stage", { from: "build", to: "review", round: 0, expectedRev: 5 }, "review"));
  expect(h.task().round).toBe(1); expect(h.task().stageBefore).toBeNull();
  h.run(command("task.stage", { from: "review", to: "spec", round: 1, expectedRev: 6 }, "respec"));
  expect(h.task().specRev).toBe(2);
  unchanged(h, () => h.run(command("task.stage", { ...base, expectedRev: 7, round: 1 }, "stale-spec")), "conflict");
});
test("distinct execution actions require explicit action and role grants and home; workers cannot mutate whole cards", () => {
  const h = harness();
  for (const type of ["task.assign", "task.stage", "task.deliver", "task.review"] as const) {
    const c = command(type);
    unchanged(h, () => h.run(c, { ...h.scope, actor: { ...h.scope.actor, actions: ["task.set"] } }), "forbidden");
    h.denied.add(`role:${type}`); unchanged(h, () => h.run(c), "forbidden"); h.denied.clear();
    unchanged(h, () => h.run(c, { ...h.scope, actor: { ...h.scope.actor, instanceId: "peer-a" } }), "wrong_home");
    unchanged(h, () => h.run(c, { ...h.scope, actor: { ...h.scope.actor, kind: "service", serviceId: "worker",
      representedPersonId: "person", orderId: "order" } }), "forbidden");
  }
  h.run(command("task.assign", { executor: { kind: "peer_agent", instanceId: "peer-a", agentId: "worker" } }));
  expect(h.task().homeInstanceId).toBe("local"); expect(h.task().executorInstanceId).toBe("peer-a");
  expect(h.calls).toContain("role:task.assign");
});
test("feature mode/fence, workflow drift, and illegal transitions fail closed", () => {
  const h = harness();
  for (const [field, value, error] of [["serviceGeneration", 2, "stale_generation"], ["epoch", 2, "stale_epoch"],
    ["bootId", "old-boot", "stale_epoch"], ["projectId", "other", "forbidden"]] as const) {
    unchanged(h, () => h.run({ ...command("task.set"), [field]: value }), error);
  }
  unchanged(h, () => h.run(command("task.stage", { from: "spec", to: "done", round: 0 })), "conflict");
  const feature = parseFeature(V2_DTO_FIXTURES.feature.valid);
  h.put("feature", "feature", feature);
  unchanged(h, () => h.run(command("task.set")), "execution_not_shared");
  h.put("feature", "feature", { ...feature, authorityMode: "execution", epoch: 2 });
  unchanged(h, () => h.run(command("task.set")), "stale_epoch");
  h.put("feature", "feature", { ...feature, authorityMode: "execution" });
  h.put("workflow", "task", { ...parseWorkflow(V2_DTO_FIXTURES.workflow.valid), specRev: 2 });
  unchanged(h, () => h.run(command("task.assign")), "conflict");
});
test("task.spec advances specRev independently and invalidates old CAS and review evidence", () => {
  const h = harness(); h.run(command("task.spec"));
  expect(h.task().specRev).toBe(2); expect(h.task().rev).toBe(2);
  unchanged(h, () => h.run(command("task.set", { expectedRev: 2 }, "old-spec")), "conflict");
});
test("row, revision history, event and immutable receipt roll back on every failure boundary", () => {
  for (const table of ["exec_task_versions", "exec_events", "exec_command_receipts"]) {
    const h = harness();
    h.db.exec(`CREATE TRIGGER break_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    unchanged(h, () => h.run(command("task.set")), "injected failure");
  }
  const h = harness();
  unchanged(h, () => h.tx(ctx => { h.domain.applyInTransaction(ctx, command("task.set")); throw Error("other domain failed"); }), "other domain failed");
  h.tx(ctx => { expect(h.db.inTransaction).toBe(true); h.domain.applyInTransaction(ctx, command("task.set")); expect(h.db.inTransaction).toBe(true); });
  for (const table of ["exec_task_versions", "exec_events", "exec_command_receipts"]) {
    expect(() => h.db.run(`DELETE FROM ${table}`)).toThrow("immutable");
    expect(() => h.db.run(`UPDATE ${table} SET teamId='other'`)).toThrow("immutable");
  }
});
test("replay returns original receipt without new writes and rejects request reuse or revoked authorization", () => {
  const h = harness(), c = command("task.set"), receipt = h.run(c), before = h.snapshot();
  expect(h.run(c)).toEqual(receipt); expect(h.snapshot()).toEqual(before);
  unchanged(h, () => h.run(command("task.set", { patch: { title: "Different" } })), "dedup_mismatch");
  h.denied.add("task.set"); unchanged(h, () => h.run(c), "forbidden");
  h.denied.clear();
  unchanged(h, () => h.run(c, { ...h.scope, actor: { ...h.scope.actor, kind: "service", serviceId: "service", representedPersonId: "person" } }), "dedup_mismatch");
});
test("forged or expired contexts cannot write; cross-project reads reveal no rows", () => {
  const h = harness();
  expect(() => h.domain.applyInTransaction({} as V2TransactionContext, command("task.set"))).toThrow(V2ContractError);
  let leaked!: V2TransactionContext;
  h.tx(ctx => { leaked = ctx; });
  expect(() => h.domain.applyInTransaction(leaked, command("task.set"))).toThrow("transaction_closed");
  expect(() => h.tx(ctx => readTask(ctx, "task"), { ...h.scope, projectId: "other", actor: { ...h.scope.actor, projects: ["other"] } })).toThrow("not_found");
});
test("dependencies follow prerequisite-to-dependent, reject cycles/cross-project and retain monotonic CAS after removal", () => {
  const h = harness();
  h.run(command("dep.set"));
  expect(parseDependency(h.db.query("SELECT * FROM task_deps").get()).fromTask).toBe("task");
  h.run(command("dep.set", { fromTask: "task-two", toTask: "task-three", expectedRev: 0 }, "second"));
  unchanged(h, () => h.run(command("dep.set", { fromTask: "task-three", toTask: "task", expectedRev: 0 }, "cycle")), "conflict");
  unchanged(h, () => h.run(command("dep.set", { toTask: "missing", expectedRev: 0 }, "absent")), "not_found");
  h.db.run("UPDATE tasks SET projectId='other' WHERE id='task-three'");
  unchanged(h, () => h.run(command("dep.set", { toTask: "task-three", expectedRev: 0 }, "cross")), "not_found");
  h.run(command("dep.remove"));
  unchanged(h, () => h.run(command("dep.set", {}, "stale-add")), "conflict");
  const readded = h.run(command("dep.set", { expectedRev: 2 }, "readd")); expect(readded.result.rev).toBe(3);
});
test("DTO nested JSON round trips without exposing extra columns", () => {
  const h = harness(); expect(h.tx(ctx => readTask(ctx, "task"))).toEqual(fixtureTask());
});
test("async policy callbacks and revoked task-specific retry grants cannot bypass authorization", () => {
  const h = harness(), c = command("task.set"); h.run(c);
  h.denied.add("role:task.set"); unchanged(h, () => h.run(c), "forbidden"); h.denied.clear();
  h.deps.authorizeTask = async () => {};
  unchanged(h, () => h.run(command("task.set", { expectedRev: 2 }, "async-role")), "transaction_control");
  h.deps.authorize = async () => {};
  unchanged(h, () => h.run(command("item.new")), "transaction_control");
});
test("two commands from the same revision cannot silently merge planning changes", () => {
  const h = harness();
  h.run(command("task.set", { patch: { title: "First" } }, "first"));
  unchanged(h, () => h.run(command("task.set", { patch: { plan: "Second" } }, "second")), "conflict");
  expect(h.task().title).toBe("First"); expect(h.task().plan).toBe("");
});
