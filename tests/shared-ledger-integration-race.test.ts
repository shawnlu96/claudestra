import { expect, test } from "bun:test";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart } from "../src/lib/dag-tools-steps.js";
import { setFeature } from "../src/lib/ledger-feature-write.js";
import { queueLocalStart, retryQueuedLocalStarts, clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { getTask } from "../src/lib/ledger-store.js";

test("closing the gate after preflight blocks the write and the first start side effect", async () => {
  const f = integrationFixture();
  try {
    const pre = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# C5 spec\n模板：code\n" });
    expect(pre.ok).toBe(true);
    if (!pre.ok || "already" in pre) throw new Error("expected new plan");
    await f.mode(true);
    expect(() => setFeature(f.db, { actor: f.actor }, { id: f.id, rev: f.feature().rev, patch: { title: "Late edit" } })).toThrow("共享规划");
    expect(await runStart(f.io, pre.plan)).toMatchObject({ ok: false, failedStep: "task-new" });
    expect(f.calls).toEqual([]);
    expect(getTask(f.db, pre.plan.taskId)).toBeNull();
  } finally { await f.close(); }
});

test("gate closes during worktree preparation: no process starts, rollback can cancel the new card", async () => {
  const f = integrationFixture();
  try {
    const pre = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# C5 spec\n模板：code\n" });
    if (!pre.ok || "already" in pre) throw new Error(JSON.stringify(pre));
    let checked = false;
    const out = await runStart({ ...f.io, git: async (cwd, args, timeout) => {
      if (!checked && args[0] === "worktree") { checked = true; await f.mode(true); }
      return f.io.git(cwd, args, timeout);
    } }, pre.plan);
    expect(out).toMatchObject({ ok: false });
    expect(f.calls.some(c => c[0] === "create")).toBe(false);
    expect(getTask(f.db, pre.plan.taskId)?.stage).toBe("cancelled");
  } finally { await f.close(); }
});


test("a queued start rechecks durable authority after the queue admits it", async () => {
  const f = integrationFixture();
  try {
    const pre = await preflightStart(f.startEnv, { featureId: f.id, key: "next", spec: "# queued spec" });
    if (!pre.ok || "already" in pre) throw new Error(JSON.stringify(pre));
    let outcome: unknown;
    await queueLocalStart(f.io, pre.plan, { queuedReady: async () => null, queuedNotice: async () => {} }, "fake occupied slot", async () => {
      outcome = await runStart(f.io, pre.plan);
      return outcome as Awaited<ReturnType<typeof runStart>>;
    });
    await f.mode(true);
    await retryQueuedLocalStarts();
    expect(outcome).toMatchObject({ ok: false, failedStep: "task-new", error: expect.stringContaining("共享规划") });
    expect(f.calls.some(c => c[0] === "create" || c[1] === "task-new")).toBe(false);
  } finally { clearQueuedLocalStarts(); await f.close(); }
});
