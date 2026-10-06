import { expect, test } from "bun:test";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { deliver } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { reviewSwapStep } from "../src/lib/scheduler-review-swap-runtime.js";
import { swappedSession } from "../src/lib/scheduler-review-swap.js";
import { H1, H2 } from "./scheduler-auto-helpers.js";
import { scenario } from "./scheduler-review-swap.test.js";

for (const field of ["headSHA", "specRev", "rev"] as const) {
  test(`FAM1a recovery: ${field} drift finishes retirement then replans current facts`, async () => {
    const p = await scenario(false, true, "codex");
    try {
      p.hello("Sekai");
      expect(await p.tick()).toMatchObject({ step: "waiting" });
      const id = String(p.swaps()[0].data.intentId), before = p.f.task();
      p.f.db.query(`UPDATE tasks SET ${field} = ? WHERE id = 'T1'`).run(field === "headSHA" ? H1 : before[field] + 1);
      expect(await p.tick()).toMatchObject({ step: "session" });
      expect(getIntent(p.f.db, id)?.status).toBe("done");
      expect(swappedSession(p.f.db, id).killReceipt).toBeTruthy();
      expect(listLendOrders(p.f.db, "T1")).toHaveLength(0);
      const plan = planScheduler(p.snapshot());
      if (field === "specRev") {
        expect(plan).toMatchObject({ kind: "escalate", code: "workflow_drift" });
        expect(await p.tick()).toMatchObject({ step: "manual" });
        const w = p.snapshot().workflow!;
        expect(await p.f.cli("pm", "workflow-resume", "T1", "--rev", String(p.f.task().rev), "--workflow-rev", String(w.rev),
          "--reason", "核对新版规格后恢复")).toMatchObject({ ok: true });
        expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
        expect(listLendOrders(p.f.db, "T1")[0]).toMatchObject({ head: H2, specRev: before.specRev + 1 });
      }
      else {
        expect(plan).toMatchObject({ kind: "intent", action: "review" });
        expect(await p.tick()).toMatchObject({ step: "pool_pooled" });
        expect(listLendOrders(p.f.db, "T1")[0]).toMatchObject({ head: field === "headSHA" ? H1 : H2, specRev: before.specRev });
      }
      expect(p.effects).toEqual(["archive:agent-rv-t1", "kill:agent-rv-t1"]);
      expect(p.swaps()).toHaveLength(1);
    } finally { p.f.close(); }
  });
}

test("FAM1a recovery: automatic binding cannot erase unacknowledged or automatic review history", async () => {
  const p = await scenario(false, true, "codex");
  try {
    const s = p.snapshot();
    for (const events of [
      s.events.map((e) => e.data.op === "workflow" ? { ...e, data: { ...e.data, mode: "auto" } } : e),
      s.events.filter((e) => e.data.op !== "workflow_resume"),
      s.events.map((e) => e.data.op === "workflow_resume" ? { ...e, data: { ...e.data, manual: false } } : e),
    ]) expect(planScheduler({ ...s, events })).toMatchObject({ kind: "escalate", code: "reviewer_replaced" });
    expect(planScheduler(s)).toMatchObject({ kind: "intent", action: "review_swap" });
  } finally { p.f.close(); }
});

test("FAM1a recovery: remote family facts follow done orders, merge heads and later local deliveries", async () => {
  const p = await scenario(false, false, "claude", "agent-task-one", true);
  try {
    const delivered = p.snapshot().events.findLast((e) => e.kind === "deliver")!;
    expect(p.snapshot().remoteAuthorFamily).toBeNull();
    expect(p.snapshot().workflow?.authorFamily).toBe("claude");
    p.f.db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
      status, leaseMs, eventSeq, createdBy, createdAt, updatedAt) VALUES ('remote-write', 'T1', 'p', 'Sekai', 'codex', 'fix', 1, 2, ?,
      'o/r', '{}', 'remote delivery', '', 'claimed', 600000, ?, 'scheduler', 1, 1)`, [H2, delivered.seq]);
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "wait", code: "author_family_evidence" });
    p.f.db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = 'remote-write'");
    expect(p.snapshot().remoteAuthorFamily).toBe("codex");
    expect(p.snapshot().workflow?.authorFamily).toBe("codex");
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
    p.f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["3".repeat(40)]);
    expect(p.snapshot().remoteAuthorFamily).toBe("codex");
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
    deliver(p.f.db, p.f.at("agent-task-one"), { taskId: "T1", headSHA: "3".repeat(40), text: "本机新交付" });
    expect(p.snapshot().remoteAuthorFamily).toBeNull();
    expect(p.snapshot().workflow?.authorFamily).toBe("claude");
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "escalate", code: "reviewer_independence" });
  } finally { p.f.close(); }
});

test("FAM1a recovery: a completed remote write releases the evidence wait and swaps through real ticks", async () => {
  const p = await scenario(false, false, "claude", "agent-task-one", true);
  try {
    const delivery = p.snapshot().events.findLast((e) => e.kind === "deliver")!;
    expect(await p.tick()).toMatchObject({ step: "waiting" });
    p.f.db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
      status, leaseMs, eventSeq, createdBy, createdAt, updatedAt) VALUES ('remote-write', 'T1', 'p', 'Sekai', 'claude', 'fix', 1, 2, ?,
      'o/r', '{}', 'remote delivery', '', 'done', 600000, ?, 'scheduler', 1, 1)`, [H2, delivery.seq]);
    expect(planScheduler(p.snapshot())).toMatchObject({ kind: "intent", action: "review_swap" });
    expect(await p.tick()).toMatchObject({ step: "waiting" });
    expect(await p.tick()).toMatchObject({ step: "session" });
    expect(p.swaps()).toHaveLength(1);
  } finally { p.f.close(); }
});

for (const hold of ["manual", "observe", "model_safety_hold", "model_refusal_retry", "model_refusal_exempt", "lease"] as const) {
  test(`FAM1a recovery: retirement after drift still respects ${hold}`, async () => {
    const p = await scenario();
    try {
      await p.tick();
      const id = String(p.swaps()[0].data.intentId);
      p.f.db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'");
      if (hold === "manual" || hold === "observe") p.f.db.run("UPDATE task_workflows SET mode = ? WHERE taskId = 'T1'", [hold]);
      else if (hold === "lease") p.state.lostLease = true;
      else insertEvent(p.f.db, p.f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", data: { op: hold } }, false);
      await expect(reviewSwapStep(p.f.db, p.f.at("scheduler"), id, 2, p.effectsDeps)).rejects.toThrow();
      expect(swappedSession(p.f.db, id).killReceipt).toBeNull();
      expect(p.effects).toEqual(["archive:agent-rv-t1"]);
    } finally { p.f.close(); }
  });
}

test("FAM1a recovery: remote delivery without completed family evidence waits across ticks", async () => {
  const p = await scenario(false, false, "claude", "agent-task-one", true);
  try {
    for (let n = 0; n < 3; n++) {
      expect(planScheduler(p.snapshot())).toMatchObject({ kind: "wait", code: "author_family_evidence" });
      expect(await p.tick()).toMatchObject({ step: "waiting" });
    }
    expect(p.effects).toEqual([]);
    expect(p.swaps()).toHaveLength(0);
  } finally { p.f.close(); }
});
