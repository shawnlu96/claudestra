/**
 * dispatch-recovery-MODELX, owner 10-06 14:45 (A): a provider policy refusal of the review (cyber_policy included) goes straight to
 * the other family under a recorded exemption — no same-model retry. The production tick path on a temp ledger with fake workers
 * and a fake swap runtime: first refusal → refusal epoch (old binding retired, history kept) → new session of the author's family,
 * marked with the exemption and approval id, crossModel false → same materials → its verdict passes both merge gates; a refusal of
 * the exempt review → manual, no second epoch. Revoked approval / owner hold / digest / head drift → nothing runs; one run per plan.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createRefusalApprovalPort } from "../src/lib/recovery-refusal-approval.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { EXEMPTION_TEXT, recordModelOutcome } from "../src/lib/scheduler-model-outcome.js";
import { setModelOutcomeReader } from "../src/lib/scheduler-model-wiring.js";
import { reviewMaterialDigest } from "../src/lib/scheduler-review-swap.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { beginRefusalEpoch, bindSchedulerSession, getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const USAGE = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const EX = "agent-task-rv-t1-r1-ex";
const dir = mkdtempSync(join(tmpdir(), "modelx-"));
const g = globalThis as { __modelxMode?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelxMode, manualAfterMs: null }; }\n");

let f: ReturnType<typeof autoFixture>;
let first: SchedulerIntent;
let errors: ReturnType<typeof spyOn>;
let created: { family: string; tag?: string }[];
let askId: string;
const real = new WeakMap<object, ReturnType<typeof autoFixture>["tickDeps"]["worker"]>();
beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__modelxMode = "on";
  created = [];
  f = autoFixture();
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  first = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
  askId = answer("policy_refusal_rule_go", 2000);
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelxMode; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The owner's standing refusal rule (or a later answer that revokes it). */
function answer(button: string, at: number): string {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, at - 1);
  answerAsk(f.db, ask.id, { choices: [`[button:${button}]`], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true, via: "web_card", at, final: true });
  return ask.id;
}
/** Every bound worker reports this failure for its turn; null restores the fixture's own worker. */
function failWith(message: string | null) {
  const worker = real.get(f) ?? f.tickDeps.worker;
  real.set(f, worker);
  f.tickDeps.worker = message === null ? worker : (ref) => {
    const w = worker(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message } }) };
  };
}
const editRegistry = (fn: (r: { agents: Record<string, Record<string, unknown>> }) => void) => {
  const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
  fn(r);
  writeFileSync(f.registryPath, JSON.stringify(r));
};
/** The swap runtime's lifecycle effects, faked: a new registry agent for the exempt reviewer, nothing else touched. */
const swapDeps = (): ReviewSwapDeps => ({
  registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: async () => ({ ok: true }),
  ensure: async (task, family, _old, tag) => {
    created.push({ family, tag });
    editRegistry((r) => { r.agents[EX] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId: "s-ex", cwd: join(f.dir, "rv-ex") }; });
    return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: EX, sessionId: "s-ex", family, transport: "tmux" } };
  },
});
async function tick() {
  const manager = (...a: string[]) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()) : f.tickDeps.manager(...a);
  const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, manager });
  if (r.failed.length) throw new Error(JSON.stringify(r.failed));
  return r.cards[0];
}
const events = () => listEvents(f.db, { project: "p", target: "T1" });
const ops = (op: string) => events().filter((e) => e.data.op === op);
const epochs = () => ops("reviewer_swap");
const reviewers = () => f.db.query("SELECT agent, sessionId, family, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'reviewer' ORDER BY rowid").all();
const exemption = (id = askId) => `${EXEMPTION_TEXT}(批准 ${id})`;
const verdict = (verdict: "pass" | "changes" = "pass") => {
  const findings = join(f.dir, `ex-${Date.now()}.json`);
  writeFileSync(findings, "[]");
  return f.cliWith({ callerSession: "s-ex" }, EX, "review", "T1", "--reviewer", EX, "--verdict", verdict, "--p0", "0", "--p1", "0", "--p2", "0",
    "--head", H1, "--session", "s-ex", "--family", "claude", "--findings", findings, "--path", "reviews/T1-r1/report.md");
};
/** First refusal through the tick: the epoch; then the new session is created, bound and sent the same order. */
async function exempted() {
  failWith(CYBER);
  expect(await tick()).toMatchObject({ step: "refusal_epoch" });
  failWith(null);
  expect(await tick()).toMatchObject({ step: "session" });
  expect(await tick()).toMatchObject({ step: "sent" });
}
const mergePlan = () => {
  const t = f.task();
  return () => planIntent(f.db, f.at("scheduler"), { id: `merge-${t.rev}`, taskId: "T1", taskRev: t.rev, workflowRev: getWorkflow(f.db, "T1")!.rev,
    causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "merge", node: "merge_deploy", reason: "合并" });
};

