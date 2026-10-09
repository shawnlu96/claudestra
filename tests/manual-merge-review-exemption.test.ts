/**
 * dispatch-recovery-MANEX1 · 人工合并队列与自动合并门用同一个同族豁免谓词（manual-merge-review-exemption.ts → exemptVerdict）。
 * 真实临时台账 + 生产 tick（假 worker / 假换审 runtime，同 scheduler-model-exec.test.ts）：owner 当前批准 → 首次 cyber 拒审 → 正式本机
 * 拒审 epoch → 按它绑定的会话 → 该会话本人 `ledger review` → 卡转 manual → PM 真实 `ledger manual-merge-request`（只受理，不认领、
 * 不发 GitHub）。同族却有效的结论两门都过；S2G2 形状、换 SID、epoch 换 head / spec / round、撤销 / 挂起、缺材料摘要、作者兼审、
 * 请求人兼审、未知作者家族全部拒且不写请求；受理之后批准撤销，队列复核与发送前的 drift 都拒。纯 main 沿用只认规范 carry 记录。
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { manualRunDrift, manualIntentId, requestAt, requestRefusal, reviewRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { manualFamilyRefusal } from "../src/lib/manual-merge-review-exemption.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { setModelOutcomeReader } from "../src/lib/scheduler-model-wiring.js";
import { currentReviewFacts, type ReviewFacts } from "../src/lib/scheduler-review.js";
import { exemptVerdict } from "../src/lib/scheduler-review-swap.js";
import { reviewSwapStep, type ReviewSwapDeps } from "../src/lib/scheduler-review-swap-runtime.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const CYBER = "This request has been flagged for possible cybersecurity risk";
const EX = "agent-task-rv-t1-r1-ex", PM = "pm", AUTHOR = "agent-task-one";
const H2 = "2".repeat(40), H3 = "3".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "manex1-"));
const g = globalThis as { __modelxMode?: string };
const CFG = join(dir, "recovery-policy.ts");
writeFileSync(CFG, "export function recoveryPolicy() { return { mode: globalThis.__modelxMode, manualAfterMs: null }; }\n");

let f: ReturnType<typeof autoFixture>;
let errors: ReturnType<typeof spyOn>;
let worker: ReturnType<typeof autoFixture>["tickDeps"]["worker"];
beforeEach(async () => {
  errors = spyOn(console, "error").mockImplementation(() => {});
  setModelOutcomeReader(CFG);
  g.__modelxMode = "on";
  f = autoFixture();
  worker = f.tickDeps.worker;
  writeFileSync(join(f.dir, "T1.md"), "# T1\n验收：原文\n");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7', branch = 'feat/t1' WHERE id = 'T1'", [join(f.dir, "T1.md")]);
  await toBuild(f);
  await f.tick();
  expect((await f.cli(AUTHOR, "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
  await f.tick();
  expect(await f.tick()).toMatchObject({ step: "sent" });
});
afterEach(() => { f.close(); errors.mockRestore(); setModelOutcomeReader(); delete g.__modelxMode; rmSync(RECOVERY_POLICY_PATH, { force: true }); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The owner's standing refusal rule (or a later answer that revokes it). */
function answer(button: string, at: number): string {
  const ask = openAsk(f.db, { project: "p", source: "reply", kind: "decide", title: "Refusal rule", askKey: "policy-refusal-rule" }, at - 1);
  answerAsk(f.db, ask.id, { choices: [`[button:${button}]`], labels: ["x"], text: "", principal: OWNER_PRINCIPAL_ID, owner: true, via: "web_card", at, final: true });
  return ask.id;
}
function failWith(message: string | null) {
  f.tickDeps.worker = message === null ? worker : (ref) => {
    const w = worker(ref);
    return "manual" in w ? w : { ...w, observe: async () => ({ state: "result", outcome: "failed", failure: { kind: "error", message } }) };
  };
}
const swapDeps = (): ReviewSwapDeps => ({
  registryPath: f.registryPath, active: () => {}, agents: async () => [], agent: async () => ({ ok: true }),
  ensure: async (task, family) => {
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    r.agents[EX] = { runtime: "claude-code", sessionId: "s-ex", cwd: join(f.dir, "rv-ex") };
    writeFileSync(f.registryPath, JSON.stringify(r));
    return { kind: "ready", created: true, ref: { taskId: task.id, role: "reviewer", agent: EX, sessionId: "s-ex", family, transport: "tmux" } };
  },
});
async function tick() {
  const manager = (...a: string[]) => a[1] === "scheduler-review-swap"
    ? reviewSwapStep(f.db, f.at("scheduler"), a[2], Number(a[4]), swapDeps()).catch((e: Error) => ({ ok: false, error: e.message })) : f.tickDeps.manager(...a);
  const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, { ...f.tickDeps, manager });
  if (r.failed.length) throw new Error(JSON.stringify(r.failed));
  return r.cards[0];
}
const events = () => listEvents(f.db, { project: "p", target: "T1" });
const epoch = () => events().find((e) => e.data.op === "reviewer_swap" && e.data.refusal)!;
const findings = () => { const p = join(f.dir, `f-${Math.random()}.json`); writeFileSync(p, "[]"); return p; };
/** `ledger review` as `actor` for `reviewer` (the official path; on a manual card PM records it for the actual reviewer). */
const review = (actor: string, reviewer: string, session: string, family: string, head: string, extra: string[] = [], over = {}) =>
  f.cliWith({ callerSession: session, ...over }, actor, "review", "T1", "--reviewer", reviewer, "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0",
    "--head", head, "--session", session, "--family", family, "--findings", findings(), "--path", `reviews/${session}.md`, ...extra);

