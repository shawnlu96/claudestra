/**
 * RVF-1 · the cross-family reviewer's family cannot run → the round falls back to a same-family adversarial reviewer instead of PM.
 * The production tick on a temp ledger (autoFixture) with a fake swap runtime, reviewFallback / modelOutcome read from a stand-in CFG
 * module: a review turn on quota and a reviewer create failing (the 10-16 NRT-1 receipt word for word; quota at once, other clean
 * failures after 3) both open one fallback epoch; any other turn failure and an author on quota do not; observe only records; off
 * does nothing and withdraws an epoch in flight; the fallback verdict passes the verdict gate but no merge road takes it without
 * PM; the next round goes back to the cross family. Round-1 adversarial findings: reviews/RVF-1-r1-adv.md (S2 S3 S5 S6, P2-3 P2-6).
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { createRetryBackoff } from "../src/lib/scheduler-create-retry.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { setModelOutcomeReader } from "../src/lib/scheduler-model-wiring.js";
import { classifyModelOutcome, resolveSafetyHold } from "../src/lib/scheduler-model-outcome.js";
import { CREATE_FAIL_LIMIT, failureText, FALLBACK_EXEMPTION, fallbackHandoff, fallbackNotice, freshFallbackEpoch, setFallbackPolicyFile } from "../src/lib/scheduler-review-fallback.js";
import { replacementTag } from "../src/lib/scheduler-review-checkout.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { EnsureResult } from "../src/lib/worker-session.js";
import { autoFixture, H1, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

/** The 10-16 NRT-1 reviewer create failure, as retryCleanCreate wrote it (receipt = `未建：` + this). */
const NRT1_CREATE = "建会话失败，现场已清理（reviewer agent-rv-nrt-1 第 1 次；2 分钟后、最早 2026-10-16T11:18:06.842Z 重试）：创建失败: Codex（ACP）" +
  "引导没拿到 thread id：引导轮失败：You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again " +
  "at Oct 22nd, 2026 2:13 PM.（已清理：窗口已关；频道已删；占位已删）";
const CREATE_ERROR = (n: number) => `建会话失败，现场已清理（reviewer agent-rv-t1 第 ${n} 次；2 分钟后重试）：创建失败: 窗口起不来`;
const QUOTA_TURN = "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 2:13 PM.";
const FB = "agent-task-rv-t1-r1-fb";