describe("first policy refusal → straight to the exemption (test 1)", () => {
  test("epoch: old binding retired with history, new author-family session marked exempt, same materials, crossModel false", async () => {
    failWith(CYBER);
    const { step, detail } = (await tick())!;
    expect(step).toBe("refusal_epoch");
    expect(detail).toContain(exemption());
    expect(detail).toContain("owner 14:45 去掉同模型重试"); // MODEL still records retry_same; executed as exempt_review
    const plan = ops("model_refusal_retry");
    expect(plan).toHaveLength(1);
    expect(epochs()).toMatchObject([{ dedupKey: `refusal-epoch:${plan[0].seq}`, data: { op: "reviewer_swap", intentId: first.id, fromFamily: "codex",
      toFamily: "claude", agent: "agent-rv-t1", sessionId: "s-rv", head: H1, round: 1, refusal: { planSeq: plan[0].seq, planKind: "retry_same",
        executed: "exempt_review", approvalId: askId, exemption: exemption(), crossModel: false, note: "owner 14:45 去掉同模型重试" } } }]);
    expect(reviewers()).toEqual([{ agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", state: "retired" }]);
    expect(ops("fallback_manual")).toEqual([]);

    failWith(null);
    expect(await tick()).toMatchObject({ step: "session" });
    expect(created).toEqual([{ family: "claude", tag: "-ex" }]);
    expect(reviewers()).toEqual([{ agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", state: "retired" },
      { agent: EX, sessionId: "s-ex", family: "claude", state: "active" }]);
    expect(ops("session_bind").at(-1)).toMatchObject({ data: { role: "reviewer", agent: EX, family: "claude", refusalEpoch: epochs()[0].seq,
      approvalId: askId, exemption: exemption(), crossModel: false } });

    const sentBefore = f.sent.length;
    expect(await tick()).toMatchObject({ step: "sent" });
    const second = f.intents().findLast((i) => i.action === "review")!;
    expect(second).toMatchObject({ recipient: EX });
    const orig = f.sent.find((s) => s.agent === "agent-rv-t1")!, again = f.sent.slice(sentBefore).find((s) => s.agent === EX)!;
    const strip = (t: string, id: string, agent: string) => t.replaceAll(id, "<order>").replaceAll(agent, "<reviewer>");
    expect(strip(again.text, second.id, EX)).toBe(strip(orig.text, first.id, "agent-rv-t1")); // the order is the same, word for word
    const sent2 = getIntent(f.db, second.id)!;
    expect(reviewMaterialDigest(f.task(), sent2)).toBe(String(plan[0].data.materialDigest));
  });

  test("the exempt verdict goes through take_review / verdict as usual, then passes the planner and both merge gates", async () => {
    await exempted();
    expect(await verdict()).toMatchObject({ ok: true });
    expect(events().findLast((e) => e.kind === "review")).toMatchObject({ data: { reviewer: EX, reviewerSessionId: "s-ex", reviewerFamily: "claude" } });
    expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toThrow();
    expect(mergePlan()).not.toThrow();
  });
});

describe("the exempt review refused too → manual (test 3)", () => {
  test("no second epoch, no third provider; MODEL holds; the owner gets one inform per kind and one action note per card", async () => {
    await exempted();
    failWith(USAGE);
    expect(await tick()).toMatchObject({ step: "manual" });
    expect(epochs()).toHaveLength(1);
    expect(ops("model_safety_hold")).toHaveLength(1);
    expect(ops("refusal_owner_inform").map((e) => e.data.refusal)).toEqual(["cyber_policy", "usage_policy"]);
    expect(ops("refusal_owner_inform")[0].text).toContain(exemption());
    expect(ops("refusal_owner_manual")).toMatchObject([{ data: { kind: "action", audience: "owner", epochSeq: epochs()[0].seq } }]);
    for (let n = 0; n < 3; n++) await tick();
    expect(epochs()).toHaveLength(1);
    expect(ops("refusal_owner_manual")).toHaveLength(1);
    expect(created).toHaveLength(1);
  });

  test("an exempt_review plan in a window that already had its epoch is refused by the executor", async () => {
    await exempted();
    const sent = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
    const plan = insertEvent(f.db, { actor: "scheduler", now: f.at("x").now }, { project: "p", target: "T1", kind: "escalate", text: "x", data: {
      op: "model_refusal_exempt", mode: "on", cls: "safety", role: "reviewer", stale: false, intentId: sent.id, head: H1, specRev: f.task().specRev,
      round: 1, session: "s-ex", family: "claude", approvalId: askId, materialDigest: reviewMaterialDigest(f.task(), sent), plan: { kind: "exempt_review" } } }, true);
    expect(() => beginRefusalEpoch(f.db, f.at("scheduler"), "T1", plan.seq)).toThrow("本轮已做过豁免审查");
  });
});

describe("guards: nothing runs, the card goes to PM (test 4)", () => {
  /** MODEL's on-mode record only, as the wiring writes it, without running it. */
  function record(digest = reviewMaterialDigest(f.task(), first)) {
    const r = recordModelOutcome(f.db, f.at("scheduler"), { intentId: first.id, signal: { failure: { kind: "error", message: CYBER } },
      failed: { family: "codex", machine: "local", agent: "agent-rv-t1" }, authorized: [{ family: "codex", machine: "local" }, { family: "claude", machine: "local" }],
      ended: true, review: { sessionId: "s-rv", materialDigest: digest } },
    () => ({ mode: "on", manualAfterMs: null }), createRefusalApprovalPort(f.db));
    expect(r).toMatchObject({ kind: "recorded", plan: { kind: "retry_same" } });
    return (r as { event: { seq: number } }).event.seq;
  }
  const untouched = () => {
    expect(epochs()).toEqual([]);
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
  };
  for (const [name, change, why] of [
    ["approval revoked", () => { answer("policy_refusal_rule_stop", 3000); }, "批准 id 与计划不一致"],
    ["card held by the owner", () => f.db.run("UPDATE tasks SET extra = json_set(extra, '$.refusalHold', json('true')) WHERE id = 'T1'"), "extra.refusalHold"],
    ["head moved", () => f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["e".repeat(40)]), "head / specRev / 轮次已变"],
    ["spec moved", () => f.db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'"), "head / specRev / 轮次已变"],
  ] as const) {
    test(`${name}: refused, no epoch, binding kept`, () => {
      const seq = record();
      change();
      expect(() => beginRefusalEpoch(f.db, f.at("scheduler"), "T1", seq)).toThrow(why);
      untouched();
    });
  }

  test("material digest differs from the order's: refused, no epoch, binding kept", () => {
    const seq = record(`sha256:${"0".repeat(64)}`);
    expect(() => beginRefusalEpoch(f.db, f.at("scheduler"), "T1", seq)).toThrow("材料摘要不一致");
    untouched();
  });

  test("held or revoked before the refusal: MODEL itself holds, the tick escalates, nothing runs", async () => {
    f.db.run("UPDATE tasks SET extra = json_set(extra, '$.refusalHold', json('true')) WHERE id = 'T1'");
    failWith(CYBER);
    expect(await tick()).toMatchObject({ step: "manual" });
    untouched();
    expect(ops("refusal_owner_inform")).toHaveLength(1);
  });

  test("only the scheduler runs it, and only MODEL's recorded continuation events", () => {
    const seq = record();
    expect(() => beginRefusalEpoch(f.db, f.at("pm"), "T1", seq)).toThrow("只由调度服务");
    expect(() => beginRefusalEpoch(f.db, f.at("scheduler"), "T1", seq - 1)).toThrow("不是 MODEL 记下的拒审接续计划");
    untouched();
  });

  for (const mode of ["observe", "off"]) {
    test(`${mode}: nothing executes, escalated as before`, async () => {
      g.__modelxMode = mode;
      failWith(CYBER);
      expect(await tick()).toMatchObject({ step: "manual" });
      untouched();
      expect(ops("refusal_owner_inform")).toEqual([]);
    });
  }
});

describe("one run per plan event (test 5)", () => {
  test("replayed writer calls and repeated ticks: one epoch, one new session", async () => {
    failWith(CYBER);
    await tick();
    const seq = Number(epochs()[0].data.refusal && (epochs()[0].data.refusal as { planSeq: number }).planSeq);
    expect(beginRefusalEpoch(f.db, f.at("scheduler"), "T1", seq)).toMatchObject({ duplicate: true, event: { seq: epochs()[0].seq } });
    failWith(null);
    for (let n = 0; n < 4; n++) await tick();
    expect(epochs()).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(ops("model_refusal_retry")).toHaveLength(1);
    expect(f.intents().filter((i) => i.action === "review" && i.recipient === EX)).toHaveLength(1);
  });
});

describe("ordinary cards keep their continuity rules (test 6)", () => {
  test("without an epoch a new reviewer session is still a binding conflict", () => {
    const t = f.task();
    const ensure = planIntent(f.db, f.at("scheduler"), { id: "manual-ensure", taskId: "T1", taskRev: t.rev, workflowRev: getWorkflow(f.db, "T1")!.rev,
      causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "ensure_session", node: "adversarial_review", reason: "换新会话" }).intent;
    settleIntent(f.db, f.at("scheduler"), { id: ensure.id, from: "pending", to: "submitted", receipt: "claimed" });
    expect(() => bindSchedulerSession(f.db, f.at("scheduler"), { taskId: "T1", role: "reviewer", intentId: ensure.id, agent: "agent-rv-t1",
      sessionId: "s-rv-2", family: "codex", transport: "acp", registryPath: f.registryPath })).toThrow("本卡角色已绑定另一个 session");
  });
});

describe("merge gates: only the round's recorded, approved exemption passes a same-family verdict", () => {
  async function passed() {
    expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  }
  function forgeEpoch(over: Record<string, unknown> = {}, at: Record<string, unknown> = {}) {
    insertEvent(f.db, { actor: "scheduler", now: f.at("x").now }, { project: "p", target: "T1", kind: "scheduler", text: "forged",
      data: { op: "reviewer_swap", intentId: first.id, agent: "agent-rv-t1", sessionId: "s-old", toFamily: "codex", round: f.task().round, head: H1,
        specRev: f.task().specRev, ...at, refusal: { planSeq: 1, approvalId: askId, crossModel: false, exemption: exemption(), ...over } } }, true);
    insertEvent(f.db, { actor: "scheduler", now: f.at("x").now }, { project: "p", target: "T1", kind: "scheduler", text: "forged bind",
      data: { op: "session_bind", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", refusalEpoch: -1, approvalId: askId } }, true);
  }
  const refused = () => {
    f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
    expect(mergePlan()).toThrow("合并前缺跨模型审查");
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toThrow("跨模型审查");
  };

  test("control: the cross-family verdict passes both gates", async () => {
    await passed();
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toThrow();
  });
  for (const [name, over, at] of [["no mark at all", null, {}], ["a mark with a mismatched approval id", { approvalId: "ask_other" }, {}],
    ["an epoch of an old head", {}, { head: "9".repeat(40) }], ["an epoch of another round", {}, { round: 99 }],
    ["a well-formed mark the reviewer was never bound under", {}, {}]] as const) {
    test(`same family as the author with ${name}: both gates refuse`, async () => {
      await passed();
      if (over) forgeEpoch(over, at);
      refused();
    });
  }

  test("the real exemption, approval revoked after the verdict: both gates refuse", async () => {
    await exempted();
    expect(await verdict()).toMatchObject({ ok: true });
    expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    answer("policy_refusal_rule_stop", 3000);
    expect(mergePlan()).toThrow("合并前缺跨模型审查");
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toThrow("跨模型审查");
  });
});
