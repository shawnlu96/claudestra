/**
 * UIRES1 · a UI card the scheduler sent to manual for its screenshots goes back to auto once PM's approval stands, through the
 * formal entries only (planner escalation / `scheduler-fallback-manual`, `ui-approve`, `ui-owner-visual`, `scheduler-recovery`,
 * the leased `scheduler-manual-resume --mechanism`, the manual-resume tick). Episodes: `approved` (review stage, approval after
 * the entry), `ownerFlip` (merge stage, merge_ui_unapproved), `unsent` (merge stage, uiUnsentEnd's cancellation, then
 * merge_retry_requires_pm). Temp ledger, real ledger CLI in-process.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindHash } from "../src/lib/ask-bind.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { extensionMode } from "../src/lib/manual-recovery-policy.js";
import { manualRecoveryMechanism, proveRecovery } from "../src/lib/manual-recovery-release.js";
import { UI_MANUAL_RESUME } from "../src/lib/manual-recovery-ui.js";
import { convergeReview } from "../src/lib/review-converge.js";
import { reviewSourced } from "../src/lib/review-source-proof.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { mergeCandidates, trainCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { latestReviewerSwap } from "../src/lib/scheduler-review-swap.js";
import { manualResumeManagerTick, recoveryArgs, recoveryFence, type RecoveryManager } from "../src/lib/scheduler-recovery-ports.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import { uiMergeRefusal } from "../src/lib/scheduler-ui-gate.js";
import { uiUnsentEnd } from "../src/lib/scheduler-ui-review-carry.js";
import { autoFixture, DIGEST, H2, P1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const PR = "https://github.com/example/repo/pull/9", BRANCH = "task/T1", H3 = "3".repeat(40);
const UI_STALE = "ui_stale：截图许可绑定的 head/specRev 已过期";
const config = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: "/tmp/p" } } });

let saved: Buffer | null = null;
beforeEach(() => {
  expect(RECOVERY_POLICY_PATH.startsWith(join(homedir(), ".claude-orchestrator"))).toBe(false);
  saved = existsSync(RECOVERY_POLICY_PATH) ? readFileSync(RECOVERY_POLICY_PATH) : null;
  rmSync(RECOVERY_POLICY_PATH, { force: true });
});
afterEach(() => {
  if (saved) writeFileSync(RECOVERY_POLICY_PATH, saved);
  else rmSync(RECOVERY_POLICY_PATH, { force: true });
});

const wf = (f: F) => getWorkflow(f.db, "T1")!;
const events = (f: F) => listEvents(f.db, { project: "p", target: "T1" });
const ev = (f: F, op: string) => events(f).filter((e) => e.data.op === op);
const projectSeq = (db: Database) => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
const state = (f: F) => ({
  intents: f.db.query("SELECT id, status FROM scheduler_intents ORDER BY id").all(),
  resources: f.db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  merges: f.db.query("SELECT intentId, phase, mergeSha FROM scheduler_merges ORDER BY intentId").all(),
  deploys: f.db.query("SELECT 1 FROM sqlite_master WHERE name = 'scheduler_deploys'").get() ? f.db.query("SELECT intentId, phase FROM scheduler_deploys").all() : [],
  workflow: f.db.query("SELECT mode, rev, specRev FROM task_workflows WHERE taskId = 'T1'").get(), stage: f.task().stage,
});
const policy = async (f: F, mode: RecoveryMode, key?: string) => expect(await f.cli("pm", "scheduler-recovery", "p", mode,
  ...(key ? ["--key", key] : []), "--reason", `UIRES1 测试：${key ?? "项目"} ${mode}`)).toMatchObject({ ok: true });
const turnOn = async (f: F) => { await policy(f, "on", "manualRecovery"); await policy(f, "on", "uiManualResume"); };
const fallback = (f: F, reason: string) => f.cli("scheduler", "scheduler-fallback-manual", "T1", "--reason", reason);
const approve = (f: F) => f.cli("pm", "ui-approve", "T1", "--head", H2, "--digest", DIGEST);
const ownerVisual = async (f: F, on: boolean) => expect(await f.cli("pm", "ui-owner-visual", "T1", on ? "on" : "off")).toMatchObject({ ok: true });
const recover = (f: F, mode: "on" | "observe") => f.cli("scheduler", "scheduler-manual-resume", "T1",
  ...recoveryArgs(recoveryFence(f.db, f.task())), "--mode", mode, "--mechanism", UI_MANUAL_RESUME, "--max-workers", "2");
const realManager = (f: F): RecoveryManager => (...a: string[]) => f.cli("scheduler", ...a.slice(1)) as Promise<Record<string, unknown>>;
/** The scheduler's manual-resume tick (MAN2, then the evidence mechanisms); `ui` keeps this card's UIRES1 rows. */
const tick = (f: F, manager = realManager(f)) => manualResumeManagerTick(f.db, { p: { maxActiveWorkers: 2 } }, { manager, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
const ui = async (f: F, manager?: RecoveryManager) => (await tick(f, manager)).filter((o) => "mechanism" in o && o.mechanism === UI_MANUAL_RESUME);
const prove = (f: F) => proveRecovery(f.db, f.task(), wf(f), UI_MANUAL_RESUME, null);
const run = async <T extends F>(make: () => Promise<T>, body: (f: T) => Promise<void>) => { const f = await make(); try { await body(f); } finally { f.close(); } };
/** This mechanism's would-resume notes (other observers write their own recovery_observe on the way here). */
const observed = (f: F) => ev(f, "recovery_observe").filter((e) => e.data.mechanism === "uiManualResume");
const begin = async (f: F, id: string) => {
  expect(await f.cli("scheduler", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
  expect(await f.cli("scheduler", "scheduler-merge-begin", id, "--required-checks", "ci")).toMatchObject({ ok: true, run: { phase: "ready" } });
};
/** PM's formal entries: an unfinished card T2 that T1 now waits on. */
const blockedByT2 = async (f: F) => {
  expect(await f.cli("pm", "task-new", "T2", "--project", "p", "--title", "前置", "--kind", "code", "--agent", "agent-task-two")).toMatchObject({ ok: true });
  expect(await f.cli("pm", "dep-add", "T2", "T1", "--when", "T2 合并")).toMatchObject({ ok: true });
};
/** The planner's own review gate on this card, were it auto with no dependency in front and `without` (a bound cancellation) released. */
const plannerPasses = (f: F, without?: string): boolean => {
  const s = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: Date.now() }, without);
  const d = planScheduler({ ...s, workflow: { ...s.workflow!, mode: "auto" }, blockedBy: [], queueFrozen: false });
  return d.kind === "intent" && (f.task().stage === "merge" ? d.action === "merge" : d.action === "stage" && d.targetStage === "merge");
};
const schedulerResumes = (f: F) => ev(f, "workflow_resume").filter((e) => e.actor === "scheduler");

/** A UI card whose review on H2 passed and whose screenshots are in front of PM. */
async function shown(verdict: "pass" | "changes" = "pass", rows: object[] = []): Promise<F> {
  const f = autoFixture({ template: "ui" });
  f.advance(Date.now()); // the gates' own reads use the wall clock
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  await f.review(verdict, H2, rows);
  expect(await f.tick()).toMatchObject({ step: "ask" });
  return f;
}

/** The scheduler hands the card to PM for its screenshot evidence, PM approves afterwards, the card stays manual. */
async function approved(verdict: "pass" | "changes" = "pass", rows: object[] = []): Promise<F> {
  const f = await shown(verdict, rows);
  expect(await fallback(f, UI_STALE)).toMatchObject({ ok: true });
  expect(await approve(f)).toMatchObject({ ok: true });
  expect(wf(f).mode).toBe("manual");
  return f;
}

/** Merge stage: PM's approval stops counting (the card now needs the owner), the real planner escalates merge_ui_unapproved. */
async function ownerFlip(): Promise<F> {
  const f = await shown();
  expect(await approve(f)).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  await ownerVisual(f, true);
  await f.tick();
  expect(ev(f, "fallback_manual").at(-1)).toMatchObject({ actor: "scheduler", data: { from: "auto", reason: expect.stringMatching(/^merge_ui_unapproved：/) } });
  return f;
}

/** Merge stage: the run began, the screenshot gate alone stopped it before any merge went out (uiUnsentEnd), the planner asks PM. */
async function unsent(): Promise<F & { merge: string }> {
  const f = await shown();
  expect(await approve(f)).toMatchObject({ ok: true });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(await f.tick()).toMatchObject({ step: "merge_queue" });
  const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string };
  f.db.query("UPDATE tasks SET pr = ?, branch = ? WHERE id = 'T1'").run(PR, BRANCH);
  await begin(f, id);
  await ownerVisual(f, true);
  const on = () => ({ mode: "on" as const, manualAfterMs: null, source: "config" as const });
  expect(uiUnsentEnd(f.db, f.at("scheduler"), getMergeRun(f.db, id)!, undefined, { ui: uiMergeRefusal, drift: () => null, send: () => null }, on)).toBe(true);
  await f.tick();
  expect(ev(f, "fallback_manual").at(-1)).toMatchObject({ actor: "scheduler", data: { reason: expect.stringContaining(`merge_retry_requires_pm：合并意图 ${id} 已取消`) } });
  return Object.assign(f, { merge: id });
}

describe("[验收线 1] approved but still manual: the old path leaves it, on hands it back once with its proof", () => {
  test("red baseline: with the mechanism off the card stays manual tick after tick (MAN2 does not lift a screenshot reason)", () => run(approved, async (f) => {
    await policy(f, "on", "manualStall");
    await policy(f, "off", "uiManualResume");
    for (let i = 0; i < 3; i++) expect((await tick(f)).some((o) => o.action === "resumed" || o.action === "would_resume")).toBe(false);
    expect(wf(f).mode).toBe("manual");
    expect(ev(f, "workflow_resume")).toHaveLength(0);
  }));

  test("on: one workflow_resume carrying the episode, the approval seq and no cancel; sealed, PM told once", () => run(approved, async (f) => {
    await turnOn(f);
    const entry = ev(f, "fallback_manual").at(-1)!, approval = ev(f, "ui_approved").at(-1)!;
    expect(approval.seq).toBeGreaterThan(entry.seq);
    expect(plannerPasses(f)).toBe(true);
    const before = state(f), notices = f.notices.length;
    expect(await ui(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    const resumes = ev(f, "workflow_resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ actor: "scheduler", data: { auto: true, from: "manual", stage: "review", recoveryProof: { mechanism: UI_MANUAL_RESUME,
      taskId: "T1", episodeId: `e${entry.seq}`, reason: "ui_evidence_stale", subreason: "ui_stale", evidenceSeq: approval.seq, cancelIntentId: null,
      head: H2, specRev: 1, round: f.task().round, external: null, next: "review-to-merge" } } });
    expect(ev(f, "manual_recovery_proof")).toEqual([expect.objectContaining({ seq: resumes[0].seq + 1,
      data: expect.objectContaining({ resumeSeq: resumes[0].seq, episodeId: `e${entry.seq}`, next: { kind: "intent", node: "adversarial_review", action: "stage" } }) })]);
    expect(state(f)).toEqual({ ...before, workflow: { mode: "auto", rev: (before.workflow as { rev: number }).rev + 1, specRev: 1 } });
    expect(f.notices.slice(notices).filter((n) => n.includes("manual 扩展恢复"))).toHaveLength(1);
    expect(await ui(f)).toEqual([]);
    expect(ev(f, "workflow_resume")).toHaveLength(1);
  }));

  test("on: an unsent merge whose only blocker was the screenshot gate is bound as the cancelled intent and retried", () => run(unsent, async (f) => {
    await turnOn(f);
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("现有截图闸不认") }); // still needs the owner
    expect(await ui(f)).toEqual([expect.objectContaining({ action: "none" })]);
    await ownerVisual(f, false);
    expect(plannerPasses(f, f.merge)).toBe(true);
    const entry = ev(f, "fallback_manual").at(-1)!, approval = ev(f, "ui_approved").at(-1)!, before = state(f);
    expect(await ui(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    expect(ev(f, "workflow_resume")).toHaveLength(1);
    expect(ev(f, "workflow_resume")[0].data).toMatchObject({ stage: "merge", recoveryProof: { episodeId: `e${entry.seq}`, reason: "merge_unknown",
      subreason: "merge_retry_requires_pm", evidenceSeq: approval.seq, cancelIntentId: f.merge, next: "merge" } });
    expect(ev(f, "manual_recovery_proof")[0].data).toMatchObject({ next: { kind: "intent", node: "merge_deploy", action: "merge" } });
    // the hand-back itself takes no slot and starts no run; the cancelled run stays as the journal closed it
    expect(state(f)).toEqual({ ...before, workflow: { mode: "auto", rev: (before.workflow as { rev: number }).rev + 1, specRev: 1 } });
    expect(getIntent(f.db, f.merge)).toMatchObject({ status: "cancelled" });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    expect(f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get()).toEqual({ id: expect.stringContaining(":merge_deploy:a1") });
  }));
});

