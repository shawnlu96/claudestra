/**
 * dispatch-recovery-MAN2 on a real temp ledger through the formal entries: MAN1's `ledger workflow-set --reason-code`, CFG's
 * `ledger scheduler-recovery`, the scheduler identity's `ledger workflow-resume` and the real auto tick. Each refusal leaves the card
 * manual with zero writes on intents, workflow, orders and resume events; on resumes exactly once, observe only notes, off is silent.
 * The policy file lives in the test run's temp state dir (tests/preload.ts); its bytes (or absence) are restored after each test.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addDep, removeDep } from "../src/lib/ledger-deps-write.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, moveStage, recordVerify, setFrozen } from "../src/lib/ledger-write.js";
import { manualResumeReason, manualResumeTick, manualResumeVerdict } from "../src/lib/manual-resume.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getTask, type LedgerError } from "../src/lib/ledger-store.js";
import { resumeAutoWorkflow } from "../src/lib/ledger-scheduler-resume.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const TO_LIVE = [["spec", "restate"], ["restate", "build"], ["build", "review"], ["review", "merge"], ["merge", "live"]] as const;

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

const projectSeq = (db: Database) => (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = 'p'").get() as { seq: number }).seq;
const wf = (f: F) => getWorkflow(f.db, "T1")!;
const resumes = (db: Database) => listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === "workflow_resume");
const observed = (db: Database) => listEvents(db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe");
/** Everything a resume or a dispatch would change. */
const state = (f: F) => ({
  intents: f.db.query("SELECT id, status FROM scheduler_intents ORDER BY id").all(),
  resources: f.db.query("SELECT resource, intentId FROM scheduler_resources ORDER BY resource").all(),
  workflow: f.db.query("SELECT mode, rev, specRev FROM task_workflows WHERE taskId = 'T1'").get(),
  sent: f.sent.length, ensured: f.ensured.length, resumes: resumes(f.db).length,
});

const policy = async (f: F, mode: "on" | "observe" | "off") =>
  expect(await f.cli("pm", "scheduler-recovery", "p", mode, "--key", "manualStall", "--reason", `MAN2 测试：manualStall ${mode}`)).toMatchObject({ ok: true });
const wfSet = (f: F, extra: string[]) => f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev),
  "--template", wf(f).template, "--version", "2", "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", ...extra);
