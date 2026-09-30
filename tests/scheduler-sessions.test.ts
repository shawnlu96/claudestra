import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { taskDetail } from "../src/lib/ledger-read.js";
import { planIntent, setWorkflow, settleIntent } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { bindSchedulerSession, getSchedulerSession, recordSessionRetirement, taskWorkerRefs } from "../src/lib/scheduler-sessions.js";
import { createTask } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "t68-session-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {
    "agent-one": { runtime: "claude-code" }, "agent-two": { runtime: "claude-code" },
    "agent-review": { runtime: "codex" }, "agent-claude-helper": { runtime: "claude-code" },
  } }));
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
  return { db, ctx, workflow, submit, close, registryPath };
}

describe("T68 per-card session bindings", () => {
  test("binding through the CLI tags a local reviewer through the registry entry", async () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "adversarial_review", "ensure_session", "create-reviewer");
      const loadRegistry = async () => JSON.parse(readFileSync(f.registryPath, "utf8")) as Registry;
      const args = ["scheduler-session-bind", "T1", "--role", "reviewer", "--intent", "create-reviewer",
        "--agent", "agent-review", "--session", "review-one", "--family", "codex", "--transport", "acp"];
      const deps: LedgerDeps = {
        db: f.db, actor: "owner", registryPath: f.registryPath, projectIds: ["p"], loadRegistry,
        saveRegistry: async (reg) => { writeFileSync(f.registryPath, JSON.stringify(reg)); }, now: () => 100,
      };
      const result = await runLedger(args, deps);
      expect(result.ok).toBe(true);
      expect((await loadRegistry()).agents["agent-review"].kind).toBe("worker");
      const reg = await loadRegistry();
      reg.agents["agent-review"].kind = "main";
      writeFileSync(f.registryPath, JSON.stringify(reg));
      expect((await runLedger(args, deps)).ok).toBe(true);
      expect((await loadRegistry()).agents["agent-review"].kind).toBe("main");
    } finally { f.close(); }
  });

  test("submitted creation intent binds once, projects into task detail, and cannot be stolen", () => {
    const f = fixture();
    try {
      f.workflow("T1"); f.workflow("T2");
      f.submit("T1", "restate", "ensure_session", "create-author");
      settleIntent(f.db, f.ctx, { id: "create-author", from: "submitted", to: "unknown", receipt: "creation result unclear" });
      const author = { taskId: "T1", role: "author" as const, intentId: "create-author", agent: "agent-one",
        sessionId: "session-one", family: "claude" as const, transport: "acp" as const, registryPath: f.registryPath };
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
        sessionId: "review-one", family: "codex" as const, transport: "acp" as const, registryPath: f.registryPath };
      f.db.query("UPDATE scheduler_intents SET recipient = 'agent-review-a' WHERE id = 'create-reviewer'").run();
      expect(() => bindSchedulerSession(f.db, f.ctx, review)).toThrow(/建 session 意图/);
      f.db.query("UPDATE scheduler_intents SET recipient = NULL WHERE id = 'create-reviewer'").run();
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, family: "claude" })).toThrow(/registry runtime/);
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, agent: "agent-one" })).toThrow(/registry runtime/);
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, agent: "agent-claude-helper", transport: "tmux" }))
        .toThrow(/registry runtime/);
      expect(bindSchedulerSession(f.db, f.ctx, review).session).toMatchObject({ role: "reviewer", state: "active" });
      expect(getSchedulerSession(f.db, "T1", "reviewer")?.sessionId).toBe("review-one");
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...review, sessionId: "review-two" })).toThrow(/不能换审查上下文/);
    } finally { f.close(); }
  });

  test("peer family remains explicitly marked as a claim", () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "adversarial_review", "ensure_session", "peer-reviewer");
      f.db.query("UPDATE tasks SET extra=? WHERE id='T1'").run(JSON.stringify({ reviewer: "reviewer@remote" }));
      bindSchedulerSession(f.db, f.ctx, { taskId: "T1", role: "reviewer", intentId: "peer-reviewer",
        agent: "reviewer@remote", sessionId: "peer-session", family: "codex", transport: "peer", registryPath: f.registryPath });
      expect(taskWorkerRefs(f.db, "T1").reviewer?.source).toBe("peer_claim");
      const event = f.db.query("SELECT json_extract(data, '$.source') AS source FROM events WHERE dedupKey = 'scheduler:peer-reviewer:bind'").get();
      expect(event).toEqual({ source: "peer_claim" });
    } finally { f.close(); }
  });

  test("peer transport cannot disguise a local runtime or invent a remote assignment", () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "adversarial_review", "ensure_session", "peer-bypass");
      const input = { taskId: "T1", role: "reviewer" as const, intentId: "peer-bypass",
        sessionId: "claimed", family: "codex" as const, transport: "peer" as const, registryPath: f.registryPath };
      for (const agent of ["agent-claude-helper", "claude-helper"]) {
        expect(() => bindSchedulerSession(f.db, f.ctx, { ...input, agent })).toThrow(/registry runtime/);
      }
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...input, agent: "agent-review" })).toThrow(/不能声明 peer/);
      expect(() => bindSchedulerSession(f.db, f.ctx, { ...input, agent: "review", transport: "acp" })).toThrow(/完整名称/);
      for (const agent of ["agent-remote", "reviewer@unassigned"]) {
        expect(() => bindSchedulerSession(f.db, f.ctx, { ...input, agent })).toThrow(/明确委托/);
      }
      expect(getSchedulerSession(f.db, "T1", "reviewer")).toBeNull();
    } finally { f.close(); }
  });

  test("protected main sessions are refused before a ledger binding is committed", () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "adversarial_review", "ensure_session", "protected-reviewer");
      const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      reg.agents["agent-codex"] = { runtime: "codex" };
      reg.agents["agent-project-pm"] = { runtime: "codex", role: "pm" };
      writeFileSync(f.registryPath, JSON.stringify(reg));
      for (const agent of ["agent-codex", "agent-project-pm"]) {
        expect(() => bindSchedulerSession(f.db, f.ctx, { taskId: "T1", role: "reviewer", intentId: "protected-reviewer",
          agent, sessionId: "main-session", family: "codex", transport: "acp", registryPath: f.registryPath }))
          .toThrow(/长驻主 agent/);
      }
      expect(getSchedulerSession(f.db, "T1", "reviewer")).toBeNull();
    } finally { f.close(); }
  });

  test("verified card retirement needs archive receipt before kill and repeats safely", () => {
    const f = fixture();
    try {
      f.workflow("T1");
      f.submit("T1", "restate", "ensure_session", "create-author");
      bindSchedulerSession(f.db, f.ctx, { taskId: "T1", role: "author", intentId: "create-author", agent: "agent-one",
        sessionId: "session-one", family: "claude", transport: "tmux", registryPath: f.registryPath });
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