describe("[验收线 2] observe computes the same candidate and changes nothing; off does nothing; on must be explicit", () => {
  test("default (no policy file) and a project-wide on both read observe: one note with the evidence seq, no resume, no message", () => run(approved, async (f) => {
    expect(extensionMode("p", "uiManualResume")).toMatchObject({ mode: "observe" });
    const before = state(f), notices = f.notices.length, approval = ev(f, "ui_approved").at(-1)!;
    expect(await ui(f)).toEqual([expect.objectContaining({ mode: "observe", action: "would_resume" })]);
    expect(state(f)).toEqual(before);
    const note = observed(f);
    expect(note).toHaveLength(1);
    expect(note[0].data).toMatchObject({ mechanism: "uiManualResume", next: { kind: "intent", action: "stage" },
      recoveryProof: { mechanism: UI_MANUAL_RESUME, evidenceSeq: approval.seq, subreason: "ui_stale", cancelIntentId: null } });
    await policy(f, "on");
    expect(extensionMode("p", "uiManualResume")).toMatchObject({ mode: "observe", why: expect.stringContaining("项目总档 on 不开新机制") });
    expect(await ui(f)).toEqual([expect.objectContaining({ mode: "observe", action: "observed_before" })]);
    expect(await recover(f, "on")).toMatchObject({ ok: false, code: "forbidden" });
    await policy(f, "on", "manualRecovery"); // the umbrella alone is not this mechanism's own explicit on
    expect(await ui(f)).toEqual([expect.objectContaining({ mode: "observe" })]);
    expect(observed(f)).toHaveLength(1);
    expect(ev(f, "workflow_resume")).toHaveLength(0);
    expect(f.notices).toHaveLength(notices);
    expect(wf(f).mode).toBe("manual");
  }));

  test("off: not judged, nothing recorded, the writer refuses both modes", () => run(approved, async (f) => {
    await policy(f, "on", "manualRecovery");
    await policy(f, "off", "uiManualResume");
    const seq = projectSeq(f.db), before = state(f);
    expect(await ui(f)).toEqual([]);
    for (const mode of ["observe", "on"] as const) expect(await recover(f, mode)).toMatchObject({ ok: false, code: "forbidden" });
    expect(projectSeq(f.db)).toBe(seq);
    expect(state(f)).toEqual(before);
  }));
});