const toStage = (f: F, id: string, steps: readonly (readonly [string, string])[]) => {
  for (const [from, to] of steps) moveStage(f.db, f.at("owner"), { taskId: id, from: from as never, to: to as never });
};
/** live → verified only through the formal completion check (recordVerify), never a bare stage move. */
const verified = (f: F, id = "T0") => recordVerify(f.db, f.at("owner"), { taskId: id, result: "pass", data: { checks: [{ id: "pr-merged", status: "pass" }] } });
const verify = (f: F, id = "T0") => { toStage(f, id, TO_LIVE); verified(f, id); };
/** T0 blocks T1; T1 goes manual with a coded deps reason (MAN1's formal entry). */
async function depsManual(f: F, code = "deps_not_live", text = "等 T0 上线"): Promise<void> {
  createTask(f.db, f.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
  addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 上线后" });
  expect(await wfSet(f, ["--reason-code", code, "--reason", text])).toMatchObject({ ok: true });
}
const tick = (f: F) => manualResumeTick(f.db, { p: { maxActiveWorkers: 2 } }, { resume: resumeAutoWorkflow, notifyPm: f.tickDeps.notifyPm, now: f.tickDeps.now });
/** The scheduler identity inside the existing workflow-resume transaction (what the tick runs), as a CLI-shaped result. */
const schedulerResume = async (f: F, reason: string) => {
  try {
    return { ok: true, ...resumeAutoWorkflow(f.db, f.at("scheduler"), { taskId: "T1", taskRev: f.task().rev, workflowRev: wf(f).rev, reason, maxWorkers: 2 }) };
  } catch (e) { return { ok: false, code: (e as LedgerError).code, error: (e as Error).message }; }
};
const run = async (f: F, body: (f: F) => Promise<void>) => { try { await body(f); } finally { f.close(); } };

describe("on: the release node must really be main/verified, then exactly one workflow-resume", () => {
  test("planned / CI green / merge / live never lift; verified resumes once through workflow-resume and the same pass plans it", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    const before = state(f);
    for (const step of [[], TO_LIVE.slice(0, 3), TO_LIVE.slice(3, 4), TO_LIVE.slice(4)] as const) {
      toStage(f, "T0", step);
      await f.tick();
      expect(state(f)).toEqual(before);
      expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("还没真实 main/verified") });
    }
    verified(f);
    await f.tick();
    const ev = resumes(f.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor: "scheduler", data: { op: "workflow_resume", from: "manual", auto: true,
      manualResume: { code: "deps_not_live", deps: [{ id: "T0", stage: "verified" }] } } });
    expect(ev[0].data.manual).toBeUndefined();
    expect(wf(f)).toMatchObject({ mode: "auto" });
    expect(f.intents().length).toBeGreaterThan(0); // the same pass planned the card's next step through the normal tick
    expect(f.notices.filter((n) => n.includes("manual 自动恢复"))).toHaveLength(1);
    const after = state(f);
    for (let i = 0; i < 3; i++) await tick(f); // repeated MAN2 passes never resume or plan again
    expect(state(f)).toEqual(after);
    closeLedger(join(f.dir, "ledger.sqlite")); // restart: nothing in memory decides, the card is auto now
    const db2 = openLedger(join(f.dir, "ledger.sqlite"));
    expect(resumes(db2)).toHaveLength(1);
    expect((await manualResumeTick(db2, { p: { maxActiveWorkers: 2 } }, { resume: resumeAutoWorkflow, notifyPm: async () => {}, now: () => 1 }))
      .filter((o) => o.action === "resumed")).toEqual([]);
  }));

  test("a failed completion check, cancelled predecessor, PM-pinned edge, branch edge and no edge at all do not lift", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    const why = () => (manualResumeVerdict(f.db, f.task(), wf(f)) as { why: string }).why;
    toStage(f, "T0", TO_LIVE);
    recordVerify(f.db, f.at("owner"), { taskId: "T0", result: "fail", data: { checks: [{ id: "pr-merged", status: "fail" }] } });
    expect(why()).toContain("在 live，还没真实 main/verified");
    expect(await f.cli("pm", "dep-set", "T0", "T1", "--rev", "1", "--state", "done")).toMatchObject({ ok: true }); // PM pins the edge: still live
    expect(why()).toContain("T0 在 live");
    verified(f);
    expect(manualResumeVerdict(f.db, f.task(), wf(f)).ok).toBe(true);
    expect(await f.cli("pm", "dep-set", "T0", "T1", "--rev", "2", "--state", "waiting")).toMatchObject({ ok: true });
    expect(why()).toContain("PM 把 T0 的依赖定为 waiting");
    expect(await f.cli("pm", "dep-set", "T0", "T1", "--rev", "3", "--state", "auto")).toMatchObject({ ok: true });
    createTask(f.db, f.at("owner"), { project: "p", id: "TC", title: "取消的前置", kind: "code" });
    addDep(f.db, f.at("owner"), { from: "TC", to: "T1", kind: "blocks", when: "TC 上线后" });
    moveStage(f.db, f.at("owner"), { taskId: "TC", from: "spec", to: "cancelled" });
    expect(why()).toContain("TC 在 cancelled");
    const before = state(f);
    expect((await tick(f)).filter((o) => o.action === "resumed")).toEqual([]);
    expect(state(f)).toEqual(before);
    const g = autoFixture();
    try {
      createTask(g.db, g.at("owner"), { project: "p", id: "T0", title: "前置", kind: "code" });
      addDep(g.db, g.at("owner"), { from: "T0", to: "T1", kind: "branch", when: "T0 通过走这条" });
      expect(await wfSet(g, ["--reason-code", "deps_not_live", "--reason", "等 T0"])).toMatchObject({ ok: true });
      verify(g);
      expect(manualResumeVerdict(g.db, g.task(), wf(g))).toMatchObject({ ok: false, why: expect.stringContaining("分叉边") });
    } finally { g.close(); }
    const h = autoFixture();
    try {
      expect(await wfSet(h, ["--reason-code", "deps_not_live", "--reason", "等外部"])).toMatchObject({ ok: true });
      expect(manualResumeVerdict(h.db, h.task(), wf(h))).toMatchObject({ ok: false, why: expect.stringContaining("没有前置边") });
    } finally { h.close(); }
  }));
});

