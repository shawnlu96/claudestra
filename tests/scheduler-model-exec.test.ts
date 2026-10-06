/**
 * dispatch-recovery-MODELX under the safety boundary (PM 10-06 03:45): a provider's safety refusal is never retried
 * automatically in a new session, family or provider. MODEL's on-mode retry_same / exempt_review plans stay records: the card
 * pauses for PM / owner, the evidence stays, the owner hears once per card and refusal kind (inform note, no push), and no
 * exemption-looking ledger entry lets a same-family verdict through either merge gate. Real ledger, synthetic workers.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { EXEMPTION_TEXT } from "../src/lib/scheduler-model-outcome.js";
import { modelOutcomeStep, setModelOutcomeReader, type ModelWiringCard } from "../src/lib/scheduler-model-wiring.js";
import { bindSchedulerSession, getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const USAGE = "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy";
const dir = mkdtempSync(join(tmpdir(), "modelx-"));
const g = globalThis as { __modelxMode?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelxMode, manualAfterMs: null }; }\n");

let f: ReturnType<typeof autoFixture>;
let first: SchedulerIntent;
let errors: ReturnType<typeof spyOn>;
beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__modelxMode = "on";
  f = autoFixture();
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
  first = getIntent(f.db, f.intents().findLast((i) => i.action === "review")!.id)!;
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelxMode; });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function approve() {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, 1000);
  answerAsk(f.db, ask.id, { choices: ["[button:policy_refusal_rule_go]"], labels: ["go"], text: "", principal: OWNER_PRINCIPAL_ID,
    owner: true, via: "web_card", at: 2000, final: true });
}
function failWith(message: string, kind: "error" | "quota" = "error") {
  const real = f.tickDeps.worker;
  f.tickDeps.worker = (ref) => {
    const w = real(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind, message } }) };
  };
}
const events = () => listEvents(f.db, { project: "p", target: "T1" });
const informs = () => events().filter((e) => e.data.op === "refusal_owner_inform");
const swaps = () => events().filter((e) => e.data.op === "reviewer_swap");
const reviewers = () => f.db.query("SELECT agent, sessionId, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'reviewer'").all();
const card = (): ModelWiringCard => ({ db: f.db, task: f.task(), opts: {}, deps: { now: () => f.at("x").now! } });
const rv = (sessionId: string, over: Partial<SessionRef> = {}): SessionRef =>
  ({ taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId, family: "codex", transport: "acp", ...over });
/** A formal new review ticket in the same window, as MODELW's tests make one. */
function ticket(id: string): SchedulerIntent {
  const t = f.task();
  return planIntent(f.db, f.at("scheduler"), { id, taskId: t.id, taskRev: t.rev, workflowRev: getWorkflow(f.db, t.id)!.rev,
    causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "review", node: "adversarial_review", reason: "ticket" }).intent;
}

describe("a safety refusal under on pauses the card; MODEL's continuation plan is never executed", () => {
  test("approved first refusal: retry_same recorded with its evidence, escalated as paused, no epoch / new session / new order", async () => {
    approve();
    failWith(CYBER);
    const intents = f.intents().length;
    const { step, detail } = (await f.tick())!;
    expect(step).toBe("manual");
    expect(detail).toContain("MODEL 计划：retry_same（批准 ");
    expect(detail).toContain("提供方安全拒绝保持暂停：不自动换会话 / 家族 / 提供方重试");
    expect(detail).not.toContain("执行路径待 MODELX");
    expect(events().find((e) => e.data.op === "model_refusal_retry")).toMatchObject({ data: { evidence: CYBER, noReport: true, verdict: null, session: "s-rv" } });
    for (let n = 0; n < 4; n++) await f.tick();
    expect(f.intents()).toHaveLength(intents);
    expect(f.intents().some((i) => i.action === "review_swap" || (i.action === "ensure_session" && i.node === "adversarial_review" && i.status === "pending"))).toBe(false);
    expect(swaps()).toEqual([]);
    expect(reviewers()).toEqual([{ agent: "agent-rv-t1", sessionId: "s-rv", state: "active" }]);
  });

  test("old path stays closed: a new reviewer session after the record is still a binding conflict", async () => {
    approve();
    expect(await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER })).toContain("保持暂停");
    const t = f.task();
    const ensure = planIntent(f.db, f.at("scheduler"), { id: "manual-ensure", taskId: "T1", taskRev: t.rev, workflowRev: getWorkflow(f.db, "T1")!.rev,
      causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "ensure_session", node: "adversarial_review", reason: "换新会话" }).intent;
    settleIntent(f.db, f.at("scheduler"), { id: ensure.id, from: "pending", to: "submitted", receipt: "claimed" });
    expect(() => bindSchedulerSession(f.db, f.at("scheduler"), { taskId: "T1", role: "reviewer", intentId: ensure.id, agent: "agent-rv-t1",
      sessionId: "s-rv-2", family: "codex", transport: "acp", registryPath: f.registryPath })).toThrow("本卡角色已绑定另一个 session");
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
  });

  test("exempt_review plan (second refusal, new ticket) is paused the same way: no switch to the author's family", async () => {
    approve();
    await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
    const exempt = await modelOutcomeStep(card(), ticket("t2"), rv("s-rv-2"), { kind: "error", message: CYBER });
    expect(exempt).toContain("MODEL 计划：exempt_review（批准 ");
    expect(exempt).toContain("保持暂停");
    expect(swaps()).toEqual([]);
    expect(f.intents().some((i) => i.action === "review_swap")).toBe(false);
  });
});