const dir = mkdtempSync(join(tmpdir(), "rvf1-"));
const g = globalThis as { __rvfMode?: string; __moMode?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy(_p, m) { return { mode: m === 'reviewFallback' ? globalThis.__rvfMode : globalThis.__moMode, " +
  "manualAfterMs: null, source: 'config' }; }\n");

let f: ReturnType<typeof autoFixture>;
let errors: ReturnType<typeof spyOn>;
let created: { family: string; tag?: string; old: string | null }[];
let swapCreate: ((n: number) => EnsureResult | null) | null;
let projects: Record<string, { maxActiveWorkers: number; localMerge?: boolean; mergeHandoff?: boolean }>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__rvfMode = "on";
  g.__moMode = "observe";
  created = [];
  swapCreate = null;
  projects = { p: { maxActiveWorkers: 2 } };
  f = autoFixture();
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); setFallbackPolicyFile(); delete g.__rvfMode; delete g.__moMode; });
/** CFG's own file (what the gates read synchronously) says reviewFallback is off for project p — or is invalid (CFG: off too). */
function switchOff(content: object = { projects: { p: { keys: { reviewFallback: "off" } } } }) {
  const file = join(dir, `policy-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(content));
  setFallbackPolicyFile(file);
}
const INVALID = { projects: { p: { keys: { reviewFallback: "on" }, junk: 1 } } }; // adv4 E: CFG's strict reader answers off
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const editRegistry = (fn: (r: { agents: Record<string, Record<string, unknown>> }) => void) => {
  const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
  fn(r);
  writeFileSync(f.registryPath, JSON.stringify(r));
};
/** The swap runtime's create, faked: a new registry agent named per round and tag; swapCreate may make it fail instead. */
const swapDeps = (): ReviewSwapDeps => ({
  registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: async () => ({ ok: true }),
  ensure: async (task, family, old, tag) => {
    const fail = swapCreate?.(created.length + 1);
    created.push({ family, tag, old: old?.sessionId ?? null });
    if (fail) return fail;
    const agent = `agent-task-rv-t1-r${task.round}${tag}`, sessionId = `s-${task.round}${tag}`;
    editRegistry((r) => { r.agents[agent] = { runtime: family === "codex" ? "codex" : "claude-code", sessionId, cwd: join(f.dir, agent) }; });
    return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent, sessionId, family, transport: "tmux" } };
  },
});
async function tick() {
  const manager = (...a: string[]) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message })) : f.tickDeps.manager(...a);
  // the service's read-only handle, as in production: every fallback write must go through the ledger CLI (writer process)
  const r = await schedulerAutoTick(f.reader.get()!, projects, { ...f.tickDeps, manager });
  if (r.failed.length) throw new Error(JSON.stringify(r.failed));
  return r.cards[0];
}
const events = () => listEvents(f.db, { project: "p", target: "T1" });
const ops = (op: string) => events().filter((e) => e.data.op === op);
const epochs = () => ops("reviewer_swap");
const reviewers = () => f.db.query("SELECT agent, family, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'reviewer' ORDER BY rowid").all();

/** Every bound worker of `family` reports this failure for its turn; null restores the fixture's own worker. */
const realWorker = new WeakMap<object, typeof f.tickDeps.worker>();
function failTurns(family: "codex" | "claude", message: string | null, kind: "quota" | "error" = "quota") {
  const worker = realWorker.get(f) ?? f.tickDeps.worker;
  realWorker.set(f, worker);
  f.tickDeps.worker = message === null ? worker : (ref) => {
    const w = worker(ref);
    return "manual" in w || ref.family !== family ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind, message } }) };
  };
}
/** The fixture's reviewer ensure fails clean with these texts in turn (retryCleanCreate's "wait"); authors are untouched. */
function failCreates(...reasons: string[]) {
  const ensure = f.tickDeps.ensure;
  f.tickDeps.ensure = async (task, role, family) => role === "reviewer" && reasons.length ? { kind: "wait", reason: reasons.shift()! } : ensure(task, role, family);
}
async function delivered() {
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
}
/** Delivered, the codex reviewer bound and its order sent. */
async function reviewSent() {
  await delivered();
  expect(await tick()).toMatchObject({ step: "session" });
  expect(await tick()).toMatchObject({ step: "sent" });
}
const verdict = (agent: string, session: string, verdict: "pass" | "changes", rows: object[] = []) => {
  const findings = join(f.dir, `fb-${Date.now()}-${Math.random()}.json`);
  writeFileSync(findings, JSON.stringify(rows));
  const p1 = String(rows.filter((r) => (r as { severity: string }).severity === "P1").length);
  return f.cliWith({ callerSession: session }, agent, "review", "T1", "--reviewer", agent, "--verdict", verdict, "--p0", "0", "--p1", p1, "--p2", "0",
    "--head", f.task().headSHA!, "--session", session, "--family", "claude", "--findings", findings, "--path", `reviews/T1-r${f.task().round}/report.md`);
};
/** After the epoch: the same-family reviewer is created (swap runtime, -fb), bound under it and sent the ordinary review order. */
async function fallbackReviewing() {
  expect(await tick()).toMatchObject({ step: "session" });
  expect(await tick()).toMatchObject({ step: "sent" });
  expect(f.intents().findLast((i) => i.action === "review")).toMatchObject({ recipient: FB });
}

describe("review turn on quota (acceptance 1, 2)", () => {
  test("on: one fallback epoch, the failed binding retired, a new claude session bound under it, the same adversarial order", async () => {
    await reviewSent();
    const first = f.intents().findLast((i) => i.action === "review")!;
    failTurns("codex", QUOTA_TURN);
    const r = (await tick())!;
    expect(r.step).toBe("review_fallback");
    expect(r.detail).toContain(FALLBACK_EXEMPTION);
    expect(ops("fallback_manual")).toEqual([]);
    expect(ops("model_outcome")).toEqual([]); // the fallback runs first: MODEL never records an escalation for a round that went on
    expect(epochs()).toMatchObject([{ dedupKey: `review-fallback:${first.id}`, data: { intentId: first.id, fromFamily: "codex", toFamily: "claude",
      agent: "agent-rv-t1", sessionId: "s-rv", round: 1, head: H1,
      fallback: { trigger: "review_capacity", reason: QUOTA_TURN, failedAgent: "agent-rv-t1", exemption: FALLBACK_EXEMPTION, crossModel: false } } }]);
    expect(reviewers()).toEqual([{ agent: "agent-rv-t1", family: "codex", state: "retired" }]);
    failTurns("codex", null);
    await fallbackReviewing();
    expect(created).toEqual([{ family: "claude", tag: "-fb", old: "s-rv" }]);
    expect(ops("session_bind").at(-1)).toMatchObject({ data: { role: "reviewer", agent: FB, family: "claude", fallbackEpoch: epochs()[0].seq,
      crossModel: false, exemption: FALLBACK_EXEMPTION } });
    const strip = (t: string, id: string, agent: string) => t.replaceAll(id, "<order>").replaceAll(agent, "<reviewer>");
    const orig = f.sent.find((s) => s.agent === "agent-rv-t1")!, again = f.sent.find((s) => s.agent === FB)!;
    expect(strip(again.text, f.intents().findLast((i) => i.action === "review")!.id, FB)).toBe(strip(orig.text, first.id, "agent-rv-t1"));
  });

  for (const [what, message] of [["S2 an input too long", "Error: turn failed: context_length_exceeded (input too long)"],
    ["S6 a refusal worded past MODEL's patterns", "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again."]]) {
    test(`a turn failure that is not the host's quota never falls back (${what}): MODEL's record, the card to PM, the binding kept`, async () => {
      await reviewSent();
      failTurns("codex", message, "error");
      expect(await tick()).toMatchObject({ step: "manual" });
      expect(epochs()).toEqual([]);
      expect(created).toEqual([]);
      expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
      expect(ops("model_outcome")).toMatchObject([{ data: { cls: "host", plan: { kind: "manual" } } }]);
      expect(ops("recovery_observe").filter((e) => e.data.mechanism === "reviewFallback")).toEqual([]);
    });
  }

  test("modelOutcome on: a round that fell back pushes PM no 容量不足 escalation (P2-3)", async () => {
    g.__moMode = "on";
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    expect(await tick()).toMatchObject({ step: "review_fallback" });
    expect(events().filter((e) => (e.text ?? "").includes("容量不足") || e.data.kind === "escalate")).toEqual([]);
    expect(f.notices.filter((n) => n.includes("容量不足") || n.includes("退回人工"))).toEqual([]);
  });

  test("the fallback reviewer on quota too: no second switch in the round, the card goes to PM as before", async () => {
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    await tick();
    failTurns("codex", null);
    await fallbackReviewing();
    failTurns("claude", "API Error: 429 rate limit exceeded");
    expect(await tick()).toMatchObject({ step: "manual" });
    expect(epochs()).toHaveLength(1);
    expect(ops("fallback_manual")).toHaveLength(1);
  });
});

describe("reviewer create fails (acceptance 1 addendum: the 10-16 NRT-1 path)", () => {
  test("quota on the first create: fallback at once, the claude reviewer created with no backoff, bound with no prior binding", async () => {
    await delivered();
    failCreates(NRT1_CREATE);
    const r = (await tick())!;
    expect(r.step).toBe("review_fallback");
    const ensure = f.intents().findLast((i) => i.action === "ensure_session")!;
    expect(getIntent(f.db, ensure.id)).toMatchObject({ status: "cancelled", receipt: `未建：${NRT1_CREATE}` });
    expect(epochs()).toMatchObject([{ data: { intentId: ensure.id, fromFamily: "codex", toFamily: "claude", agent: null, sessionId: null,
      fallback: { trigger: "create_quota", reason: `未建：${NRT1_CREATE}`.slice(0, 600) } } }]);
    expect(createRetryBackoff(f.db, "T1", "reviewer", f.tickDeps.now())).toBeNull();
    expect(classifyModelOutcome({ failure: { kind: "error", message: failureText(`未建：${NRT1_CREATE}`, "NRT-1") } })?.cls).toBe("capacity");
    await fallbackReviewing();
    expect(created).toEqual([{ family: "claude", tag: "-fb", old: null }]);
    expect(reviewers()).toEqual([{ agent: FB, family: "claude", state: "active" }]);
    expect(ops("session_bind").at(-1)).toMatchObject({ data: { fallbackEpoch: epochs()[0].seq, crossModel: false } });
  });

  test(`a clean failure that is not quota falls back only on the ${CREATE_FAIL_LIMIT}rd in a row`, async () => {
    await delivered();
    failCreates(CREATE_ERROR(1), CREATE_ERROR(2), CREATE_ERROR(3));
    for (let n = 1; n < CREATE_FAIL_LIMIT; n++) {
      expect(await tick()).toMatchObject({ step: "waiting" });
      expect(epochs()).toEqual([]);
      f.advance(20 * 60_000); // past retryCleanCreate's backoff
    }
    expect(await tick()).toMatchObject({ step: "review_fallback" });
    expect(epochs()[0].data.fallback).toMatchObject({ trigger: "create_streak" });
  });

  const REFUSED = (n: number, more = "") => `建会话失败，现场已清理（reviewer agent-rv-t1 第 ${n} 次；2 分钟后重试）：创建失败: 引导轮失败：${more}` +
    "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).";
  for (const [what, receipts] of [["three bootstrap receipts that are safety refusals", [REFUSED(1), REFUSED(2), REFUSED(3)]],
    ["a refusal mixed with quota wording, then plain errors", [REFUSED(1, "429 rate limit exceeded; "), CREATE_ERROR(2), CREATE_ERROR(3)]]] as const) {
    test(`a safety refusal in the create streak never falls back (PR1685-r1, ${what}): no epoch, no family switch`, async () => {
      await delivered();
      failCreates(...receipts);
      for (let n = 0; n < receipts.length; n++) {
        expect(await tick()).toMatchObject({ step: "waiting" });
        f.advance(20 * 60_000); // past retryCleanCreate's backoff
      }
      expect(epochs()).toEqual([]);
      expect(created).toEqual([]);
      expect(ops("recovery_observe").filter((e) => e.data.mechanism === "reviewFallback")).toEqual([]);
      expect(ops("model_safety_hold")).toMatchObject([{ kind: "escalate", data: { cls: "safety", role: "reviewer", action: "ensure_session" } }]);
    });
  }

  test("the hold stands until PM resolves it (resolveSafetyHold); only then may an ordinary streak fall back", async () => {
    await delivered();
    failCreates(REFUSED(1), CREATE_ERROR(2), CREATE_ERROR(3), CREATE_ERROR(4));
    for (let n = 0; n < 3; n++) {
      expect(await tick()).toMatchObject({ step: "waiting" });
      f.advance(20 * 60_000);
    }
    expect(epochs()).toEqual([]);
    resolveSafetyHold(f.db, f.at("pm"), { taskId: "T1", text: "PM 核过：拒绝来自引导轮误判，可以照常处理" });
    expect(await tick()).toMatchObject({ step: "review_fallback" });
    expect(epochs()[0].data.fallback).toMatchObject({ trigger: "create_streak" });
  });

  test("a refusal never ages out of a long streak (PR1685-r2): 1 refusal then 101 ordinary clean failures, still no epoch", async () => {
    await delivered();
    const receipts = [REFUSED(1), ...Array.from({ length: 101 }, (_, n) => CREATE_ERROR(n + 2))];
    failCreates(...receipts);
    for (let n = 0; n < receipts.length; n++) {
      expect(await tick()).toMatchObject({ step: "waiting" });
      f.advance(20 * 60_000); // past retryCleanCreate's backoff
    }
    expect(f.intents().filter((i) => i.action === "ensure_session" && i.node === "adversarial_review" && i.status === "cancelled")).toHaveLength(102);
    expect(epochs()).toEqual([]);
    expect(created).toEqual([]);
    expect(ops("model_safety_hold")).toHaveLength(1); // the persistent hold, written once at the refusal
  }, 300_000);

  test("a card id like CI-429 never reads as quota: only the failure's own text is judged (P2-6)", () => {
    const receipt = "未建：建会话失败，现场已清理（reviewer agent-rv-ci-429 第 1 次；2 分钟后重试）：创建失败: 窗口起不来（rv-ci-429 已清理）";
    expect(classifyModelOutcome({ failure: { kind: "error", message: receipt } })?.cls).toBe("capacity"); // what the whole receipt would say
    expect(classifyModelOutcome({ failure: { kind: "error", message: failureText(receipt, "CI-429") } })?.cls).toBe("host");
    expect(failureText(receipt, "CI-429")).toBe("创建失败: 窗口起不来（rv- 已清理）");
    // whole tokens only (P2-E): a card named like a word never eats the host's quota wording
    for (const id of ["LIMIT", "A", "USAGE"]) expect(classifyModelOutcome({ failure: { kind: "error", message: failureText(QUOTA_TURN, id) } })?.cls).toBe("capacity");
  });

  test("the author's create / turn is never a fallback: an author on quota still goes to PM", async () => {
    await toBuild(f);
    expect(await tick()).toMatchObject({ step: "sent" }); // the write order
    failTurns("claude", QUOTA_TURN);
    expect(await tick()).toMatchObject({ step: "manual" });
    expect(epochs()).toEqual([]);
    expect(ops("recovery_observe").filter((e) => e.data.mechanism === "reviewFallback")).toEqual([]);
  });
});

describe("switch reviewFallback (acceptance 5)", () => {
  test("observe: one note of where the review would go; the turn failure still goes to PM, nothing retired", async () => {
    g.__rvfMode = "observe";
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    expect(await tick()).toMatchObject({ step: "manual" });
    expect(epochs()).toEqual([]);
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ sessionId: "s-rv", state: "active" });
    const notes = ops("recovery_observe").filter((e) => e.data.mechanism === "reviewFallback");
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toContain("改派 claude 独立对抗审查");
    expect(notes[0].data.reviewFallback).toMatchObject({ trigger: "review_capacity", to: { family: "claude", machine: "local" } });
  });

  test("observe on a create failure: one note per card / round / failed family however often it fails, the card backs off as before", async () => {
    g.__rvfMode = "observe";
    await delivered();
    failCreates(NRT1_CREATE, NRT1_CREATE, NRT1_CREATE);
    for (let n = 0; n < 3; n++) {
      expect(await tick()).toMatchObject({ step: "waiting" });
      f.advance(20 * 60_000); // past retryCleanCreate's backoff
    }
    expect(f.intents().filter((i) => i.action === "ensure_session" && i.node === "adversarial_review" && i.status === "cancelled")).toHaveLength(3);
    expect(epochs()).toEqual([]);
    expect(ops("recovery_observe").filter((e) => e.data.mechanism === "reviewFallback")).toHaveLength(1);
  });

  test("off: nothing recorded, the card goes to PM as before", async () => {
    g.__rvfMode = "off";
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    expect(await tick()).toMatchObject({ step: "manual" });
    expect(epochs()).toEqual([]);
    expect(ops("recovery_observe").filter((e) => e.data.mechanism === "reviewFallback")).toEqual([]);
  });

  test("modelOutcome off does not switch the fallback off (its own key)", async () => {
    g.__moMode = "off";
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    expect(await tick()).toMatchObject({ step: "review_fallback" });
  });

  for (const [what, content] of [["switched off", undefined], ["an invalid policy file (adv4 E)", INVALID]] as const) {
    test(`${what} with an epoch in flight (S5): no fallback reviewer created or sent, the card goes to PM`, async () => {
      await delivered();
      failCreates(NRT1_CREATE);
      expect(await tick()).toMatchObject({ step: "review_fallback" });
      switchOff(content);
      const r = (await tick())!;
      expect(r.step).toBe("manual");
      expect(r.detail).toContain("reviewFallback 已切到 off");
      expect(created).toEqual([]);
      expect(f.sent.filter((s) => s.agent === FB)).toEqual([]);
    });
  }
});

describe("the fallback verdict (acceptance 2, 3)", () => {
  async function fallbackPassed() {
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    await tick();
    failTurns("codex", null);
    await fallbackReviewing();
    expect(await verdict(FB, "s-1-fb", "pass")).toMatchObject({ ok: true });
  }

  test("passes the verdict gate, the review event carries the mark, but a PR project never merges it by itself (S3): PM is asked", async () => {
    await fallbackPassed();
    expect(events().findLast((e) => e.kind === "review")!.data.fallback).toMatchObject({ epochSeq: epochs()[0].seq, trigger: "review_capacity",
      crossModel: false, exemption: FALLBACK_EXEMPTION });
    expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toThrow(); // PM's manual merge queue takes it
    expect(await tick()).toMatchObject({ step: "manual" });
    expect(f.intents().filter((i) => i.action === "merge")).toEqual([]);
    expect(f.notices.at(-1)).toContain("同族降级、无跨族审查");
    expect(f.notices.at(-1)).toContain("本机跨族审查降级为同族");
  });

  for (const [what, content] of [["switched off", undefined], ["an invalid policy file (adv4 E)", INVALID]] as const) {
    test(`${what} after the verdict (S5): no merge gate takes the fallback verdict any more`, async () => {
      await fallbackPassed();
      switchOff(content);
      expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toThrow();
    });
  }

  for (const [kind, project] of [["a PR project (B3)", {}], ["a localMerge project (adv6 I)", { localMerge: true }], ["a handoff project (adv5 G)", { mergeHandoff: true }]] as const) {
    test(`switched off after the verdict, ${kind}: the merge step hands the card to PM at once, saying the fallback was withdrawn`, async () => {
      projects = { p: { maxActiveWorkers: 2, ...project } };
      await fallbackPassed();
      switchOff();
      for (let n = 0; n < 3 && f.task().stage !== "merge"; n++) await tick();
      const r = (await tick())!;
      expect(r.step).toBe("manual");
      expect(getWorkflow(f.db, "T1")!.mode).toBe("manual");
      expect(f.notices.at(-1)).toContain("降级已撤销");
      expect(f.notices.at(-1)).toContain("需要 PM 重派跨族审查或决定");
      expect(f.notices.at(-1)).not.toContain("人工合并队列");
      expect(f.intents().filter((i) => i.action === "merge")).toEqual([]);
    });
  }

  test("handoff evidence and PM's notice name the fallback; the cross-family review is left to the owner's queue", async () => {
    await fallbackPassed();
    const review = mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!);
    expect(fallbackHandoff(events(), f.task(), review)).toMatchObject({ epochSeq: epochs()[0].seq, trigger: "review_capacity", crossModel: false,
      note: "本机跨族审查降级，跨族交仓库方队列" });
    expect(fallbackNotice(f.db, f.task())).toBe(`；本机跨族审查降级为同族（${QUOTA_TURN}），没有跨族审查`);
  });

  test("a localMerge project never merges it by itself: the card waits for PM's ledger local-merge", async () => {
    projects = { p: { maxActiveWorkers: 2, localMerge: true } };
    await fallbackPassed();
    expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    expect(await tick()).toMatchObject({ step: "local_ready" });
    expect(await tick()).toMatchObject({ step: "waiting" });
    expect(f.intents().filter((i) => i.action === "merge")).toEqual([]);
    expect(f.task().stage).toBe("merge");
    expect(f.notices.at(-1)).toContain("ledger local-merge T1");
    expect(f.notices.at(-1)).toContain("本机跨族审查降级为同族");
  });

  test("a same-family verdict of a session not bound under the epoch is refused", async () => {
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    await tick();
    expect(await verdict("agent-task-one", "s-one", "pass")).toMatchObject({ ok: false });
  });
});

describe("recovery: the next round tries the cross family again (acceptance 4)", () => {
  async function fallbackChanges() {
    await reviewSent();
    failTurns("codex", QUOTA_TURN);
    await tick();
    failTurns("codex", null);
    await fallbackReviewing();
    expect(await verdict(FB, "s-1-fb", "changes", [P1])).toMatchObject({ ok: true });
    expect(await tick()).toMatchObject({ step: "stage" }); // review → fix
    await tick(); // fix order
    expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2)).ok).toBe(true);
    expect(f.task()).toMatchObject({ stage: "review", round: 2 });
  }

  test("family available: the fallback session is swapped out and a codex reviewer bound", async () => {
    await fallbackChanges();
    for (let n = 0; n < 6 && created.length < 2; n++) await tick();
    expect(created.at(-1)).toMatchObject({ family: "codex" });
    expect(getSchedulerSession(f.db, "T1", "reviewer")).toMatchObject({ family: "codex", state: "active" });
    expect(epochs().filter((e) => e.data.fallback)).toHaveLength(1);
  });

  test("still unavailable: that round falls back once again, with a new epoch of its own", async () => {
    await fallbackChanges();
    swapCreate = (n) => n === 2 ? { kind: "wait", reason: NRT1_CREATE } : null;
    for (let n = 0; n < 8 && epochs().filter((e) => e.data.fallback).length < 2; n++) await tick();
    const fell = epochs().filter((e) => e.data.fallback);
    expect(fell).toHaveLength(2);
    expect(fell[1].data).toMatchObject({ round: 2, head: H2, sessionId: null, fallback: { trigger: "create_quota" } });
    for (let n = 0; n < 3 && created.length < 3; n++) await tick();
    expect(created.slice(1)).toEqual([{ family: "codex", tag: "", old: "s-1-fb" }, { family: "claude", tag: "-fb", old: null }]);
  });
});

describe("no fallback epoch: unchanged; a fresh epoch never binds the author (review focus)", () => {
  test("a fresh fallback epoch does not let the author's session be bound as the reviewer", async () => {
    await delivered();
    failCreates(NRT1_CREATE);
    expect(await tick()).toMatchObject({ step: "review_fallback" });
    swapCreate = () => ({ kind: "ready", created: true, ref: { taskId: "T1", role: "reviewer", agent: "agent-task-one", sessionId: "s-one", family: "claude",
      transport: "tmux" } });
    const r = (await tick())!;
    expect(r.step).toBe("held");
    expect(r.detail).toContain("session 与本卡作者或跨模型审查规则不符");
    expect(reviewers()).toEqual([]);
    expect(getSchedulerSession(f.db, "T1", "author")).toMatchObject({ agent: "agent-task-one", state: "active" });
  });

  test("an ordinary cross-family verdict's review event is written exactly as before: no fallback field", async () => {
    await reviewSent();
    expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
    const data = events().findLast((e) => e.kind === "review")!.data;
    expect(Object.keys(data)).not.toContain("fallback");
    expect(data).toMatchObject({ round: 1, reviewer: "agent-rv-t1", reviewerSessionId: "s-rv", reviewerFamily: "codex", verdict: "pass" });
  });

  test("an author ensure_session never reads a fallback epoch", async () => {
    await delivered();
    failCreates(NRT1_CREATE);
    await tick();
    const author = f.intents().find((i) => i.action === "ensure_session" && i.node !== "adversarial_review")!;
    expect(freshFallbackEpoch(f.db, author.id)).toBeNull();
  });

  test("without any epoch: no fresh-epoch bind, the old tags, and a clean create failure still backs off with no fallback", async () => {
    await delivered();
    failCreates(CREATE_ERROR(1));
    expect(await tick()).toMatchObject({ step: "waiting" });
    const ensure = f.intents().findLast((i) => i.action === "ensure_session")!;
    expect(freshFallbackEpoch(f.db, ensure.id)).toBeNull();
    expect(createRetryBackoff(f.db, "T1", "reviewer", f.tickDeps.now())).toContain("连续 1 次失败");
    expect(epochs()).toEqual([]);
    const swap = (data: Record<string, unknown>) => ({ seq: 1, kind: "scheduler", data: { op: "reviewer_swap", ...data } }) as never;
    expect([replacementTag(swap({})), replacementTag(swap({ refusal: {} })), replacementTag(swap({ legacy: true }))]).toEqual(["", "-ex", "-re"]);
  });
});

describe("the pass never writes the fallback itself (scheduler-model-outcome writer, PM evidence 2)", () => {
  test("the tick's handle is query_only; the epoch still lands, written by the ledger CLI as the scheduler", async () => {
    await reviewSent();
    expect(() => f.reader.get()!.run("UPDATE scheduler_sessions SET state = 'retired'")).toThrow(); // what the pass holds refuses any write
    const calls: string[] = [];
    const manager = f.tickDeps.manager;
    f.tickDeps.manager = async (...a) => { calls.push(a[1]!); return manager(...a); };
    failTurns("codex", QUOTA_TURN);
    expect(await tick()).toMatchObject({ step: "review_fallback" });
    expect(calls.filter((c) => c === "scheduler-model-outcome")).toHaveLength(1);
    expect(epochs()).toMatchObject([{ actor: "scheduler", data: { fallback: { trigger: "review_capacity" } } }]);
  });
});
