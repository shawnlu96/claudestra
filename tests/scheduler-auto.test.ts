import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { CLAIM_LEASE_MS } from "../src/lib/scheduler-dispatch.js";
import { autoFixture, H1, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";

describe("T68f auto mode: the full code flow on mock workers", () => {
  test("write → review(changes) → fix → review(pass) → merge intent, cross-family reviewer, one slot, no duplicate sends", async () => {
    const f = autoFixture();
    try {
      expect(await f.tick()).toMatchObject({ step: "session", detail: "author = agent-task-one" });
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(f.sent.map((s) => [s.agent, s.route])).toEqual([["agent-task-one", "channel"]]);
      expect(f.sent[0].text).toContain("T1 · restate");
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "等待 PM 放行复述" });
      expect((await f.cli("pm", "restate-approve", "T1")).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "restate→build" });
      expect(f.task().stage).toBe("build");

      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(f.sent.at(-1)?.text).toContain("T1 · write");
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.sent).toHaveLength(2);
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);

      expect(await f.tick()).toMatchObject({ step: "session", detail: "reviewer = agent-rv-t1" });
      expect(f.ensured).toEqual([{ role: "author", family: "claude" }, { role: "reviewer", family: "codex" }]);
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
      expect(f.sent.at(-1)).toMatchObject({ agent: "agent-rv-t1", route: "acp" });
      expect(f.sent.at(-1)?.text).toContain(`--head ${H1} --session s-rv --family codex`);
      await f.tick();
      expect(f.sent).toHaveLength(3);

      expect((await f.review("changes", H1, [P1, P2])).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(f.sent.at(-1)?.text).toContain("two ticks claim the same intent");
      const slots = f.db.query("SELECT resource FROM scheduler_resources WHERE resource LIKE 'slot:%'").all();
      expect(slots).toEqual([{ resource: "slot:p:0" }]);

      await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
      expect(f.sent.at(-1)).toMatchObject({ agent: "agent-rv-t1", sessionId: "s-rv" });
      expect((await f.review("pass", H2, [P2])).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(await f.tick()).toMatchObject({ step: "merge_queue" });
      expect(await f.tick()).toMatchObject({ step: "merge_queue", detail: "合并意图 pending" });

      expect(f.sent.map((s) => s.agent)).toEqual(["agent-task-one", "agent-task-one", "agent-rv-t1", "agent-task-one", "agent-rv-t1"]);
      expect(f.intents().map((i) => `${i.action}:${i.status}`)).toEqual([
        "ensure_session:done", "dispatch:done", "stage:done", "dispatch:done", "ensure_session:done", "review:done",
        "stage:done", "dispatch:done", "review:done", "stage:done", "merge:pending"]);
      const moves = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "stage").map((e) => `${e.actor}:${e.data.from}>${e.data.to}`);
      expect(moves).toEqual(["agent-task-one:spec>restate", "scheduler:restate>build", "agent-task-one:build>review", "scheduler:review>fix",
        "agent-task-one:fix>review", "scheduler:review>merge"]);
      expect(f.notices).toEqual([]);
    } finally { f.close(); }
  });

  test("a lost reply leaves the order unknown and it is never resent; a refused send is replanned under a new key", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      f.setSend("lost");
      expect(await f.tick()).toMatchObject({ step: "held", detail: "答复丢了" });
      expect(f.intents().at(-1)).toMatchObject({ action: "dispatch", status: "unknown" });
      f.setSend("ok");
      for (let i = 0; i < 3; i++) expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("外部结果不明") });
      expect(f.sent).toHaveLength(2);
    } finally { f.close(); }
    const g = autoFixture();
    try {
      await toBuild(g);
      g.setSend("refuse");
      expect(await g.tick()).toMatchObject({ step: "replan", detail: "bridge 拒收" });
      expect(g.intents().at(-1)).toMatchObject({ action: "dispatch", status: "cancelled" });
      g.setSend("ok");
      expect(await g.tick()).toMatchObject({ step: "sent" });
      expect(g.intents().at(-1)?.id).toMatch(/:write:a1$/);
      expect(g.sent).toHaveLength(2);
    } finally { g.close(); }
  });

  test("claimed but unsent after a restart: held inside the lease, unknown after it, never resent", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      // A tick that died right after the claim: plan + claim through the CLI, no send.
      const { planScheduler } = await import("../src/lib/scheduler-plan.js");
      const { autoSnapshot } = await import("../src/lib/scheduler-auto-snapshot.js");
      const plan = planScheduler(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 }));
      if (plan.kind !== "intent") throw new Error("expected an intent");
      const seq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
      expect((await f.cli("scheduler", "scheduler-plan", "T1", "--id", plan.id, "--rev", String(f.task().rev), "--workflow-rev", "1", "--seq", String(seq),
        "--node", plan.node, "--action", plan.action, "--reason", plan.reason, "--recipient", plan.recipient!, "--resources", plan.resources.join(","))).ok).toBe(true);
      expect((await f.cli("scheduler", "scheduler-settle", plan.id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).ok).toBe(true);
      expect(await f.tick()).toMatchObject({ step: "held", detail: "另一轮已认领，租约未到期" });
      f.advance(CLAIM_LEASE_MS + 1);
      expect(await f.tick()).toMatchObject({ step: "held", detail: "claimed_without_receipt" });
      expect(f.intents().at(-1)).toMatchObject({ id: plan.id, status: "unknown" });
      expect(await f.tick()).toMatchObject({ step: "held" });
      expect(f.sent).toHaveLength(1); // only the restate order
    } finally { f.close(); }
  });

  test("Codex quota failure on the review order escalates to PM once; nothing is resent", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      await f.tick();
      await f.tick();
      const review = f.intents().at(-1)!;
      expect(review).toMatchObject({ action: "review", status: "done" });
      f.acpState.lastFailure = { failure: { kind: "quota", key: "q1", message: "usage limit reached" }, afterKey: review.id };
      expect(await f.tick()).toMatchObject({ step: "manual", detail: "agent-rv-t1 撞额度：usage limit reached" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(f.notices).toHaveLength(1);
      expect(await f.tick()).toBeUndefined(); // no longer an auto card
      expect(f.sent.filter((s) => s.agent === "agent-rv-t1")).toHaveLength(1);
    } finally { f.close(); }
  });

  test("a lost session only holds the card with the reason; it is not re-dispatched or taken from PM", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      f.live["agent-task-one"] = "offline";
      for (let i = 0; i < 3; i++) expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("agent-task-one 不在线") });
      expect(f.sent).toHaveLength(2);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
      f.live["agent-task-one"] = "busy";
      expect(await f.tick()).toMatchObject({ step: "waiting" });
    } finally { f.close(); }
  });

  test("a card without a named executor, or a reviewer of the author's family, goes back to PM", async () => {
    const f = autoFixture({ reviewerRuntime: "claude-code" });
    try {
      f.tickDeps.ensure = async (task, role, family) => role === "author"
        ? { kind: "ready", created: false, ref: { taskId: task.id, role, agent: "agent-task-one", sessionId: "s-one", family, transport: "tmux" } }
        : { kind: "manual", reason: "agent-rv-t1 的 runtime（claude-code）不是要求的 codex 家族" };
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("不是要求的 codex 家族") });
      expect(f.notices[0]).toContain("T1 退回人工");
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    } finally { f.close(); }
  });
});