describe("[验收线 3] no valid approval or no review source → zero recovery", () => {
  const forge = (f: F, data: Record<string, unknown>) => appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision", text: "PM 通过前后截图",
    data: { op: "ui_approved", head: H2, specRev: 1, round: f.task().round, screenshotsDigest: DIGEST, ...data } });
  const extra = (f: F, patch: Record<string, unknown>) => f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ ...f.task().extra, ...patch }));
  /** The owner's own authorization on the card's head: the merge gate then passes without reading PM's approval. */
  const ownerAuthorizes = (f: F) => {
    const binding = { action: "scheduler_ui_screenshot", params: { task: "T1", specRev: 1, head: H2, screenshotsDigest: DIGEST }, approve: ["scheduler_ui_approve"] };
    const ask = openAsk(f.db, { project: "p", taskId: "T1", fromAgent: "scheduler", source: "system", kind: "authorize", title: "看前后截图",
      expiresAt: Date.now() + 3_600_000, bind: { ...binding, paramsHash: bindHash(binding, "scheduler") } });
    answerAsk(f.db, ask.id, { choices: ["[button:scheduler_ui_approve]"], labels: ["批准合并"], principal: "owner", owner: true, via: "web_card", at: Date.now() } as never);
    expect(uiMergeRefusal(f.db, f.task(), Date.now())).toBeNull();
  };
  const cases: [string, (f: F) => unknown, string][] = [
    ["缺图（卡上没有截图摘要）", (f) => extra(f, { screenshotsDigest: undefined }), "UI 截图摘要已变"],
    ["卡上摘要换了（新截图）", (f) => extra(f, { screenshotsDigest: "e".repeat(64) }), "UI 截图摘要已变"],
    ["批准绑的是另一份摘要", (f) => forge(f, { screenshotsDigest: "e".repeat(64) }), "不在当前规格 / 轮次 / 截图摘要上"],
    ["批准绑的是旧 head", (f) => forge(f, { head: H3 }), "不在当前 head 上"],
    ["批准绑的是旧 head，owner 另在当前 head 上授权（闸放行，批准本身仍无效）", (f) => { forge(f, { head: H3 }); ownerAuthorizes(f); }, "不在当前 head 上"],
    ["批准绑的是旧 round", (f) => f.db.query("UPDATE tasks SET round = round + 1 WHERE id = 'T1'").run(), "不在当前规格 / 轮次 / 截图摘要上"],
    ["批准人已不是 PM", (f) => f.db.query("UPDATE meta SET value = '[]' WHERE project = 'p' AND key = 'pms'").run(), "还没有 PM 的截图批准"],
    ["ownerVisual 缺 owner 批准", (f) => ownerVisual(f, true), "现有截图闸不认"],
    ["PM 后来又退回了截图", (f) => f.cli("pm", "ui-reject", "T1", "--text", "再看一眼"), "未通过"],
    ["本轮没有审查结论（批准在新一轮，审查还是上一轮的）", (f) => { f.db.query("UPDATE tasks SET round = round + 1 WHERE id = 'T1'").run(); forge(f, {}); }, "缺本轮同 head 的审查结论"],
  ];
  for (const [what, twist, why] of cases) test(`${what} → refused, card stays manual`, () => run(approved, async (f) => {
    await turnOn(f);
    await twist(f);
    const before = state(f);
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining(why) });
    expect(await ui(f)).toEqual([expect.objectContaining({ action: "none" })]);
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(state(f)).toEqual(before);
    expect(ev(f, "workflow_resume")).toHaveLength(0);
    expect(observed(f)).toHaveLength(0);
  }));

  for (const blocked of [false, true]) test(`a review nobody dispatched is refused by the proof itself (unfinished dependency: ${blocked}); no source adopted`, () => run(approved, async (f) => {
    f.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE taskId = 'T1' AND action = 'review'").run();
    if (blocked) await blockedByT2(f); // the planner's dependency wait returns before its review gate: it must not stand in for the source proof
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("没有现有审查闸认的来源") });
    expect(plannerPasses(f)).toBe(false);
    for (const mode of ["observe", "on"] as const) {
      if (mode === "on") await turnOn(f);
      const before = state(f), seq = projectSeq(f.db);
      expect(await ui(f)).toEqual([expect.objectContaining({ action: "none" })]);
      expect(await recover(f, mode)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("没有现有审查闸认的来源") });
      expect(state(f)).toEqual(before);
      expect(projectSeq(f.db)).toBe(seq);
    }
    expect(observed(f)).toHaveLength(0);
    expect(ev(f, "workflow_resume")).toHaveLength(0);
    expect(ev(f, "review_source_adopted")).toHaveLength(0);
  }));

  /** UIRES2 · the hand-back reads the planner's own source predicate (review-source-proof.ts): one answer for the same snapshot. */
  const sourcedNow = (f: F): boolean => {
    const s = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: Date.now() });
    const after = latestReviewerSwap(s.events)?.seq ?? 0;
    const read = currentReviewFacts(f.task(), s.events.filter((e) => e.kind !== "review" || e.seq > after));
    return read.kind === "facts" && reviewSourced(s, convergeReview(s.events, read.facts, s.fixDiff).facts);
  };
  const reviewOrder = (f: F, set: string) => f.db.query(`UPDATE scheduler_intents SET ${set} WHERE taskId = 'T1' AND action = 'review'`).run();
  test("UIRES2 · the formal source passes the shared predicate, the planner and the proof alike", () => run(approved, async (f) => {
    expect(sourcedNow(f)).toBe(true);
    expect(plannerPasses(f)).toBe(true);
    expect(prove(f)).not.toMatchObject({ kind: "refused" });
  }));
  const twists = [["order to another recipient", "recipient = 'agent-else'"], ["order for another head", `head = '${H3}'`]] as const;
  for (const [what, set] of twists) test(`UIRES2 · ${what}: the shared predicate, the planner and the proof all refuse`, () => run(approved, async (f) => {
    reviewOrder(f, set);
    expect(sourcedNow(f)).toBe(false);
    expect(plannerPasses(f)).toBe(false);
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("没有现有审查闸认的来源") });
  }));

  test("a sourced review behind an unfinished dependency still hands back: the planner then waits on the dependency, legally", () => run(approved, async (f) => {
    await blockedByT2(f);
    await turnOn(f);
    expect(plannerPasses(f)).toBe(true);
    expect(await ui(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    expect(ev(f, "manual_recovery_proof")[0].data).toMatchObject({ next: { kind: "wait", code: "dependency" } });
    expect(ev(f, "workflow_resume")).toHaveLength(1);
  }));

  test("not this mechanism's episode: no approval yet, a rejection code, a real unknown, a PM takeover, a card in fix", async () => {
    await run(shown, async (f) => { // approval missing: ui_missing_screenshots / stale is never a reason to approve
      expect(await fallback(f, UI_STALE)).toMatchObject({ ok: true });
      await turnOn(f);
      expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("还没有 PM 的截图批准") });
      expect(await ui(f)).toEqual([expect.objectContaining({ action: "none" })]);
      expect(ev(f, "ui_approved")).toHaveLength(0);
    });
    for (const [reason, why] of [["ui_rejected：owner 未批准前后截图", "子原因 ui_rejected"], ["ui_unverified：截图许可缺已认证的 owner 答复", "子原因 ui_unverified"],
      ["merge_bounce_limit：反复冲突，需要 PM 排期", "子原因 merge_bounce_limit"], ["merge_retry_requires_pm：合并意图 nope 已取消，先由 PM 核对外部结果", "不是本卡本规格已取消的自动合并意图"]]) {
      await run(shown, async (f) => {
        expect(await approve(f)).toMatchObject({ ok: true });
        expect(await fallback(f, reason)).toMatchObject({ ok: true });
        expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining(why) });
      });
    }
    await run(shown, async (f) => { // PM's own takeover with the same code is not the scheduler's episode
      expect(await approve(f)).toMatchObject({ ok: true });
      expect(await f.cli("pm", "scheduler-fallback-manual", "T1", "--reason", UI_STALE)).toMatchObject({ ok: true });
      expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("不是调度器从 auto 的正式退回") });
    });
    await run(approved, async (f) => { // still to be fixed / re-shot: never skipped over
      f.db.query("UPDATE tasks SET stage = 'fix' WHERE id = 'T1'").run();
      expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("卡在 fix") });
    });
  });

  test("a cancelled merge the journal does not prove unsent-for-screenshots is never bound", () => run(unsent, async (f) => {
    await ownerVisual(f, false);
    expect(prove(f)).toMatchObject({ kind: "candidate", proof: { cancelIntentId: f.merge } });
    f.db.query("UPDATE scheduler_merges SET phase = 'unknown' WHERE intentId = ?").run(f.merge); // a real unknown is RECBASE1's refusal
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("合并未正式结清") });
    f.db.query("UPDATE scheduler_merges SET phase = 'resolved' WHERE intentId = ?").run(f.merge);
    expect(prove(f)).toMatchObject({ kind: "candidate" });
    // the journal says more about this run after the "unsent" terminal (here: it merged after all): no longer a proven unsent cancel
    f.db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'scheduler', 'p', 'T1', 'scheduler', '合并队列', ?)")
      .run(f.at("scheduler").now, JSON.stringify({ op: "merge_phase", intentId: f.merge, from: "resolved", to: "merged", mergeSha: "9".repeat(40) }));
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("交 PM 核对") });
    await turnOn(f);
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(ev(f, "workflow_resume")).toHaveLength(0);
  }));
});

