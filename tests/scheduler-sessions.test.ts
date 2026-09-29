import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { taskDetail } from "../src/lib/ledger-read.js";
import { planIntent, setWorkflow, settleIntent } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { bindSchedulerSession, getSchedulerSession, recordSessionRetirement, taskWorkerRefs } from "../src/lib/scheduler-sessions.js";
import { createTask } from "../src/lib/ledger-write.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "t68-session-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const ctx = { actor: "owner", now: 100 };
  createTask(db, ctx, { project: "p", id: "T1", title: "one", kind: "code", agent: "agent-one" });
  createTask(db, ctx, { project: "p", id: "T2", title: "two", kind: "code", agent: "agent-two" });
  const workflow = (taskId: string) => setWorkflow(db, ctx, { taskId, taskRev: 1, template: "code", templateVersion: 2,
    mode: "auto", authorFamily: "claude", fallback: "缩小范围" }).workflow;
  const seq = () => (db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
  const submit = (taskId: string, node: string, action: "ensure_session" | "retire", id: string) => {
    const intent = planIntent(db, ctx, { taskId, node, action, id, taskRev: getTask(db, taskId)!.rev,
      workflowRev: 1, causalSeq: seq(), reason: `${action} ${node}` }).intent;
    return settleIntent(db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "effect started" });
  };
  const close = () => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); };
  return { db, ctx, workflow, submit, close };
}

describe("T68 per-card session bindings", () => {
  test("submitted creation intent binds once, projects into task detail, and cannot be stolen", () => {
    const f = fixture();
    try {
      f.workflow("T1"); f.workflow("T2");
      f.submit("T1", "restate", "ensure_session", "create-author");
      settleIntent(f.db, f.ctx, { id: "create-author", from: "submitted", to: "unknown", receipt: "creation result unclear" });
      const author = { taskId: "T1", role: "author" as const, intentId: "create-author", agent: "agent-one",
        sessionId: "session-one", family: "claude" as const, transport: "acp" as const };
      expect(bindSchedulerSession(f.db, f.ctx, author).duplicate).toBe(false);
      expect(bindSchedulerSession(f.db, f.ctx, author).duplicate).toBe(true);
      expect(taskWorkerRefs(f.db, "T1").author).toMatchObject({ sessionId: "session-one", family: "claude" });
      expect(taskDetail(f.db, "p", "T1", 100)?.sessions.author?.sessionId).toBe("session-one");
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...author, sessionId: "replacement" })).toThrow(/另一个 session/);
      settleIntent(f.db, f.ctx, { id: "create-author", from: "unknown", to: "done", receipt: "bound" });
      f.submit("T2", "restate", "ensure_session", "create-two");
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...author, taskId: "T2", intentId: "create-two", agent: "agent-two" }))
        .toThrow(/属于另一张卡/);
    } finally { f.close(); }
  });

  test("reviewer requires opposite family, separate identity and same session across rounds", () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "adversarial_review", "ensure_session", "create-reviewer");
      const review = { taskId: "T1", role: "reviewer" as const, intentId: "create-reviewer", agent: "agent-review",
        sessionId: "review-one", family: "codex" as const, transport: "acp" as const };
      f.db.query("UPDATE scheduler_intents SET recipient = 'agent-review-a' WHERE id = 'create-reviewer'").run();
      expect(() => bindSchedulerSession(f.db, f.ctx, review)).toThrow(/建 session 意图/);
      f.db.query("UPDATE scheduler_intents SET recipient = NULL WHERE id = 'create-reviewer'").run();
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, family: "claude" })).toThrow(/跨模型/);
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, agent: "agent-one" })).toThrow(/跨模型/);
      expect(bindSchedulerSession(f.db, f.ctx, review).session).toMatchObject({ role: "reviewer", state: "active" });
      expect(getSchedulerSession(f.db, "T1", "reviewer")?.sessionId).toBe("review-one");
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, sessionId: "review-two" })).toThrow(/不能换审查上下文/);
    } finally { f.close(); }
  });

  test("verified card retirement needs archive receipt before kill and repeats safely", () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "restate", "ensure_session", "create-author");
      bindSchedulerSession(f.db, f.ctx, { taskId: "T1", role: "author", intentId: "create-author", agent: "agent-one",
        sessionId: "session-one", family: "claude", transport: "tmux" });
      settleIntent(f.db, f.ctx, { id: "create-author", from: "submitted", to: "done", receipt: "bound" });
      f.db.query("UPDATE tasks SET stage = 'verified', rev = rev + 1 WHERE id = 'T1'").run();
      f.submit("T1", "retire", "retire", "retire-one");
      settleIntent(f.db, f.ctx, { id: "retire-one", from: "submitted", to: "unknown", receipt: "archive result unclear" });
      const base = { taskId: "T1", role: "author" as const, intentId: "retire-one" };
      expect(() => recordSessionRetirement(f.db, f.ctx, { ...base, effect: "kill", receipt: "stopped" })).toThrow(/先确认归档/);
      expect(recordSessionRetirement(f.db, f.ctx, { ...base, effect: "archive", receipt: "archive:1" }).state).toBe("retiring");
      expect(taskWorkerRefs(f.db, "T1").author?.sessionId).toBe("session-one");
      expect(recordSessionRetirement(f.db, f.ctx, { ...base, effect: "archive", receipt: "archive:1" }).state).toBe("retiring");
      expect(recordSessionRetirement(f.db, f.ctx, { ...base, effect: "kill", receipt: "stopped:1" }).state).toBe("retired");
      expect(taskWorkerRefs(f.db, "T1").author).toBeNull();
      expect(taskDetail(f.db, "p", "T1", 100)?.sessions.author).toMatchObject({ sessionId: "session-one", state: "retired" });
      expect(() => recordSessionRetirement(f.db, f.ctx, { ...base, effect: "kill", receipt: "stopped:2" })).toThrow(/回执不一致/);
    } finally { f.close(); }
  });
});