/** Real exemption, bound and passed by its own session, card in merge; then PM takes it over by hand (workflow manual, real CLI). */
async function exemptManual() {
  answer("policy_refusal_rule_go", 2000);
  failWith(CYBER);
  expect(await tick()).toMatchObject({ step: "refusal_epoch" });
  failWith(null);
  expect(await tick()).toMatchObject({ step: "session" });
  expect(await tick()).toMatchObject({ step: "sent" });
  expect(await review(EX, EX, "s-ex", "claude", H1)).toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toThrow(); // the auto gate, before the takeover
  await toManual();
}
async function toManual() {
  expect(await f.cli("owner", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(getWorkflow(f.db, "T1")!.rev), "--template", "code", "--version", "2", "--mode", "manual",
    "--author-family", "claude", "--fallback", "人工合并", "--reason", "PM 接管，人工合并")).toMatchObject({ ok: true });
}
const facts = (): ReviewFacts => {
  const r = currentReviewFacts(f.task(), events(), () => true);
  if (r.kind !== "facts") throw new Error(`no facts: ${JSON.stringify(r)}`);
  return r.facts;
};
const requests = () => events().filter((e) => e.data.op === "manual_merge_request");
const request = async () => {
  const t = f.task();
  return f.cli(PM, "manual-merge-request", "T1", "--head", t.headSHA!, "--spec-rev", String(t.specRev), "--round", String(t.round),
    "--review-seq", String(events().findLast((e) => e.kind === "review")!.seq), "--reason", "人工审过，排队合并") as Promise<Record<string, unknown>>;
};
/** Both gates' reading of the current review: the shared predicate (auto) and the manual queue's review refusal. */
const gates = () => {
  const fa = facts(), ev = events().find((e) => e.seq === fa.eventSeq)!;
  return { auto: exemptVerdict(f.db, f.task(), fa), manual: reviewRefusal(f.db, f.task(), events(), { requestedBy: PM,
    review: { seq: fa.eventSeq, actor: ev.actor, reviewer: fa.reviewer, sessionId: fa.reviewerSessionId, family: fa.reviewerFamily, reportPath: fa.reportPath, verdict: fa.verdict } }) };
};
/** Refused at the request: conflict naming the real reason, no request event written. */
async function refused(why: RegExp) {
  const before = requests().length;
  const r = await request();
  expect(r).toMatchObject({ ok: false, code: "conflict" });
  expect(String(r.error)).toMatch(why);
  expect(requests().length).toBe(before);
}
/** Fault injection on this private fixture only: the ledger's append-only trigger is lifted to rewrite one field. */
function corrupt(seq: number, path: string, value: unknown) {
  f.db.run("DROP TRIGGER IF EXISTS events_no_update");
  f.db.run(`UPDATE events SET data = ${value === undefined ? "json_remove(data, ?)" : "json_set(data, ?, json(?))"} WHERE seq = ?`,
    value === undefined ? [path, seq] : [path, JSON.stringify(value), seq]);
}