describe("on: the release is bound to the manual entry's own nodes and condition", () => {
  /** T0 and T2 both block T1; T1 goes manual with a deps reason carrying the given `解除：…`. */
  async function twoDeps(f: F, release: string): Promise<void> {
    for (const id of ["T0", "T2"]) {
      createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code" });
      addDep(f.db, f.at("owner"), { from: id, to: "T1", kind: "blocks", when: `${id} verified` });
    }
    expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", `等前置上线；解除：${release}`])).toMatchObject({ ok: true });
    await policy(f, "on");
  }
  const refusesWithNothingWritten = async (f: F, why: string) => {
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining(why) });
    const before = state(f);
    expect((await tick(f)).filter((o) => o.action === "resumed")).toEqual([]);
    await f.tick();
    expect(state(f)).toEqual(before);
    expect(wf(f)).toMatchObject({ mode: "manual" });
  };

  test("a custom release with a condition beyond verified nodes (owner go-ahead) is never lifted", () => run(autoFixture(), async (f) => {
    await twoDeps(f, "T0 和 T2 verified 后还须 owner 明确放行");
    verify(f, "T0"); verify(f, "T2");
    await refusesWithNothingWritten(f, "无法结构化核验");
  }));

  test("removing the unreleased predecessor the reason is bound to never shifts the reason onto the remaining edge", () => run(autoFixture(), async (f) => {
    await twoDeps(f, "T0 verified");
    verify(f, "T2");
    expect(manualResumeVerdict(f.db, f.task(), wf(f)).ok).toBe(false);
    removeDep(f.db, f.at("owner"), { from: "T0", to: "T1", rev: 1 });
    await refusesWithNothingWritten(f, "T0 已被删边");
    addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 verified" }); // re-added: the removal still revoked the entry
    await refusesWithNothingWritten(f, "需 PM 重新授权");
  }));

  test("a default release whose entry edge was removed after its node verified still needs a new authorization", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    removeDep(f.db, f.at("owner"), { from: "T0", to: "T1", rev: 1 });
    await refusesWithNothingWritten(f, "需 PM 重新授权");
  }));

  test("a custom release naming a node that was not an entry edge is refused", () => run(autoFixture(), async (f) => {
    await twoDeps(f, "T9 verified");
    verify(f, "T0"); verify(f, "T2");
    await refusesWithNothingWritten(f, "进 manual 时不是本卡前置");
  }));

  test("an edge added after the entry must be verified too; a checkable custom release resumes once when all of it holds", () => run(autoFixture(), async (f) => {
    await twoDeps(f, "T0、T2 verified");
    verify(f, "T0"); verify(f, "T2");
    createTask(f.db, f.at("owner"), { project: "p", id: "T3", title: "T3", kind: "code" });
    addDep(f.db, f.at("owner"), { from: "T3", to: "T1", kind: "blocks", when: "T3 verified" });
    await refusesWithNothingWritten(f, "前置 T3 在 spec");
    verify(f, "T3");
    await tick(f);
    expect(resumes(f.db)).toHaveLength(1);
    expect(resumes(f.db)[0].data.manualResume).toMatchObject({ deps: [{ id: "T0" }, { id: "T2" }, { id: "T3" }] });
    expect(wf(f)).toMatchObject({ mode: "auto" });
  }));
});

