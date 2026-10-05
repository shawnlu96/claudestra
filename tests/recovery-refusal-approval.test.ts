import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk, type AskAnswer, type NewAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createRefusalApprovalPort } from "../src/lib/recovery-refusal-approval.js";
import { createRecoveryRuntimePorts } from "../src/lib/recovery-runtime-ports.js";
import { EXEMPTION_TEXT, type OutcomeInput } from "../src/lib/scheduler-model-outcome.js";
import { openRefusal } from "../src/lib/scheduler-review-swap.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

let f: ReturnType<typeof autoFixture>;
let read: ReturnType<typeof createRefusalApprovalPort>;
let first: string;
beforeEach(async () => {
  f = autoFixture();
  await toBuild(f);
  await f.tick();
  const delivered = await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  expect(delivered.ok).toBe(true);
  await f.tick();
  await f.tick();
  first = f.intents().findLast((i) => i.action === "review")!.id;
  read = createRefusalApprovalPort(f.db);
});
afterEach(() => f.close());

function decision(button = "policy_refusal_rule_go", over: Partial<AskAnswer> = {}, draft: Partial<NewAsk> = {}) {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule", ...draft }, 1000);
  return answerAsk(f.db, ask.id, { choices: [`[button:${button}]`], labels: [button], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at: 2000, final: true, ...over });
}

const facts = () => read("p", "T1");
function input(intentId = first, sessionId = "review-session-1"): OutcomeInput {
  return { intentId, signal: { failure: { kind: "error", message: "Unable to respond: violates our Usage Policy" } },
    failed: { agent: "agent-rv-t1", family: "codex", machine: "local" },
    authorized: [{ family: "codex", machine: "local" }, { family: "claude", machine: "backup" }], ended: true,
    review: { sessionId, materialDigest: "sha256:unchanged-review" } };
}
function ticket(id: string) {
  for (const pending of f.intents().filter((i) => i.status === "pending")) {
    settleIntent(f.db, f.at("scheduler"), { id: pending.id, from: "pending", to: "cancelled", receipt: "Synthetic refused turn ended" });
  }
  const t = f.task();
  return planIntent(f.db, f.at("scheduler"), { id, taskId: t.id, taskRev: t.rev, workflowRev: getWorkflow(f.db, t.id)!.rev,
    causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "review", node: "adversarial_review", reason: "Synthetic new review ticket" }).intent.id;
}

