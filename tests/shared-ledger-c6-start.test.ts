import { expect, test } from "bun:test";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart } from "../src/lib/dag-tools-steps.js";
import { getTask } from "../src/lib/ledger-store.js";

test("task-new carries the feature through manager and rechecks after the outer gate", async () => {
  const f = integrationFixture();
  try {
    const pre = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# Migration start\n模板：code\n" });
    if (!pre.ok || "already" in pre) throw new Error("expected a new plan");
    let switched = false;
    const out = await runStart({ ...f.io, manager: async (args) => {
      if (args[0] === "ledger" && args[1] === "task-new") { switched = true; await f.mode(true); }
      return f.io.manager(args);
    } }, pre.plan);
    expect(switched).toBe(true);
    expect(out).toMatchObject({ ok: false, failedStep: "task-new", error: expect.stringContaining("共享规划") });
    expect(getTask(f.db, pre.plan.taskId)).toBeNull();
    expect(f.calls.some((args) => args[0] === "create")).toBe(false);
  } finally { await f.close(); }
});