describe("r2 repro: release binding survives truncation, edge revocation and ids containing `and`", () => {
  /** `id` blocks T1; T1 goes manual with a deps reason carrying `解除：<release>`; `id` then really verified. */
  async function oneDep(f: F, id: string, release: string): Promise<void> {
    createTask(f.db, f.at("owner"), { project: "p", id, title: id, kind: "code" });
    addDep(f.db, f.at("owner"), { from: id, to: "T1", kind: "blocks", when: "前置 verified" });
    expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", `等前置；解除：${release}`])).toMatchObject({ ok: true });
    await policy(f, "on");
    verify(f, id);
  }
  const refuses = async (f: F, why: string) => {
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining(why) });
    const before = state(f);
    expect((await tick(f)).filter((o) => o.action === "resumed")).toEqual([]);
    await f.tick();
    expect(state(f)).toEqual(before);
    expect(wf(f)).toMatchObject({ mode: "manual" });
  };

  test("a release cut at the stored 200-char limit (owner go-ahead dropped) is never lifted", () => run(autoFixture(), async (f) => {
    const id = `T${"x".repeat(190)}`;
    await oneDep(f, id, `${id} verified 后还须 owner 明确放行`);
    const rec = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.data.manualReason)!.data.manualReason as { release: string };
    expect([rec.release.length, rec.release.includes("owner")]).toEqual([200, false]);
    await refuses(f, "可能被截断");
  }));

  test("an entry edge removed after entry stays revoked even when the same edge is re-added", () => run(autoFixture(), async (f) => {
    await oneDep(f, "T0", "T0 verified");
    removeDep(f.db, f.at("owner"), { from: "T0", to: "T1", rev: 1 });
    await refuses(f, "需 PM 重新授权");
    addDep(f.db, f.at("owner"), { from: "T0", to: "T1", kind: "blocks", when: "T0 verified" });
    await refuses(f, "需 PM 重新授权");
    expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "PM 重新授权；解除：T0 verified"])).toMatchObject({ ok: true }); // new entry
    await tick(f);
    expect(resumes(f.db)).toHaveLength(1);
  }));

  for (const id of ["standard", "candy", "AND-1"]) {
    test(`a task id containing "and" (${id}) is one release node`, () => run(autoFixture(), async (f) => {
      await oneDep(f, id, `${id} verified`);
      expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: true });
      await tick(f);
      expect(resumes(f.db)).toHaveLength(1);
    }));
  }

  test("`and` between ids is still a separator", () => run(autoFixture(), async (f) => {
    createTask(f.db, f.at("owner"), { project: "p", id: "T2", title: "T2", kind: "code" });
    addDep(f.db, f.at("owner"), { from: "T2", to: "T1", kind: "blocks", when: "T2 verified" });
    await oneDep(f, "T0", "T0 and T2 verified");
    await refuses(f, "T2 在 spec");
    verify(f, "T2");
    await tick(f);
    expect(resumes(f.db)).toHaveLength(1);
  }));
});