describe("[验收线 4] PM acting between the proof and the write wins; a restart never recovers twice", () => {
  const request = (f: F) => appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision", text: "人工合并",
    data: { op: "manual_merge_request", head: H2, specRev: 1, round: f.task().round, review: { seq: events(f).findLast((e) => e.kind === "review")!.seq } } });
  const hold = (f: F) => f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--template", "ui", "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "pm_hold", "--reason", "PM 先压住");
  const moves: [string, (f: F) => unknown, (f: F) => void][] = [
    ["人工合并请求", request, (f) => expect(ev(f, "manual_merge_request")).toHaveLength(1)],
    ["PM hold", async (f) => expect(await hold(f)).toMatchObject({ ok: true }), (f) => expect(ev(f, "workflow").at(-1)!.actor).toBe("pm")],
    ["规格改了", (f) => f.db.query("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'").run(), (f) => expect(f.task().specRev).toBe(2)],
  ];
  for (const [what, move, kept] of moves) test(`${what} lands first → this mechanism yields, PM's result stands`, () => run(approved, async (f) => {
    await turnOn(f);
    const pmFirst: RecoveryManager = async (...a) => { await move(f); return realManager(f)(...a); };
    expect(await ui(f, pmFirst)).toEqual([expect.objectContaining({ action: "refused" })]);
    const after = state(f);
    kept(f);
    for (let i = 0; i < 2; i++) expect((await ui(f)).every((o) => o.action === "none")).toBe(true);
    expect(state(f)).toEqual(after);
    expect(schedulerResumes(f)).toHaveLength(0);
    expect(wf(f).mode).toBe("manual");
  }));

  test("PM's own workflow-resume lands first: one resume, PM's", () => run(approved, async (f) => {
    await turnOn(f);
    const pmFirst: RecoveryManager = async (...a) => {
      expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--reason", "PM 自己交回")).toMatchObject({ ok: true });
      return realManager(f)(...a);
    };
    expect(await ui(f, pmFirst)).toEqual([expect.objectContaining({ action: "refused" })]);
    expect(await ui(f)).toEqual([]);
    expect(ev(f, "workflow_resume").map((e) => [e.actor, e.data.manual])).toEqual([["pm", true]]);
    expect(ev(f, "manual_recovery_proof")).toHaveLength(0);
  }));

  test("ticks and a restart after the hand-back: still one workflow_resume, the episode is spent", () => run(approved, async (f) => {
    await turnOn(f);
    await ui(f); await ui(f);
    const fresh = new Database(join(f.dir, "ledger.sqlite"), { readonly: true }); // what a restarted scheduler reads
    try { expect(fresh.query("SELECT COUNT(*) AS n FROM events WHERE json_extract(data, '$.op') = 'workflow_resume'").get()).toEqual({ n: 1 }); }
    finally { fresh.close(); }
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    // even with the mode forced back without a new formal entry, the sealed episode never hands back again
    f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'").run();
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(await ui(f)).not.toContainEqual(expect.objectContaining({ action: "resumed" }));
    expect(ev(f, "workflow_resume")).toHaveLength(1);
  }));
});