describe("ledger owner approval reader", () => {
  test("no owner answer, including an open ask, gives null", () => {
    expect(facts()).toBeNull();
    openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Pending", askKey: "policy-refusal-rule" }, 1000);
    expect(facts()).toBeNull();
  });

  test.each([
    ["policy-refusal-rule", "policy_refusal_rule_go"],
    ["refusal_rule_exec", "refusal_rule_keep_supervisor"],
  ])("%s / %s approves with traceable source", (askKey, button) => {
    const ask = decision(button, {}, { askKey });
    expect(facts()).toEqual({ approvalId: ask.id, source: `askKey=${askKey}; button=${button}; answer.at=2000`,
      scope: "routine_readonly_review", content: "allowed", revoked: false, ownerHold: false });
  });

  test("latest answer time wins across both keys; another button revokes without caching", () => {
    decision();
    expect(facts()?.revoked).toBe(false);
    const revoke = decision("refusal_rule_manual", { at: 4000 });
    decision("policy_refusal_rule_go", { at: 3000 }, { askKey: "refusal_rule_exec" });
    expect(facts()).toMatchObject({ approvalId: revoke.id, revoked: true });
    const restore = decision("refusal_rule_keep_supervisor", { at: 5000 }, { askKey: "refusal_rule_exec" });
    expect(facts()).toMatchObject({ approvalId: restore.id, revoked: false });
  });

  test.each([
    { owner: false }, { owner: undefined }, { owner: "true" }, { principal: "guest:synthetic" },
    { principal: "token:synthetic" }, { principal: undefined }, { external: true },
  ])("does not trust a non-owner or missing identity: %j", (over) => {
    decision("policy_refusal_rule_go", over as Partial<AskAnswer>);
    expect(facts()).toBeNull();
  });

  test("wrong project/key/state cannot approve or revoke", () => {
    const approved = decision();
    decision("refusal_rule_manual", { at: 3000 }, { project: "elsewhere" });
    decision("refusal_rule_manual", { at: 4000 }, { askKey: "another-rule" });
    const cancelled = decision("refusal_rule_manual", { at: 5000 });
    f.db.run("UPDATE asks SET state = 'cancelled' WHERE id = ?", [cancelled.id]);
    expect(facts()).toMatchObject({ approvalId: approved.id, revoked: false });
    expect(read("elsewhere", "T1")).toBeNull();
    expect(read("p", "missing-task")).toBeNull();
  });

  test("guest's later answer never replaces owner approval", () => {
    const approved = decision();
    decision("refusal_rule_manual", { at: 3000, principal: "guest:synthetic", owner: undefined });
    expect(facts()).toMatchObject({ approvalId: approved.id, revoked: false });
  });

  test.each([[], ["policy_refusal_rule_go"], ["[button:policy_refusal_rule_go]", "[button:refusal_rule_manual]"], null].map((choices) => ({ choices })))(
    "missing or ambiguous button fails closed: %j", ({ choices }) => {
      const a = decision();
      f.db.run("UPDATE asks SET answer = ? WHERE id = ?", [JSON.stringify({ ...a.answer, choices }), a.id]);
      expect(facts()?.revoked).toBe(true);
    });

  test("unreadable or tied owner timestamps do not resurrect old approval", () => {
    decision();
    const newer = decision("refusal_rule_manual", { at: 3000 });
    f.db.run("UPDATE asks SET answer = ? WHERE id = ?", [JSON.stringify({ ...newer.answer, at: null }), newer.id]);
    expect(facts).toThrow("missing answer time");
    f.db.run("UPDATE asks SET answer = ? WHERE id = ?", [JSON.stringify({ ...newer.answer, at: 2000 }), newer.id]);
    expect(facts).toThrow("ambiguous latest answer");
  });

  test("ownerHold reads the card flag live and the reader never writes", () => {
    decision();
    f.db.run("UPDATE tasks SET extra = ? WHERE id = 'T1'", [JSON.stringify({ ...f.task().extra, refusalHold: true })]);
    const before = f.db.query("SELECT total_changes() AS n").get();
    expect(facts()).toMatchObject({ ownerHold: true });
    expect(f.db.query("SELECT total_changes() AS n").get()).toEqual(before);
    f.db.run("UPDATE tasks SET extra = '{}' WHERE id = 'T1'");
    expect(facts()?.ownerHold).toBe(false);
  });

  test.each([
    "UPDATE scheduler_intents SET head = 'stale' WHERE action = 'review'",
    "UPDATE scheduler_intents SET specRev = specRev + 1 WHERE action = 'review'",
    "UPDATE scheduler_intents SET action = 'dispatch' WHERE action = 'review'",
    "DELETE FROM scheduler_intents WHERE action = 'review'",
    "UPDATE tasks SET headSHA = NULL WHERE id = 'T1'",
    "UPDATE tasks SET specRev = 0 WHERE id = 'T1'",
    "UPDATE tasks SET stage = 'build' WHERE id = 'T1'",
  ])("unproven current review is uncertain: %s", (sql) => {
    decision();
    f.db.run(sql);
    expect(facts()?.content).toBe("uncertain");
  });

  test("newer mismatched ticket cannot fall back to a matching older review", () => {
    decision();
    const id = ticket("later-review");
    f.db.run("UPDATE scheduler_intents SET head = 'stale' WHERE id = ?", [id]);
    expect(facts()?.content).toBe("uncertain");
  });

  test.each(["null", "[]", "broken", ""])("unreadable extra is unavailable: %s", (extra) => {
    decision();
    f.db.run("UPDATE tasks SET extra = ? WHERE id = 'T1'", [extra]);
    expect(facts).toThrow();
  });
});