describe("on: every other reason and every hold stays with people", () => {
  for (const [code, text] of [["safety_refusal", "模型安全拒绝"], ["owner_hold", "owner 要亲自盯"], ["pm_hold", "PM 暂停"], ["questionnaire", "问卷没答"],
    ["materials_gate", "材料闸拒收"], ["review_source_missing", "派审回执缺"], ["runtime_unavailable", "会话挂了"], ["merge_unknown", "合并结果不明"]] as const) {
    test(`${code} is never lifted even when the deps are verified`, () => run(autoFixture(), async (f) => {
      await depsManual(f, code, text);
      await policy(f, "on");
      verify(f);
      const before = state(f);
      await f.tick();
      expect(state(f)).toEqual(before);
      expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("不由自动恢复解除") });
    }));
  }

  test("a later hold replaces the reason (owner hold on top of deps) and voids the release", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    expect(await wfSet(f, ["--reason", "owner 要亲自盯"])).toMatchObject({ ok: true });
    const before = state(f);
    await f.tick();
    expect(state(f)).toEqual(before);
  }));

  test("an open safety hold, an open ask, a frozen queue and a paused switch each refuse", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    const ok = () => manualResumeVerdict(f.db, f.task(), wf(f)).ok;
    expect(ok()).toBe(true);
    const hold = insertEvent(f.db, f.at("scheduler"), { project: "p", target: "T1", kind: "scheduler", text: "模型拒绝", data: { op: "model_safety_hold" } }, false);
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("安全拒绝留证") });
    insertEvent(f.db, f.at("owner"), { project: "p", target: "T1", kind: "scheduler", text: "owner 处置", data: { op: "model_safety_resolved", holdSeq: hold.seq } }, false);
    expect(ok()).toBe(true);
    setFrozen(f.db, f.at("owner"), { project: "p", frozen: true, reason: "合并未知" });
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: "项目合并队列冻结" });
    setFrozen(f.db, f.at("owner"), { project: "p", frozen: false });
    expect(ok()).toBe(true);
    f.db.query(`INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, title, expiresAt, state, createdAt, updatedAt)
      VALUES ('ask-q', 'p', 'T1', 'pm', 'c', 'reply', 'decide', '问卷', 9e15, 'open', 1, 1)`).run();
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("不代答") });
    const before = state(f);
    await f.tick();
    expect(state(f)).toEqual(before);
  }));

  test("an unknown merge or an open intent is settled formally first; nothing is resent", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    f.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('m1', 'T1', 'p', 'merge_deploy', 'merge', 1, 1, 1, 1, NULL, 2, 'cancelled', 'merge', 1, 1)`).run();
    f.db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
      VALUES ('m1', 'T1', 'p', '1', 'b', 'h', '[]', 'unknown', 1, 1)`).run();
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("合并未正式结清") });
    f.db.query("UPDATE scheduler_merges SET phase = 'resolved' WHERE intentId = 'm1'").run();
    f.db.query("UPDATE scheduler_intents SET status = 'unknown' WHERE id = 'm1'").run();
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("m1:unknown") });
    const before = state(f);
    await f.tick();
    expect(state(f)).toEqual(before);
  }));

  test("head / specRev / UI drift since the manual entry voids the release", () => run(autoFixture({ template: "ui" }), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    expect(manualResumeVerdict(f.db, f.task(), wf(f)).ok).toBe(true);
    const extra = JSON.stringify({ ...f.task().extra, screenshotsDigest: "e".repeat(64) });
    f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(extra);
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: "UI 截图摘要已变" });
    f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run("9".repeat(40));
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: "head 已变" });
    f.db.query("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'").run();
    expect(manualResumeVerdict(f.db, f.task(), wf(f))).toMatchObject({ ok: false, why: expect.stringContaining("规格已变") });
    const before = state(f);
    await f.tick();
    expect(state(f)).toEqual(before);
  }));
});