describe("positive: a same-family verdict under the round's formal exemption passes both gates", () => {
  test("auto and manual predicates agree; the manual request is only queued (nothing claimed, nothing sent)", async () => {
    await exemptManual();
    expect(facts()).toMatchObject({ reviewer: EX, reviewerSessionId: "s-ex", reviewerFamily: "claude", head: H1 });
    expect(gates()).toEqual({ auto: true, manual: null });
    const r = await request();
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(requests()).toHaveLength(1);
    expect(requests()[0].data.review).toMatchObject({ reviewer: EX, sessionId: "s-ex", family: "claude" }); // the family as written, never "cross-model"
    expect(events().some((e) => e.data.op === "manual_merge_claim" || e.data.op === "merge_phase")).toBe(false);
  });

  test("control: an ordinary cross-family verdict still passes; a same-family one without any epoch is still refused", async () => {
    expect(await f.review("pass", H1, [])).toMatchObject({ ok: true });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    await toManual();
    expect(gates().manual).toBeNull();
    expect(await request()).toMatchObject({ ok: true });
    expect(await f.cli(PM, "manual-merge-revoke", "T1", "--request", String(requests()[0].seq), "--reason", "换审查")).toMatchObject({ ok: true });
    f.db.run("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'T1'");
    expect(await review(PM, "agent-other", "s-other", "claude", H1, ["--to", "merge"])).toMatchObject({ ok: true });
    expect(gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型.*豁免/) });
    await refused(/不是跨模型/);
  });
});

