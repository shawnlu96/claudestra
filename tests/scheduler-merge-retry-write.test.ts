/** i28-MR1 [验收线 7]：写入侧（planIntent 事务）与 planner 共用 mergeRetryReleased——放行后接受新合并意图，没放行照旧拒绝。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";

test("write path: a cancelled merge is retried only after PM merge_resolve failed + workflow_resume, once per release", () => {
  const dir = mkdtempSync(join(tmpdir(), "mr1-write-"));
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  const owner = { actor: "owner", now: 10 };
  const head = "a".repeat(40);
  try {
    createTask(db, owner, { project: "p", id: "T1", title: "merge retry", kind: "code", agent: "agent-author" });
    const workflow = setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2,
      mode: "auto", authorFamily: "claude", fallback: "manual" }).workflow;
    const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
    const add = (actor: string, kind: string, data: unknown) => db.prepare(
      "INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,?,?,?,?,?)").run(actor, "p", "T1", kind, "", JSON.stringify(data));
    const merge = (id: string) => planIntent(db, { actor: "scheduler" }, { id, taskId: "T1", taskRev: 1,
      workflowRev: workflow.rev, causalSeq: seq(), node: "merge_deploy", action: "merge", reason: "merge" });
    db.query("UPDATE tasks SET stage = 'merge', round = 1, headSHA = ? WHERE id = 'T1'").run(head);
    add("owner", "stage", { from: "build", to: "review", round: 1 });
    planIntent(db, { actor: "scheduler" }, { id: "review", taskId: "T1", taskRev: 1, workflowRev: workflow.rev, causalSeq: seq(),
      node: "adversarial_review", action: "review", reason: "review", recipient: "agent-review" });
    settleIntent(db, { actor: "scheduler" }, { id: "review", from: "pending", to: "submitted", receipt: "ack" });
    add("agent-review", "review", { round: 1, head, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "session-review",
      reviewerFamily: "codex", path: "report.md", findings: [], p0: 0, p1: 0, p2: 0 });
    settleIntent(db, { actor: "scheduler" }, { id: "review", from: "submitted", to: "done", receipt: "review event recorded" });
    expect(merge("m-a0").intent.head).toBe(head);
    db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'm-a0'").run();
    const resolve = (intentId: string, outcome: string) =>
      add("agent-pm", "scheduler", { op: "merge_resolve", intentId, from: "unknown", outcome, receipt: "PR OPEN", manual: true });
    const resume = () => add("agent-pm", "scheduler", { op: "workflow_resume", from: "manual", manual: true });

    expect(() => merge("m-a1")).toThrow("本轮已取消合并意图，自动重试禁用；请 PM 手动核对并接管");
    resolve("m-a0", "done");
    resume();
    expect(() => merge("m-a1")).toThrow("本轮已取消合并意图，自动重试禁用；请 PM 手动核对并接管");
    resolve("m-a0", "failed");
    expect(() => merge("m-a1")).toThrow(/自动重试禁用/);
    resume();
    const retry = merge("m-a1").intent;
    expect(retry).toMatchObject({ status: "pending", action: "merge", head });

    // The released retry is cancelled again: that release is spent, it needs its own resolve + resume.
    db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'm-a1'").run();
    expect(() => merge("m-a2")).toThrow(/自动重试禁用/);
    resolve("m-a1", "cancelled");
    resume();
    expect(merge("m-a2").intent.status).toBe("pending");
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});
