import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAskFull } from "../src/lib/ledger-asks.js";
import { planIntent, setWorkflow, settleIntent } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";

test("write transaction refuses an unreviewed or stale merge head and a UI merge without durable screenshot approval", () => {
  const dir = mkdtempSync(join(tmpdir(), "t68-merge-gate-"));
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  const owner = { actor: "owner", now: 10 };
  const head = "a".repeat(40);
  try {
    createTask(db, owner, { project: "p", id: "T1", title: "merge gate", kind: "code", agent: "agent-author" });
    const workflow = setWorkflow(db, owner, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2,
      mode: "auto", authorFamily: "claude", fallback: "manual" }).workflow;
    const seq = () => (db.query("SELECT MAX(seq) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
    const merge = (id: string) => planIntent(db, { actor: "scheduler" }, { id, taskId: "T1", taskRev: 1,
      workflowRev: workflow.rev, causalSeq: seq(), node: "merge_deploy", action: "merge", reason: "merge" });
    expect(() => merge("no-stage")).toThrow(/merge_deploy/);
    db.query("UPDATE tasks SET stage = 'merge', round = 1, headSHA = ? WHERE id = 'T1'").run(head);
    expect(() => merge("no-review")).toThrow(/通过审查/);
    db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,?,?,?,?,?)").run(
      "owner", "p", "T1", "stage", "review", JSON.stringify({ from: "build", to: "review", round: 1 }),
    );
    planIntent(db, { actor: "scheduler" }, { id: "review", taskId: "T1", taskRev: 1,
      workflowRev: workflow.rev, causalSeq: seq(), node: "adversarial_review", action: "review", reason: "review",
      recipient: "agent-review" });
    settleIntent(db, { actor: "scheduler" }, { id: "review", from: "pending", to: "submitted", receipt: "ack" });
    db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,?,?,?,?,?)").run(
      "agent-review", "p", "T1", "review", "pass", JSON.stringify({ round: 1, head, verdict: "pass", reviewer: "agent-review",
        reviewerSessionId: "session-review", reviewerFamily: "codex", path: "report.md", findings: [], p0: 0, p1: 0, p2: 0 }),
    );
    settleIntent(db, { actor: "scheduler" }, { id: "review", from: "submitted", to: "done", receipt: "review event recorded" });
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run("b".repeat(40));
    expect(() => merge("stale-head")).toThrow(/通过审查/);
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(head);
    expect(merge("reviewed").intent.status).toBe("pending");
    db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'reviewed'").run();
    expect(() => merge("retry-direct")).toThrow(/自动重试禁用/);
    createTask(db, owner, { project: "p", id: "T2", title: "UI gate", kind: "code", agent: "agent-ui" });
    const ui = setWorkflow(db, owner, { taskId: "T2", taskRev: 1, template: "ui", templateVersion: 2,
      mode: "auto", authorFamily: "claude", fallback: "manual" }).workflow;
    const digest = "d".repeat(64);
    db.query("UPDATE tasks SET stage = 'merge', round = 1, headSHA = ?, extra = ? WHERE id = 'T2'")
      .run(head, JSON.stringify({ screenshotsDigest: digest }));
    db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,?,?,?,?,?)").run(
      "owner", "p", "T2", "stage", "review", JSON.stringify({ from: "build", to: "review", round: 1 }),
    );
    planIntent(db, { actor: "scheduler" }, { id: "ui-review", taskId: "T2", taskRev: 1,
      workflowRev: ui.rev, causalSeq: seq(), node: "adversarial_review", action: "review", reason: "review",
      recipient: "agent-review" });
    settleIntent(db, { actor: "scheduler" }, { id: "ui-review", from: "pending", to: "submitted", receipt: "ack" });
    db.prepare("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (10,?,?,?,?,?,?)").run(
      "agent-review", "p", "T2", "review", "pass", JSON.stringify({ round: 1, head, verdict: "pass", reviewer: "agent-review",
        reviewerSessionId: "session-review", reviewerFamily: "codex", path: "report.md", findings: [], p0: 0, p1: 0, p2: 0 }),
    );
    settleIntent(db, { actor: "scheduler" }, { id: "ui-review", from: "submitted", to: "done", receipt: "review event recorded" });
    expect(() => planIntent(db, { actor: "scheduler" }, { id: "ui-merge", taskId: "T2", taskRev: 1,
      workflowRev: ui.rev, causalSeq: seq(), node: "merge_deploy", action: "merge", reason: "merge" }))
      .toThrow(/截图授权/);
    const params = { task: "T2", specRev: 1, head, screenshotsDigest: digest };
    const binding = { action: "scheduler_ui_screenshot", params, approve: ["approve"] };
    const approve = (owner: boolean) => {
      const ask = openAskFull(db, { project: "p", taskId: "T2", source: "system", kind: "authorize", title: "看截图",
        fromAgent: "scheduler", options: [{ type: "buttons", buttons: [{ id: "approve", label: "同意" }] }],
        bind: { ...binding, paramsHash: bindHash(binding, "scheduler") } }, 10).ask;
      answerAsk(db, ask.id, { choices: ["[button:approve]"], labels: ["同意"], text: "", principal: "owner:self", via: "web_card", at: 11,
        ...(owner ? { owner: true as const } : {}) });
    };
    // 答复没有认证入口写的 owner 标记（旧答复 / 低层写入），不算 owner 批准
    approve(false);
    expect(() => planIntent(db, { actor: "scheduler", now: 12 }, { id: "ui-merge", taskId: "T2", taskRev: 1,
      workflowRev: ui.rev, causalSeq: seq(), node: "merge_deploy", action: "merge", reason: "merge" })).toThrow(/截图授权/);
    approve(true);
    expect(planIntent(db, { actor: "scheduler", now: 12 }, { id: "ui-merge", taskId: "T2", taskRev: 1,
      workflowRev: ui.rev, causalSeq: seq(), node: "merge_deploy", action: "merge", reason: "merge" }).intent.status)
      .toBe("pending");
  } finally { closeLedger(path); rmSync(dir, { recursive: true, force: true }); }
});