describe("negatives: only the exact formal exemption excuses the family; everything else stays refused, nothing written", () => {
  test("S2G2 shape: epoch of the old head / r1, a new r2 fix reviewed by a different same-family (pm-reviewer) session", async () => {
    await exemptManual();
    // the fix lands as a new head in round 2 (its delivery is not this card's business here: head / round / stage move as recorded)
    f.db.run("UPDATE tasks SET headSHA = ?, round = 2, stage = 'review', rev = rev + 1 WHERE id = 'T1'", [H2]);
    expect(await review(PM, "pm-reviewer", "s-pmr", "claude", H2, ["--to", "merge"])).toMatchObject({ ok: true });
    expect(facts()).toMatchObject({ round: 2, head: H2, reviewerSessionId: "s-pmr" });
    expect(gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
    await refused(/不是跨模型/);
  });

  test("same head, any new same-family session (not the one the epoch bound): refused", async () => {
    await exemptManual();
    f.db.run("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'T1'");
    expect(await review(PM, "agent-other-ex", "s-new", "claude", H1, ["--to", "merge"])).toMatchObject({ ok: true });
    expect(gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
    await refused(/不是跨模型/);
  });

  for (const [name, path, value] of [
    ["the epoch's head is another one (same SID across heads)", "$.head", H3],
    ["the epoch's spec revision is another one", "$.specRev", 99],
    ["the epoch's round is another one", "$.round", 99],
    ["the epoch has no exemption mark", "$.refusal.exemption", undefined],
  ] as const) {
    test(`${name}: both gates refuse`, async () => {
      await exemptManual();
      corrupt(epoch().seq, path, value);
      expect(gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
      await refused(/不是跨模型/);
    });
  }

  test("the bind is not marked with the epoch (a session never bound under it): refused", async () => {
    await exemptManual();
    corrupt(events().findLast((e) => e.data.op === "session_bind" && e.data.agent === EX)!.seq, "$.refusalEpoch", -1);
    expect(gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
    await refused(/不是跨模型/);
  });

  test("approval revoked or held by the owner; epoch missing its material snapshot: refused", async () => {
    await exemptManual();
    f.db.run("UPDATE tasks SET extra = json_set(extra, '$.refusalHold', json('true')) WHERE id = 'T1'");
    expect(gates().manual).toMatch(/挂起/);
    await refused(/挂起/);
    f.db.run("UPDATE tasks SET extra = json_remove(extra, '$.refusalHold') WHERE id = 'T1'");
    expect(gates()).toEqual({ auto: true, manual: null });
    corrupt(epoch().seq, "$.refusal.materialDigest", undefined);
    expect(gates().manual).toMatch(/材料摘要/);
    await refused(/材料摘要/);
    corrupt(epoch().seq, "$.refusal.materialDigest", "d".repeat(64));
    expect(gates().manual).toBeNull();
    answer("policy_refusal_rule_stop", 3000);
    expect(gates()).toEqual({ auto: false, manual: expect.stringMatching(/不是跨模型/) });
    await refused(/不是跨模型/);
  });

  test("author as reviewer, requester as reviewer, unknown author family: refused before (and regardless of) the exemption", async () => {
    await exemptManual();
    const fa = facts();
    expect(manualFamilyRefusal(f.db, f.task(), fa, null)).toMatch(/作者家族 未知 不是跨模型/);
    expect(manualFamilyRefusal(f.db, f.task(), fa, "claude")).toBeNull();
    f.db.run("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'T1'");
    expect(await review(PM, AUTHOR, "s-one", "claude", H1, ["--to", "merge"])).toMatchObject({ ok: true });
    await refused(/作者不能审查/);
    f.db.run("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'T1'");
    expect(await review(PM, PM, "s-pm", "claude", H1, ["--to", "merge"])).toMatchObject({ ok: true });
    await refused(/请求人不能是/);
  });
});

describe("after acceptance, before the merge goes out: the same gate is read again", () => {
  test("approval revoked after the request: the queue's recheck and the run's drift both refuse it", async () => {
    await exemptManual();
    const r = await request();
    expect(r).toMatchObject({ ok: true });
    const req = requestAt(f.db, Number(r.request))!;
    expect(requestRefusal(f.db, req, Date.now(), true)?.kind ?? null).not.toBe("void");
    answer("policy_refusal_rule_stop", 3000);
    expect(requestRefusal(f.db, req, Date.now(), true)).toMatchObject({ kind: "void", why: expect.stringMatching(/不是跨模型/) });
    expect(manualRunDrift(f.db, { id: manualIntentId(req.seq) }, Date.now(), "merging", true)).toMatch(/人工合并请求已失效.*不是跨模型/);
  });

  test("a later same-family report replacing the bound one voids the request (no reuse of the earlier acceptance)", async () => {
    await exemptManual();
    const r = await request();
    const req = requestAt(f.db, Number(r.request))!;
    f.db.run("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = 'T1'");
    expect(await review(PM, "agent-other-ex", "s-new", "claude", H1, ["--to", "merge"])).toMatchObject({ ok: true });
    expect(requestRefusal(f.db, req, Date.now(), true)).toMatchObject({ kind: "void" });
  });
});

describe("pure-main carry: only a canonical carry record keeps the original epoch window", () => {
  /** The pair scheduler-merge.ts carryReview writes (scheduler identity, its merge_phase right after): the shape currentReviewFacts honours. */
  function carry(from: string, to: string, paired = true, actor = "scheduler") {
    const t = f.task();
    const c = insertEvent(f.db, { actor, now: Date.now() }, { project: "p", target: "T1", kind: "scheduler", text: "沿用审查",
      data: { op: "review_carry", intentId: "mmq:1", from, to, round: t.round, specRev: t.specRev } }, false);
    if (paired) insertEvent(f.db, { actor, now: Date.now() }, { project: "p", target: "T1", kind: "scheduler", text: "",
      data: { op: "merge_phase", intentId: "mmq:1", carrySeq: c.seq, to: "await_ci" } }, false);
    f.db.run("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'", [to]);
  }

  test("canonical carry: the verdict still reads at its own head, the exemption re-proved in the original window", async () => {
    await exemptManual();
    carry(H1, H2);
    expect(facts()).toMatchObject({ head: H1, reviewerSessionId: "s-ex" });
    expect(gates().manual).toBeNull();
    expect(manualFamilyRefusal(f.db, f.task(), facts(), "claude")).toBeNull();
  });

  test("a fake carry (no paired merge_phase / not the scheduler) or a real head change without carry: refused", async () => {
    await exemptManual();
    carry(H1, H2, false);
    expect(reviewRefusal(f.db, f.task(), events(), { requestedBy: PM, review: {} as never })).toMatch(/head 与任务不一致/);
    await refused(/本轮没有合格/);
  });

  test("a carry written by someone else than the scheduler is not a carry", async () => {
    await exemptManual();
    carry(H1, H2, true, PM);
    expect(reviewRefusal(f.db, f.task(), events(), { requestedBy: PM, review: {} as never })).toMatch(/head 与任务不一致/);
    await refused(/本轮没有合格/);
  });

  test("the verdict's own head moved into a new round without carry: the old epoch window no longer exists", async () => {
    await exemptManual();
    f.db.run("UPDATE tasks SET round = 2, rev = rev + 1 WHERE id = 'T1'");
    expect(reviewRefusal(f.db, f.task(), events(), { requestedBy: PM, review: {} as never })).toMatch(/未审/);
  });
});
