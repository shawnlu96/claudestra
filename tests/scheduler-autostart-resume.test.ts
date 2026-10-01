/**
 * i28-A1 §4 自动交回：V1 10-01 的事件序列做金样本（合并人工结清为 cancelled → PM 把阶段 merge→fix → PM manual→manual 改成 ui 模板 →
 * 执行者 fix→review 交付新 head），下一轮必须交回；验收线 6 的反例逐条不交回；交回后的形状；与 PM 手动交回并发只留一条 workflow_resume。
 * 台账是临时库，调度身份的 ledger CLI 用进程内 runLedger 代替子进程。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { resumeAutoWorkflow } from "../src/lib/ledger-scheduler-resume.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { fallbackToManual } from "../src/lib/scheduler-fallback.js";
import { resolveMergeRun } from "../src/lib/scheduler-merge.js";
import { autoResumeTick, MERGE_RETRY_PREFIX, resumeVerdict } from "../src/lib/scheduler-autostart-resume.js";
import type { ServiceFacts } from "../src/lib/scheduler-autostart.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator", T = "i28-V1", PM = "agent-claudestra", EXEC = "agent-task-i28-v1";
const OLD = "465b7b4b721b9f25dfd0646fb82c293a21d373ec", NEW = "ffbbee22196f08b708a431533bb68c4a8df030c3";
const INTENT = "t68:s5404:r2:merge_deploy:a0";

let dir: string, db: Database, now: number, notes: string[], ledgerCalls: string[][];
let svc: ServiceFacts;

const pm = () => ({ actor: PM, now: now++ });
const exec = () => ({ actor: EXEC, now: now++ });

const schedulerLedger = async (...args: string[]) => {
  ledgerCalls.push(args);
  return runLedger(args.slice(1), {
    db, actor: "scheduler", projectIds: [P], loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => now++,
    autoDispatch: () => svc.autoDispatch, autoProjects: () => [...svc.projects],
  });
};
const tick = () => autoResumeTick({ db, svc, ledger: schedulerLedger, notifyPm: async (_p, text) => void notes.push(text), memo: new Set() });
const resumes = () => listEvents(db, { target: T }).filter((e) => e.data.op === "workflow_resume");

/** 卡走到 merge、合并日志卡在 unknown（V1 15:02 之前的状态） */
function toMergeUnknown(): void {
  createTask(db, { actor: PM, now: now++ }, { project: P, id: T, title: "V1", kind: "code", agent: EXEC, pm: PM, branch: "feat/i28-v1" });
  setWorkflow(db, pm(), { taskId: T, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "PM 接管" });
  db.query("UPDATE tasks SET stage = 'merge', round = 2, headSHA = ?, pr = 'https://github.com/x/y/pull/311' WHERE id = ?").run(OLD, T);
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
    VALUES (?, ?, ?, 'merge_deploy', 'merge', 1, 1, 2, 1, ?, 2, 'submitted', 'merge', 1, 1)`).run(INTENT, T, P, OLD);
  db.query(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, ?, ?, '311', 'feat/i28-v1', ?, '[]', 'unknown', 1, 1)`).run(INTENT, T, P, OLD);
}

/** V1 15:02 → 15:22：PM 结清为 cancelled、退回 fix、manual→manual 改 ui；执行者交付新 head */
function v1(outcome: "cancelled" | "failed" | "done" = "cancelled"): void {
  toMergeUnknown();
  resolveMergeRun(db, pm(), { intentId: INTENT, outcome, receipt: "gh pr view 311: state=OPEN 未合并" });
  moveStage(db, pm(), { taskId: T, from: "merge", to: "fix", text: "PM 退回修复：变基" });
  const t = getTask(db, T)!, w = getWorkflow(db, T)!;
  setWorkflow(db, pm(), { taskId: T, taskRev: t.rev, workflowRev: w.rev, template: "ui", templateVersion: 2, mode: "manual", authorFamily: "claude", fallback: w.fallback });
}

const deliverNew = (head = NEW, ctx = exec()) => deliver(db, ctx, { taskId: T, headSHA: head, moveFrom: "fix" });