describe("the owner hears once per card and refusal kind (inform, no push)", () => {
  test("one inform for repeated cyber refusals; a usage-policy refusal is its own kind; replayed ticks add nothing", async () => {
    approve();
    const before = f.notices.length;
    await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
    await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
    const t2 = ticket("t2");
    await modelOutcomeStep(card(), t2, rv("s-rv-2"), { kind: "error", message: CYBER });
    settleIntent(f.db, f.at("scheduler"), { id: t2.id, from: "pending", to: "cancelled", receipt: "拒审，原单终止" });
    expect(informs()).toHaveLength(1);
    expect(informs()[0]).toMatchObject({ kind: "note", data: { kind: "inform", audience: "owner", refusal: "cyber_policy" } });
    expect(informs()[0].text).toContain("不自动重试");
    expect(informs()[0].text).toContain("refusalHold");
    await modelOutcomeStep(card(), ticket("t3"), rv("s-claude", { agent: "agent-claude-rv", family: "claude", transport: "tmux" }), { kind: "error", message: USAGE });
    expect(informs().map((e) => e.data.refusal)).toEqual(["cyber_policy", "usage_policy"]);
    expect(f.notices.length).toBe(before); // an inform is a ledger note, never a push
  });

  test("no approval: MODEL's hold, still paused, still one inform", async () => {
    failWith(CYBER);
    expect(await f.tick()).toMatchObject({ step: "manual" });
    expect(events().find((e) => e.data.op === "model_safety_hold")).toBeTruthy();
    expect(informs()).toHaveLength(1);
  });

  test("card held by the owner (extra.refusalHold): MODEL holds, nothing runs, one inform", async () => {
    approve();
    f.db.run("UPDATE tasks SET extra = json_set(extra, '$.refusalHold', json('true')) WHERE id = 'T1'");
    expect(await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER })).toBe("");
    expect(events().find((e) => e.data.op === "model_safety_hold")!.data.plan).toMatchObject({ kind: "manual", reason: expect.stringContaining("owner 已挂起") });
    expect(swaps()).toEqual([]);
    expect(informs()).toHaveLength(1);
  });

  test("observe and off inform nobody", async () => {
    approve();
    g.__modelxMode = "observe";
    await modelOutcomeStep(card(), first, rv("s-rv"), { kind: "error", message: CYBER });
    g.__modelxMode = "off";
    await modelOutcomeStep(card(), ticket("t2"), rv("s-rv-2"), { kind: "error", message: CYBER });
    expect(informs()).toEqual([]);
  });

  test("capacity is not a safety refusal: no inform, redispatch text unchanged", async () => {
    const peer = rv("s-peer", { agent: "peer-rv", transport: "peer" });
    expect(await modelOutcomeStep(card(), first, peer, { kind: "quota", message: "You've hit your usage limit" }))
      .toContain("MODEL 计划：redispatch（→ local（codex），无现成正式路径），执行路径待 MODELX");
    expect(informs()).toEqual([]);
  });
});

describe("merge gates honour no exemption: same-family verdicts are refused", () => {
  /** A passing verdict by the bound codex reviewer, then the card in merge. */
  async function passed() {
    expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  }
  function forgeEpoch(over: Record<string, unknown> = {}) {
    insertEvent(f.db, { actor: "scheduler", now: f.at("x").now }, { project: "p", target: "T1", kind: "scheduler", text: "forged",
      data: { op: "reviewer_swap", intentId: "refusal-epoch:s1", agent: "agent-rv-t1", sessionId: "s-rv", round: f.task().round, head: H1,
        specRev: f.task().specRev, refusal: { kind: "exempt_review", family: "codex", crossModel: false, approvalId: "ask_x",
          exemption: `${EXEMPTION_TEXT}(批准 ask_x)`, ...over } } }, true);
  }
  const mergePlan = () => {
    const t = f.task();
    return () => planIntent(f.db, f.at("scheduler"), { id: "merge-x", taskId: "T1", taskRev: t.rev, workflowRev: getWorkflow(f.db, "T1")!.rev,
      causalSeq: listEvents(f.db, { project: "p" }).at(-1)!.seq, action: "merge", node: "merge_deploy", reason: "合并" });
  };

  test("control: the cross-family verdict passes both gates", async () => {
    await passed();
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toThrow();
  });

  for (const [name, over] of [["no mark at all", null], ["a mark with a mismatched approval id", { approvalId: "ask_other" }],
    ["an epoch of an old head", { head: "9".repeat(40) }], ["an epoch of another round", { round: 99 }], ["a well-formed mark", {}]] as const) {
    test(`same family as the author with ${name}: both gates refuse`, async () => {
      await passed();
      if (over) forgeEpoch(over);
      f.db.run("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'");
      expect(mergePlan()).toThrow("合并前缺跨模型审查");
      expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toThrow("跨模型审查");
    });
  }
});