describe("real MODEL through runtime composition", () => {
  test("regression: missing port holds; injected owner approval plans the first retry", () => {
    const ask = decision();
    // Observe first so the old behavior does not impose an on-mode hold on the comparison.
    const old = createRecoveryRuntimePorts().recordModelOutcome(f.db, f.at("scheduler"), input());
    expect(old).toMatchObject({ plan: { kind: "manual", code: "model_safety_hold" } });
    const rt = createRecoveryRuntimePorts({ policy: () => ({ mode: "on", manualAfterMs: null }), refusalApproval: read });
    expect(rt.recordModelOutcome(f.db, f.at("scheduler"), input())).toMatchObject({ plan: { kind: "retry_same", approvalId: ask.id, newSession: true } });
  });

  test.each(["on", "observe"] as const)("%s: retry → exemption → manual, same materials and fresh tickets/sessions", (mode) => {
    const ask = decision();
    const rt = createRecoveryRuntimePorts({ ...(mode === "on" ? { policy: () => ({ mode, manualAfterMs: null }) } : {}), refusalApproval: read });
    const rec = (i: OutcomeInput) => rt.recordModelOutcome(f.db, f.at("scheduler"), i);
    const sent = f.sent.length, ensured = f.ensured.length;
    const r1 = rec(input());
    expect(r1).toMatchObject({ mode, plan: { kind: "retry_same", newSession: true, to: { family: "codex", machine: "local" }, approvalId: ask.id } });
    expect(rec(input())).toMatchObject({ duplicate: true });
    const r2 = rec(input(ticket("synthetic-second"), "review-session-2"));
    expect(r2).toMatchObject({ plan: { kind: "exempt_review", to: { family: "claude", machine: "backup" }, exemption: EXEMPTION_TEXT, notifyOwner: true } });
    const third = input(ticket("synthetic-third"), "review-session-3");
    third.failed = { agent: "agent-backup", family: "claude", machine: "backup" };
    const r3 = rec(third);
    expect(r3).toMatchObject({ plan: { kind: "manual", code: "model_safety_hold", reason: expect.stringContaining("不再换提供方") } });
    const outcomes = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.cls === "safety");
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((e) => e.data.attempt)).toEqual([1, 2, 3]);
    expect(outcomes.every((e) => e.data.approvalId === ask.id && e.data.noReport === true && e.data.verdict === null)).toBe(true);
    if (mode === "observe") {
      expect(outcomes.every((e) => e.kind === "note" && e.data.op === "model_outcome")).toBe(true);
      expect(openRefusal(outcomes)).toBeNull();
    } else {
      expect(outcomes.map((e) => e.data.op)).toEqual(["model_refusal_retry", "model_refusal_exempt", "model_safety_hold"]);
    }
    expect([f.sent.length, f.ensured.length]).toEqual([sent, ensured]);
    expect(f.notices).toEqual([]);
  });

  test.each(["hold", "revoke", "uncertain"])("%s blocks continuation even in on mode", (condition) => {
    decision(condition === "revoke" ? "refusal_rule_manual" : "policy_refusal_rule_go");
    if (condition === "hold") f.db.run("UPDATE tasks SET extra = '{\"refusalHold\":true}' WHERE id = 'T1'");
    if (condition === "uncertain") f.db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
    const rt = createRecoveryRuntimePorts({ policy: () => ({ mode: "on", manualAfterMs: null }), refusalApproval: read });
    expect(rt.recordModelOutcome(f.db, f.at("scheduler"), input())).toMatchObject({ plan: { kind: "manual", code: "model_safety_hold" } });
  });

  test("reader failure reaches approvalDiag and keeps the manual hold", () => {
    const ask = decision();
    f.db.run("UPDATE asks SET answer = 'broken' WHERE id = ?", [ask.id]);
    const rt = createRecoveryRuntimePorts({ refusalApproval: read });
    expect(rt.recordModelOutcome(f.db, f.at("scheduler"), input())).toMatchObject({
      plan: { kind: "manual", code: "model_safety_hold" }, event: { data: { approvalDiag: expect.stringContaining("读批准失败") } },
    });
  });
});