describe("[验收线 5] after the hand-back the existing exits do the rest, unchanged", () => {
  function github() {
    const calls: string[] = [];
    const snap: PrSnapshot = { state: "OPEN", head: H2, branch: BRANCH, base: "main", draft: false, crossRepository: false,
      mergeState: "CLEAN", mergeSha: null, checks: [{ name: "ci", bucket: "pass" }] };
    const external: MergeExternal = {
      inspect: async () => { calls.push("inspect"); return snap; },
      freshness: async () => ({ behindBy: 0, mainHead: "e".repeat(40) }),
      carryReview: async () => ({ ok: false, reason: "不沿用" }),
      updateBranch: async () => { throw new Error("clean PR must not be updated"); },
      merge: async () => { calls.push("merge"); return "9".repeat(40); },
    };
    return { calls, external };
  }
  const mergeTick = (f: F, external: MergeExternal) => schedulerMergeTick(f.db, config, realManager(f), () => external);

  test("the planner continues legally; the serial exit still re-reads the screenshot gate before any merge", () => run(ownerFlip, async (f) => {
    await turnOn(f);
    expect(await ui(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("现有截图闸不认") })]);
    await ownerVisual(f, false);
    const before = state(f);
    expect(await f.tick()).toBeDefined(); // the auto tick itself runs the recovery, then plans on a later pass
    expect(wf(f).mode).toBe("auto");
    expect(ev(f, "workflow_resume")).toHaveLength(1);
    expect(ev(f, "workflow_resume")[0].data).toMatchObject({ recoveryProof: { subreason: "merge_ui_unapproved", cancelIntentId: null, next: "merge" } });
    expect({ ...state(f), intents: before.intents, resources: before.resources, workflow: before.workflow }).toEqual(before); // no run, no deploy from the recovery
    for (let i = 0; i < 3 && !f.db.query("SELECT 1 FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get(); i++) await f.tick();
    const { id } = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string };
    expect(ev(f, "fallback_manual")).toHaveLength(1); // never back to manual: no auto / manual loop
    // trains never carry a ui card; the fairness view sees it only through the same screenshot gate
    f.db.query("UPDATE tasks SET pr = ?, branch = ? WHERE id = 'T1'").run(PR, BRANCH);
    expect(trainCandidates(f.db, "p")).toEqual([]);
    expect(mergeCandidates(f.db, "p", { now: Date.now() }).map((c) => c.taskId)).toEqual(["T1"]);
    await begin(f, id);
    await ownerVisual(f, true); // the approval stops counting again before the send
    expect(mergeCandidates(f.db, "p", { now: Date.now() })).toEqual([]);
    const gh = github();
    for (let i = 0; i < 3; i++) await mergeTick(f, gh.external);
    expect(gh.calls).not.toContain("merge");
    expect(getMergeRun(f.db, id)!.phase).not.toBe("merged");
    expect(state(f).deploys).toEqual([]);
    expect(ev(f, "workflow_resume")).toHaveLength(1);
  }));

  test("a review the planner converges (a P1 without an acceptance basis reads as P2) hands back; a counted P1 never does", async () => {
    const loose = { findingId: "name-9", family: "naming", severity: "P1" as const, probe: "rename helper" };
    await run(() => approved("changes", [loose]), async (f) => {
      await turnOn(f);
      expect(plannerPasses(f)).toBe(true);
      expect(await ui(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
      expect(ev(f, "manual_recovery_proof")[0].data).toMatchObject({ next: { kind: "intent", node: "adversarial_review", action: "stage" } });
      expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
      expect(ev(f, "review_downgrade").at(-1)!.data).toMatchObject({ findingIds: ["name-9"] });
      expect(ev(f, "fallback_manual")).toHaveLength(1);
    });
    await run(approved, async (f) => { // the same card with a P1 on an acceptance line: the planner's next step is fix, not merge
      expect(await f.review("changes", H2, [P1], [], "pm")).toMatchObject({ ok: true });
      await turnOn(f);
      expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("还没通过") });
      expect(plannerPasses(f)).toBe(false);
      expect(await ui(f)).toEqual([expect.objectContaining({ action: "none" })]);
      expect(await recover(f, "on")).toMatchObject({ ok: false });
      expect(wf(f).mode).toBe("manual");
      expect(ev(f, "workflow_resume")).toHaveLength(0);
    });
  });

  test("a live manual merge request keeps its queue: nothing cancelled, no slot taken, no recovery", () => run(approved, async (f) => {
    await turnOn(f);
    appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision", text: "人工合并",
      data: { op: "manual_merge_request", head: H2, specRev: 1, round: f.task().round, review: { seq: events(f).findLast((e) => e.kind === "review")!.seq } } });
    const before = state(f), seq = projectSeq(f.db);
    expect(await ui(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("人工合并请求") })]);
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(state(f)).toEqual(before);
    expect(projectSeq(f.db)).toBe(seq);
    appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision", text: "撤回", data: { op: "manual_merge_revoke", request: seq } });
    expect(prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining("不抢人工") }); // PM used the manual queue in this episode: theirs to finish
  }));
});

describe("[验收线 6] one key, one production mechanism", () => {
  test("RECOVERY_KEYS carries uiManualResume exactly once and the registry serves it under that key", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "uiManualResume")).toHaveLength(1);
    expect(manualRecoveryMechanism(UI_MANUAL_RESUME)).toMatchObject({ key: "uiManualResume", codes: ["ui_evidence_stale", "merge_unknown"], releasesCancel: true });
    expect(manualRecoveryMechanism(UI_MANUAL_RESUME)!.readEvidence).toBeUndefined();
  });
});