beforeEach(() => {
  now = 1_000;
  notes = [];
  ledgerCalls = [];
  svc = { autoDispatch: true, projects: [P], maxWorkers: () => 4 };
  dir = mkdtempSync(join(tmpdir(), "i28-a1-resume-"));
  db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
});
afterEach(() => {
  closeLedger(join(dir, "ledger.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

describe("V1 金样本", () => {
  test("合并撤销 → 退回 fix → manual→manual 改 ui → 执行者交付新 head：下一轮交回，ui 模板、当前 specRev、事件带 auto / trigger / deliver", async () => {
    v1();
    deliverNew();
    expect(resumeVerdict(db, getTask(db, T)!, getWorkflow(db, T))).toMatchObject({ ok: true });
    expect(await tick()).toEqual([]);
    const w = getWorkflow(db, T)!;
    expect(w).toMatchObject({ mode: "auto", template: "ui", specRev: getTask(db, T)!.specRev });
    const [r] = resumes();
    const trigger = listEvents(db, { target: T }).find((e) => e.data.op === "merge_resolve")!.seq;
    const d = listEvents(db, { target: T }).findLast((e) => e.kind === "deliver")!.seq;
    expect(r).toMatchObject({ actor: "scheduler", data: { auto: true, trigger, deliver: d } });
    expect(r.data.manual).toBeUndefined();
    expect(notes).toEqual([]);
    expect(await tick()).toEqual([]);
    expect(resumes()).toHaveLength(1);
  });

  test("合并结清为 failed 一样交回", async () => {
    v1("failed");
    deliverNew();
    await tick();
    expect(getWorkflow(db, T)!.mode).toBe("auto");
  });

  test("planner 因合并意图被取消退回人工（merge_retry_requires_pm）：取被取消意图的 head 比对，新 head 交回", async () => {
    toMergeUnknown();
    db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(INTENT);
    db.query("DELETE FROM scheduler_merges").run();
    fallbackToManual(db, { actor: "scheduler", now: now++ }, { taskId: T, reason: `${MERGE_RETRY_PREFIX}合并意图 ${INTENT} 已取消，先由 PM 核对外部结果` });
    moveStage(db, pm(), { taskId: T, from: "merge", to: "fix" });
    deliverNew();
    await tick();
    expect(getWorkflow(db, T)!.mode).toBe("auto");
  });
});

describe("反例：不交回", () => {
  const cases: [string, () => void][] = [
    ["还没交付", () => {}],
    ["交付的还是被撤销的 head", () => void deliverNew(OLD)],
    ["交付的不是执行者（PM 代交）", () => void deliverNew(NEW, pm())],
    ["交付后 PM 又动过阶段", () => { deliverNew(); moveStage(db, pm(), { taskId: T, from: "review", to: "fix" }); }],
    ["PM hold：manual→manual 带 --reason", () => {
      const t = getTask(db, T)!, w = getWorkflow(db, T)!;
      setWorkflow(db, pm(), { taskId: T, taskRev: t.rev, workflowRev: w.rev, template: w.template, templateVersion: w.templateVersion, mode: "manual",
        authorFamily: "claude", fallback: w.fallback, reason: "等 owner 看截图再合" });
      deliverNew();
    }],
    ["项目开关关着", () => { setAutostartSwitch(db, pm(), { project: P, on: false, reason: "owner 一键关" }); deliverNew(); }],
    ["autoDispatch 关着", () => { svc = { ...svc, autoDispatch: false }; deliverNew(); }],
    ["项目没列在 scheduler.json", () => { svc = { ...svc, projects: [] }; deliverNew(); }],
  ];
  for (const [name, after] of cases) {
    test(name, async () => {
      v1();
      after();
      await tick();
      expect(getWorkflow(db, T)!.mode).toBe("manual");
      expect(resumes()).toEqual([]);
    });
  }

  test("feature 开关关着：只影响这个 feature 下的卡", async () => {
    v1();
    db.query("INSERT INTO features (id, project, title, ownerWords, status, currentVersion, rev, createdBy, createdAt, updatedAt) VALUES ('f1', ?, 'F', '', 'active', 0, 1, 'x', 1, 1)").run(P);
    db.query("UPDATE tasks SET featureId = 'f1' WHERE id = ?").run(T);
    setAutostartSwitch(db, pm(), { project: P, on: false, featureId: "f1", reason: "这个 feature 先手动" });
    deliverNew();
    await tick();
    expect(getWorkflow(db, T)!.mode).toBe("manual");
  });

  test("合并结清为 done 不交回", async () => {
    v1("done");
    deliverNew();
    await tick();
    expect(resumes()).toEqual([]);
  });

  test("PM takeover 切的 manual（最近一次切换是带 takeover 的 workflow 事件）", async () => {
    toMergeUnknown();
    db.query("UPDATE scheduler_merges SET phase = 'ready'").run();
    db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(INTENT);
    const t = getTask(db, T)!, w = getWorkflow(db, T)!;
    setWorkflow(db, pm(), { taskId: T, taskRev: t.rev, workflowRev: w.rev, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude",
      fallback: w.fallback, reason: "PM 接管" });
    moveStage(db, pm(), { taskId: T, from: "merge", to: "fix" });
    deliverNew();
    await tick();
    expect(resumes()).toEqual([]);
  });

  test("别的原因退回人工（fallback_manual 不是 merge_retry）", async () => {
    toMergeUnknown();
    db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(INTENT);
    fallbackToManual(db, { actor: "scheduler", now: now++ }, { taskId: T, reason: "没有前后两张截图" });
    moveStage(db, pm(), { taskId: T, from: "merge", to: "fix" });
    deliverNew();
    await tick();
    expect(resumes()).toEqual([]);
  });

  test("PM 已经手动交回过（最近一次是 workflow_resume）", async () => {
    v1();
    deliverNew();
    const t = getTask(db, T)!, w = getWorkflow(db, T)!;
    resumeAutoWorkflow(db, pm(), { taskId: T, taskRev: t.rev, workflowRev: w.rev, reason: "PM 手动交回", maxWorkers: 4 });
    await tick();
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0].actor).toBe(PM);
  });
});

describe("并发与核心拒绝", () => {
  test("和 PM 手动交回并发：判定之后 PM 先交回 → 调度这边输了竞争，不出声，只有一条 workflow_resume", async () => {
    v1();
    deliverNew();
    const t = getTask(db, T)!, w = getWorkflow(db, T)!;
    const raced = async (...args: string[]) => {
      if (args[1] === "scheduler-auto-resume") resumeAutoWorkflow(db, pm(), { taskId: T, taskRev: t.rev, workflowRev: w.rev, reason: "PM 抢先", maxWorkers: 4 });
      return schedulerLedger(...args);
    };
    const failed = await autoResumeTick({ db, svc, ledger: raced, notifyPm: async (_p, x) => void notes.push(x), memo: new Set() });
    expect(failed).toEqual([]);
    expect(notes).toEqual([]);
    expect(resumes().map((e) => e.actor)).toEqual([PM]);
  });

  test("核心拒绝（还有结果未定的意图）：通知 PM 一次，同一次交付不再重试", async () => {
    v1();
    deliverNew();
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('open-one', ?, ?, 'review', 'review', 1, 1, 1, 1, ?, 2, 'unknown', 'x', 1, 1)`).run(T, P, NEW);
    const memo = new Set<string>();
    const env = { db, svc, ledger: schedulerLedger, notifyPm: async (_p: string, x: string) => void notes.push(x), memo };
    expect(await autoResumeTick(env)).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("open-one");
    const calls = ledgerCalls.length;
    await autoResumeTick(env);
    expect(notes).toHaveLength(1);
    expect(ledgerCalls.length).toBe(calls);
    expect(getWorkflow(db, T)!.mode).toBe("manual");
  });

  test("只有调度身份能跑 scheduler-auto-resume；PM 的 workflow-resume 行为不变", async () => {
    v1();
    deliverNew();
    const t = getTask(db, T)!, w = getWorkflow(db, T)!;
    const asPm = await runLedger(["scheduler-auto-resume", T, "--rev", String(t.rev), "--workflow-rev", String(w.rev), "--max-workers", "4"], {
      db, actor: PM, projectIds: [P], loadRegistry: async () => ({}) as never, saveRegistry: async () => {}, now: () => now++,
    });
    expect(asPm).toMatchObject({ ok: false, code: "forbidden" });
    const r = resumeAutoWorkflow(db, pm(), { taskId: T, taskRev: t.rev, workflowRev: w.rev, reason: "PM 交回", maxWorkers: 4 });
    expect(r.workflow.mode).toBe("auto");
    expect(resumes()[0].data).toMatchObject({ manual: true });
    expect(resumes()[0].data.auto).toBeUndefined();
  });
});
