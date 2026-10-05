import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { classifyModelOutcome, modelOutcomePolicy, planModelRecovery, recordModelOutcome, resolveSafetyHold,
  type OutcomeInput, type RecoveryFacts, type RecoveryPolicyPort } from "../src/lib/scheduler-model-outcome.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { openSafetyHold } from "../src/lib/scheduler-review-swap.js";
import { beginReviewerSwap } from "../src/lib/scheduler-sessions.js";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

const CLAUDE_REFUSAL = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const CYBER = "This request has been flagged for possible cybersecurity risk";
const on: RecoveryPolicyPort = () => ({ mode: "on", manualAfterMs: null });
const observe: RecoveryPolicyPort = () => ({ mode: "observe", manualAfterMs: 60_000 });
const off: RecoveryPolicyPort = () => ({ mode: "off", manualAfterMs: null });

describe("dispatch-recovery-MODEL classification", () => {
  test("safety beats capacity wording; capacity, host and transport stay apart", () => {
    expect(classifyModelOutcome({ failure: { kind: "error", message: `${CLAUDE_REFUSAL} (rate limit)` } })).toMatchObject({ cls: "safety", recoverable: false });
    expect(classifyModelOutcome({ failure: { kind: "error", message: CYBER } })).toMatchObject({ cls: "safety" });
    expect(classifyModelOutcome({ failure: { kind: "error", message: 'stop_reason: "refusal"' } })).toMatchObject({ cls: "safety" });
    expect(classifyModelOutcome({ failure: { kind: "quota", message: "usage limit reached" } })).toMatchObject({ cls: "capacity", recoverable: true });
    expect(classifyModelOutcome({ failure: { kind: "error", message: "529 Overloaded" } })).toMatchObject({ cls: "capacity" });
    expect(classifyModelOutcome({ failure: { kind: "auth", message: "login expired" } })).toMatchObject({ cls: "host", recoverable: false });
    expect(classifyModelOutcome({ failure: { kind: "error", message: "ECONNRESET" } })).toMatchObject({ cls: "host", recoverable: true });
    expect(classifyModelOutcome({ send: { delivered: false, reason: "bridge 拒收" } })).toMatchObject({ cls: "host", recoverable: true });
    expect(classifyModelOutcome({ send: { delivered: "unknown", reason: "timeout" } })).toMatchObject({ cls: "host", recoverable: false });
    expect(classifyModelOutcome({ offline: true })).toMatchObject({ cls: "host", recoverable: true });
    expect(classifyModelOutcome({})).toBeNull();
  });

  test("policy port: missing → observe, broken or garbage → off with diagnosis, valid passes through", () => {
    expect(modelOutcomePolicy(undefined, "p")).toMatchObject({ mode: "observe", manualAfterMs: null });
    expect(modelOutcomePolicy(() => { throw new Error("corrupt"); }, "p")).toMatchObject({ mode: "off", diag: expect.stringContaining("corrupt") });
    expect(modelOutcomePolicy(() => ({ mode: "maybe" }) as never, "p")).toMatchObject({ mode: "off", diag: expect.any(String) });
    expect(modelOutcomePolicy(() => ({ mode: "on", manualAfterMs: -1 }), "p").mode).toBe("off");
    const asked: string[] = [];
    expect(modelOutcomePolicy((p, k) => (asked.push(`${p}/${k}`), { mode: "on", manualAfterMs: 5 }), "p")).toEqual({ mode: "on", manualAfterMs: 5 });
    expect(asked).toEqual(["p/modelOutcome"]);
  });

  test("recovery stays inside authorized placements and keeps cross-model honest", () => {
    const base: RecoveryFacts = { role: "reviewer", authorFamily: "claude", failed: { family: "codex", machine: "Sekai" },
      authorized: [{ family: "claude", machine: "local" }, { family: "codex", machine: "Sekai" }, { family: "codex", machine: "Hede" }], noResult: true, ended: true };
    expect(planModelRecovery("host", true, base)).toMatchObject({ kind: "redispatch", to: { family: "codex", machine: "Hede" } });
    // A Claude author's reviewer may not be swapped to Claude and called cross-model.
    expect(planModelRecovery("capacity", true, { ...base, authorized: [{ family: "claude", machine: "local" }, { family: "codex", machine: "Sekai" }] }))
      .toMatchObject({ kind: "manual", code: "model_recovery_manual" });
    expect(planModelRecovery("host", true, { ...base, role: "author", failed: { family: "claude", machine: "local" } })).toMatchObject({ kind: "manual" });
    expect(planModelRecovery("host", true, { ...base, role: "author", failed: { family: "claude", machine: "x" } }))
      .toMatchObject({ kind: "redispatch", to: { family: "claude", machine: "local" } });
    expect(planModelRecovery("host", true, { ...base, ended: false })).toMatchObject({ kind: "manual" });
    expect(planModelRecovery("host", true, { ...base, noResult: false })).toMatchObject({ kind: "manual" });
    expect(planModelRecovery("safety", false, base)).toMatchObject({ kind: "manual", code: "model_safety_hold" });
  });
});