describe("the ledger gate: the scheduler identity re-checks everything in workflow-resume's transaction", () => {
  test("no authorization / observe / off / stale authorization (round, reason replaced, new event) are refused with nothing written", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    verify(f);
    const v = manualResumeVerdict(f.db, f.task(), wf(f));
    if (!v.ok) throw new Error(v.why);
    const reason = manualResumeReason(v.facts);
    const before = state(f), seq = projectSeq(f.db);
    expect(await schedulerResume(f, "随便交回")).toMatchObject({ ok: false, code: "forbidden" }); // default observe
    expect(await schedulerResume(f, reason)).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("observe") });
    await policy(f, "off");
    expect(await schedulerResume(f, reason)).toMatchObject({ ok: false, code: "forbidden" });
    await policy(f, "on");
    expect(await schedulerResume(f, "随便交回")).toMatchObject({ ok: false, code: "forbidden", error: expect.stringContaining("授权") });
    f.db.query("UPDATE tasks SET round = round + 1 WHERE id = 'T1'").run(); // rev unchanged: only the authorization catches it
    expect(await schedulerResume(f, reason)).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("授权已失效") });
    f.db.query("UPDATE tasks SET round = round - 1 WHERE id = 'T1'").run();
    insertEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "note", text: "PM 留言", data: {} }, false);
    expect(await schedulerResume(f, reason)).toMatchObject({ ok: false, code: "conflict" });
    expect(state(f)).toEqual(before);
    expect(listEvents(f.db, { project: "p" }).filter((e) => e.seq > seq).map((e) => e.data.op)).toEqual(["scheduler_recovery", "scheduler_recovery_published",
      "scheduler_recovery", "scheduler_recovery_published", undefined]);
    const fresh = manualResumeVerdict(f.db, f.task(), wf(f));
    if (!fresh.ok) throw new Error(fresh.why);
    expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "改了理由"])).toMatchObject({ ok: true }); // reason replaced
    expect(await schedulerResume(f, manualResumeReason(fresh.facts))).toMatchObject({ ok: false, code: "conflict" });
    expect(resumes(f.db)).toHaveLength(0);
  }));

  test("PM's own workflow-resume is unchanged (manual mark, no MAN2 gate); the scheduler's `ledger` CLI still cannot call it", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    const v = manualResumeVerdict(f.db, f.task(), wf(f));
    if (!v.ok) throw new Error(v.why);
    expect(await f.cli("scheduler", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--reason", manualResumeReason(v.facts)))
      .toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--reason", "PM 核对后交回"))
      .toMatchObject({ ok: true });
    expect(resumes(f.db)[0].data).toMatchObject({ manual: true });
    expect(resumes(f.db)[0].data.manualResume).toBeUndefined();
  }));

  test("concurrent passes resume once", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    await policy(f, "on");
    verify(f);
    const all = (await Promise.all([tick(f), tick(f), tick(f)])).flat().filter((o) => o.taskId === "T1");
    expect(all.filter((o) => o.action === "resumed")).toHaveLength(1);
    expect(resumes(f.db)).toHaveLength(1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents").get()).toEqual({ n: 0 }); // MAN2 itself dispatches nothing
  }));
});

describe("observe and off", () => {
  test("default observe: one would-resume note per state version, no resume, no intent, no notice", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    verify(f);
    const before = state(f);
    for (let i = 0; i < 3; i++) await f.tick();
    expect(observed(f.db)).toHaveLength(1);
    expect(observed(f.db)[0]).toMatchObject({ actor: "scheduler", kind: "note", data: { mechanism: "manualStall", manualResume: { code: "deps_not_live" } } });
    expect(state(f)).toEqual(before);
    expect(f.notices).toEqual([]);
    expect(await wfSet(f, ["--reason-code", "deps_not_live", "--reason", "换个说法"])).toMatchObject({ ok: true }); // new state version
    await f.tick();
    await f.tick();
    expect(observed(f.db)).toHaveLength(2);
    expect(wf(f)).toMatchObject({ mode: "manual" });
  }));

  test("off writes nothing; an unreadable policy file or a throwing port is off", () => run(autoFixture(), async (f) => {
    await depsManual(f);
    verify(f);
    await policy(f, "off");
    const seq = projectSeq(f.db), before = state(f);
    await f.tick();
    expect([projectSeq(f.db), state(f)]).toEqual([seq, before]);
    writeFileSync(RECOVERY_POLICY_PATH, "{ broken");
    await f.tick();
    expect([projectSeq(f.db), state(f)]).toEqual([seq, before]);
    const out = await manualResumeTick(f.db, { p: { maxActiveWorkers: 2 } }, { resume: resumeAutoWorkflow, notifyPm: async () => {}, now: () => 1,
      policy: () => { throw new Error("port down"); } });
    expect(out).toEqual([{ project: "p", mode: "off", action: "none", why: expect.stringContaining("port down") }]);
    expect([projectSeq(f.db), getTask(f.db, "T1")!.rev]).toEqual([seq, before.workflow ? f.task().rev : 0]);
  }));
});