async function building() {
  const f = autoFixture();
  await toBuild(f);
  expect(await f.tick()).toMatchObject({ step: "sent" });
  const intent = f.intents().findLast((i) => i.action === "dispatch")!;
  const input = (message: string, more: Partial<OutcomeInput> = {}): OutcomeInput => ({ intentId: intent.id, signal: { failure: { kind: "error", message } },
    failed: { agent: "agent-task-one", family: "claude", machine: "local" }, authorized: [{ family: "claude", machine: "local" }, { family: "claude", machine: "Hede" }],
    ended: true, ...more });
  const outcomes = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => String(e.data.op).startsWith("model_"));
  return { f, intent, input, outcomes };
}

describe("dispatch-recovery-MODEL ledger record", () => {
  test("safety refusal on: one real evidence, no result, no verdict, hold survives replays and later refusals", async () => {
    const { f, input, outcomes } = await building();
    try {
      const ctx = () => f.at("scheduler");
      const r = recordModelOutcome(f.db, ctx(), input(CLAUDE_REFUSAL), on);
      expect(r).toMatchObject({ kind: "recorded", mode: "on", cls: "safety", duplicate: false, plan: { kind: "manual", code: "model_safety_hold" } });
      if (r.kind !== "recorded") throw new Error("unreachable");
      expect(r.event.kind).toBe("escalate");
      expect(r.event.data).toMatchObject({ op: "model_safety_hold", evidence: CLAUDE_REFUSAL, noResult: true, noReport: true, verdict: null, head: null, round: 0 });
      expect(r.materials).toContain("不是 pass");
      expect(r.materials).toContain(CLAUDE_REFUSAL);
      // Restart replay: same record, nothing new; a second refusal on the held card adds no evidence and plans no retry.
      expect(recordModelOutcome(f.db, ctx(), input(CLAUDE_REFUSAL), on)).toMatchObject({ duplicate: true, event: { seq: r.event.seq } });
      expect(recordModelOutcome(f.db, ctx(), input(CYBER, { intentId: r.event.data.intentId as string }), on)).toMatchObject({ duplicate: true });
      expect(outcomes()).toHaveLength(1);
      expect(openSafetyHold(listEvents(f.db, { project: "p", target: "T1" }))?.seq).toBe(r.event.seq);
      expect(() => recordModelOutcome(f.db, f.at("pm"), input(CLAUDE_REFUSAL), on)).toThrow(/调度服务/);
      // Only a manager resolves it; the evidence stays.
      expect(() => resolveSafetyHold(f.db, f.at("agent-task-one"), { taskId: "T1", text: "x" })).toThrow(/PM/);
      resolveSafetyHold(f.db, f.at("pm"), { taskId: "T1", text: "改由人工改写规格" });
      expect(openSafetyHold(listEvents(f.db, { project: "p", target: "T1" }))).toBeNull();
      expect(outcomes().map((e) => e.data.op)).toEqual(["model_safety_hold", "model_safety_resolved"]);
    } finally { f.close(); }
  });

  test("observe records what on would do without holding; off and missing port keep the old path", async () => {
    const { f, input, outcomes } = await building();
    try {
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(CLAUDE_REFUSAL), off)).toEqual({ kind: "off" });
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(CLAUDE_REFUSAL), () => { throw new Error("bad json"); }))
        .toMatchObject({ kind: "off", diag: expect.stringContaining("bad json") });
      expect(outcomes()).toHaveLength(0);
      const r = recordModelOutcome(f.db, f.at("scheduler"), input(CLAUDE_REFUSAL));
      expect(r).toMatchObject({ kind: "recorded", mode: "observe", event: { kind: "note", data: { op: "model_outcome", mode: "observe", cls: "safety" } } });
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(CLAUDE_REFUSAL), observe)).toMatchObject({ duplicate: true });
      expect(openSafetyHold(listEvents(f.db, { project: "p", target: "T1" }))).toBeNull();
    } finally { f.close(); }
  });

  test("ordinary failure on: recovery decision only for an ended, result-less order; a delivered order is no failure", async () => {
    const { f, input, outcomes } = await building();
    try {
      expect(recordModelOutcome(f.db, f.at("scheduler"), input("ECONNRESET", { ended: false }), on))
        .toMatchObject({ plan: { kind: "manual", code: "model_recovery_manual" }, event: { kind: "escalate" } });
      const g = await building();
      try {
        const r = recordModelOutcome(g.f.db, g.f.at("scheduler"), g.input("529 Overloaded"), on);
        expect(r).toMatchObject({ cls: "capacity", plan: { kind: "redispatch", to: { family: "claude", machine: "Hede" } }, event: { kind: "note" } });
        expect(await g.f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
        const h = recordModelOutcome(g.f.db, g.f.at("scheduler"), g.input(CLAUDE_REFUSAL), observe);
        expect(h).toMatchObject({ kind: "none", reason: expect.stringContaining("已有") });
      } finally { g.f.close(); }
      expect(outcomes()).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("dispatch-recovery-MODEL outranks the automatic family switch (real tick)", () => {
  test("held card: the takeover's reviewer swap escalates instead of swapping until PM resolves", async () => {
    const { f, input } = await building();
    try {
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "session" });
      expect(await f.tick()).toMatchObject({ step: "sent" });
      expect(await f.review("changes", H1, [P1])).toMatchObject({ ok: true });
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→fix" });
      expect(await f.tick()).toMatchObject({ step: "sent" });
      const fix = f.intents().findLast((i) => i.action === "dispatch")!;
      expect(recordModelOutcome(f.db, f.at("scheduler"), input(CLAUDE_REFUSAL, { intentId: fix.id }), on)).toMatchObject({ cls: "safety" });
      // The author moves to Codex (the reviewer's family) and delivers: without the hold this plans review_swap.
      f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
      f.db.run("UPDATE scheduler_sessions SET family = 'codex', transport = 'acp' WHERE taskId = 'T1' AND role = 'author'");
      const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      Object.assign(reg.agents["agent-task-one"], { runtime: "codex", transport: "acp" });
      writeFileSync(f.registryPath, JSON.stringify(reg));
      expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2)).toMatchObject({ ok: true });
      expect(f.task().round).toBe(2);
      const plan = () => planScheduler(autoSnapshot(f.db, getTask(f.db, "T1")!, { registry: [], maxWorkers: 2 }));
      expect(plan()).toMatchObject({ kind: "escalate", code: "model_safety_hold" });
      await f.tick();
      expect(f.intents().some((i) => i.action === "review_swap")).toBe(false);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");

      // Swap apply re-checks the hold in its own transaction (a plan raced in before the hold).
      resolveSafetyHold(f.db, f.at("pm"), { taskId: "T1", text: "PM 已人工改写规格，放行换审" });
      f.db.run("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'"); // PM hands the card back to the scheduler
      expect(plan()).toMatchObject({ kind: "intent", action: "review_swap" });
      f.db.run("PRAGMA journal_mode = DELETE");
      const db = Database.deserialize(f.db.serialize());
      try {
        const task = getTask(db, "T1")!, p = plan();
        if (p.kind !== "intent") throw new Error(JSON.stringify(p));
        const seq = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
        const intent = planIntent(db, { actor: "scheduler", now: 90000 }, { id: p.id, taskId: task.id, taskRev: task.rev,
          workflowRev: getWorkflow(db, task.id)!.rev, causalSeq: seq, action: p.action, node: p.node, reason: p.reason, resources: p.resources }).intent;
        appendEvent(db, { actor: "scheduler", now: 90001 }, { project: "p", target: "T1", kind: "escalate", text: "hold", data: { op: "model_safety_hold" } });
        expect(() => beginReviewerSwap(db, { actor: "scheduler", now: 90002 }, intent.id)).toThrow(/安全拒绝/);
      } finally { db.close(); }
    } finally { f.close(); }
  });
});
