/**
 * merge-arch-MANAUTOQ1 验收线 1、3、4、5：S2W 形状（正式 manual 远端签审查回执、卡停 review，作者 claude、池审查员 codex，跨家族）在真实只读
 * LedgerReader + 正规 ledger CLI 上跑完整自动开卡 tick（pmWakeTicks）。线 1：on 一轮推 merge + 请求人 scheduler 的人工合并请求 + 代排 note，
 * 再跑不重复。线 3：预筛到写入之间 head / round / 审查 / hold / 模式变化回 conflict 零写；推完之后 requestRefusal 不为 null 整笔回滚。
 * 线 4：调度身份走普通 manual-merge-request 仍被拒、新入口非调度身份被拒、actorMayConfigure 不认调度身份。线 5：缺省 observe 只记样本、off 零写。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { actorMayConfigure } from "../src/lib/ledger-scheduler-settle.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { recordSchedulerRequest } from "../src/lib/manual-merge-queue.js";
import { requestRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { highRiskRecoveryKey } from "../src/lib/recovery-key-class.js";
import { manualMergeAutoCli } from "../src/lib/scheduler-manual-merge-ledger.js";
import { manualMergeAutoMode, manualMergeCandidate, manualMergeReadiness } from "../src/lib/scheduler-manual-merge-ready.js";
import { manualMergeAutoTick } from "../src/lib/scheduler-manual-merge-tick.js";
import { H1 } from "./scheduler-auto-helpers.js";
import { autoNotes, clearPolicy, policy, readyWorld, requests, samples, type AutoWorld } from "./scheduler-manual-merge-auto-kit.test.js";
import { ok, PM, pmEvents, setMode } from "./scheduler-review-pm-kit.test.js";

let w: AutoWorld;
beforeEach(async () => { w = await readyWorld(); });
afterEach(() => { w.close(); clearPolicy(); });

const now = () => w.f.tickDeps.now!();
const allEvents = () => JSON.stringify(listEvents(w.db, {}));
const tables = () => ["tasks", "task_workflows", "scheduler_intents", "scheduler_resources", "asks", "meta", "lend_orders"]
  .map((t) => JSON.stringify(w.db.query(`SELECT * FROM ${t}`).all()));
const autoCli = (actor: string, fp: string, mode = "on") => w.as(actor, "scheduler-autostart", "manual-merge", "T1", "request", fp, "--mode", mode);
/** 只拦本功能的子命令：在它真正写入之前跑 mutate（模拟预筛之后、写入之前的变化） */
const raceTick = (mutate: () => unknown | Promise<unknown>) => {
  const base = w.tickEnv().ledger;
  return w.tick({ ledger: async (...args: string[]) => { if (args[2] === "manual-merge") await mutate(); return base(...args); } });
};
const untouched = () => {
  expect(w.f.task().stage).toBe("review");
  expect(requests(w)).toEqual([]);
  expect(autoNotes(w)).toEqual([]);
};

describe("[验收线 1] on：一轮代排、再跑不重复", () => {
  test("跨家族 pass 的 manual 卡：一轮后 stage=merge、请求人 scheduler 的请求绑定当前 head / specRev / round / review seq、代排 note；再跑零写", async () => {
    const c = manualMergeCandidate(w.db, "T1", now())!;
    expect(c).not.toBeNull();
    expect([c.reviewerFamily, c.authorFamily, c.reviewSeq]).toEqual(["codex", "claude", w.reviewSeq]);
    expect(await w.tick()).toEqual([]);
    expect(w.f.task().stage).toBe("merge");
    const [req, ...more] = requests(w);
    expect(more).toEqual([]);
    expect([req.requestedBy, req.head, req.specRev, req.round, req.review.seq, req.uiDigest]).toEqual(["scheduler", H1, 1, 1, w.reviewSeq, null]);
    expect(requestRefusal(w.db, req, now())).toBeNull(); // 推完之后的真实状态上队列判据成立，等 claim / controller 去合并
    const [note, ...notes] = autoNotes(w);
    expect(notes).toEqual([]);
    expect(note.actor).toBe("scheduler");
    expect(note.text).toBe(`调度器代排人工合并：依据审查 #${w.reviewSeq}（codex ≠ 作者 claude），指纹 ${c.fingerprint.slice(0, 12)}`);
    expect(note.data).toMatchObject({ fingerprint: c.fingerprint, request: req.seq, reviewSeq: w.reviewSeq, reviewerFamily: "codex", authorFamily: "claude" });
    const stage = listEvents(w.db, { target: "T1" }).filter((e) => e.kind === "stage").at(-1)!;
    expect([stage.actor, stage.data.from, stage.data.to]).toEqual(["scheduler", "review", "merge"]);
    expect(pmEvents(w.db)).toEqual([]); // 卡已离开 review，RVWAKE1 不再提醒

    const after = [allEvents(), tables()];
    for (let i = 0; i < 3; i++) { w.restart(); expect(await w.tick()).toEqual([]); }
    expect([allEvents(), tables()]).toEqual(after);
    expect(await autoCli("scheduler", c.fingerprint)).toMatchObject({ ok: true, outcome: "duplicate", note: note.seq }); // 同指纹再交：duplicate 不写
    expect([allEvents(), tables()]).toEqual(after);
  });
});

describe("[验收线 3] 竞态：预筛之后、写入之前变化 → conflict，零写", () => {
  const cases: [string, () => unknown | Promise<unknown>][] = [
    ["head", () => w.db.run("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = 'T1'", ["2".repeat(40)])],
    ["round", () => w.db.run("UPDATE tasks SET round = round + 1, rev = rev + 1 WHERE id = 'T1'")],
    ["新审查在跑", () => insertEvent(w.db, w.f.at(PM), { project: "p", target: "T1", kind: "step", data: { op: "assign", step: "review", round: 1, executor: "agent-x" } }, false)],
    ["hold", async () => {
      const wf = getWorkflow(w.db, "T1")!;
      await ok(w.as(PM, "workflow-set", "T1", "--rev", String(w.f.task().rev), "--workflow-rev", String(wf.rev), "--template", wf.template, "--version", "2",
        "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "pm_hold", "--reason", "PM 留人工"));
    }],
    ["模式", () => policy({ manualMergeAuto: "observe" })],
  ];
  for (const [what, mutate] of cases) {
    test(`${what} 变了：写入回 conflict，stage 仍 review、没有请求、没有 note，本轮不算失败`, async () => {
      expect(manualMergeCandidate(w.db, "T1", now())).not.toBeNull();
      expect(await raceTick(mutate)).toEqual([]);
      untouched();
      expect(samples(w)).toEqual([]);
    });
  }

  test("同指纹直接交给子命令：条件变了就 conflict（不是 ok）", async () => {
    const fp = manualMergeCandidate(w.db, "T1", now())!.fingerprint;
    w.db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'");
    const r = await autoCli("scheduler", fp);
    expect([r.ok, r.code]).toEqual([false, "conflict"]);
    untouched();
  });

  test("推完阶段后 requestRefusal 不为 null（卡缺 PR URL）：整笔回滚，stage 仍 review、没有请求 / note / 阶段事件", async () => {
    w.db.run("UPDATE tasks SET pr = NULL WHERE id = 'T1'");
    const fp = manualMergeCandidate(w.db, "T1", now())!.fingerprint; // 预筛不看 PR：只有推完之后的 requestRefusal 能拦
    const before = allEvents();
    const r = await autoCli("scheduler", fp);
    expect([r.ok, r.code]).toEqual([false, "conflict"]);
    expect(String(r.error)).toContain("不能排人工合并");
    untouched();
    expect(allEvents()).toBe(before);
    expect(await w.tick()).toEqual([]);
    untouched();
  });
});

describe("[验收线 4] 权限：只有新入口、只给调度身份", () => {
  test("调度身份走普通 manual-merge-request 仍被拒；actorMayConfigure 不认调度身份", async () => {
    await ok(w.as(PM, "stage", "T1", "--from", "review", "--to", "merge"));
    const r = await w.as("scheduler", "manual-merge-request", "T1", "--head", H1, "--spec-rev", "1", "--round", "1", "--review-seq", String(w.reviewSeq), "--reason", "冒用");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("forbidden");
    expect(actorMayConfigure(w.db, "scheduler", "p")).toBe(false);
    expect(requests(w)).toEqual([]);
  });

  test("新入口用非调度身份（PM / owner / 作者）被拒，lib 入口同样拒，零写", async () => {
    const fp = manualMergeCandidate(w.db, "T1", now())!.fingerprint;
    for (const actor of [PM, "owner", "agent-task-one"]) {
      const r = await autoCli(actor, fp);
      expect(r.ok).toBe(false);
      expect(["forbidden"]).toContain(String(r.code));
    }
    expect(() => manualMergeAutoCli(w.db, { actor: PM }, ["T1", "request", fp], { mode: "on" }, { projects: ["p"] })).toThrow("只有调度服务能写");
    expect(() => recordSchedulerRequest(w.db, { actor: PM }, { taskId: "T1", head: H1, specRev: 1, round: 1, reviewSeq: w.reviewSeq, reason: "x" }))
      .toThrow("只走调度服务身份");
    untouched();
  });

  test("项目不归调度服务管：新入口拒", () => {
    const fp = manualMergeCandidate(w.db, "T1", now())!.fingerprint;
    expect(() => manualMergeAutoCli(w.db, { actor: "scheduler" }, ["T1", "request", fp], { mode: "on" }, { projects: [] })).toThrow("不归调度服务管");
    untouched();
  });
});

describe("[验收线 5] 开关 manualMergeAuto", () => {
  test("权限类高风险键；未配置 = observe：只记样本（每个指纹一条），台账其他地方不变；指纹变了才再记", async () => {
    expect(highRiskRecoveryKey("manualMergeAuto")).toBe(true);
    policy({ manualMergeAuto: undefined });
    expect(manualMergeAutoMode("p")).toBe("observe");
    const fp = manualMergeCandidate(w.db, "T1", now())!.fingerprint;
    const before = tables();
    expect(await w.tick()).toEqual([]);
    expect(await w.tick()).toEqual([]);
    untouched();
    expect(tables()).toEqual(before);
    const [s, ...more] = samples(w);
    expect(more).toEqual([]);
    expect([s.actor, s.kind, s.data.actionKey]).toEqual(["scheduler", "note", `request:${fp}`]);
    expect(s.data).toMatchObject({ reviewSeq: w.reviewSeq, reviewerFamily: "codex", authorFamily: "claude", uiDigest: false, fingerprint: fp });
    expect(s.text).toContain("代排人工合并 T1");
    w.db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'");
    await w.tick();
    expect(samples(w)).toHaveLength(2);
    untouched();
  });

  test("off：逐字回到现状——不起子命令、不读写台账，其余 PM 提醒照旧", async () => {
    policy({ manualMergeAuto: "off" });
    await setMode(w, "off"); // RVWAKE1 也关掉，好比较整本台账
    const calls: string[][] = [];
    const before = [allEvents(), tables()];
    const base = w.tickEnv().ledger;
    expect(await w.tick({ ledger: async (...a: string[]) => { calls.push(a); return base(...a); } })).toEqual([]);
    expect(calls.filter((a) => a[2] === "manual-merge")).toEqual([]);
    expect([allEvents(), tables()]).toEqual(before);
    expect(await manualMergeAutoTick({ ...w.tickEnv(), ledger: async () => { throw new Error("off 不该调台账"); } })).toEqual([]);
    expect(manualMergeReadiness(w.db, "T1", now())).not.toHaveProperty("why"); // 条件都在，只是开关关着
  });

  test("off 与缺省 observe 下 RVWAKE1 提醒照旧（缺省 observe 记一条 would）", async () => {
    policy({ manualMergeAuto: "off" });
    await w.tick();
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["would"]);
    untouched();
  });

  test("租约丢了：SchedulerStopped 照原路径传播，零写", async () => {
    w.lease = false;
    await expect(manualMergeAutoTick(w.tickEnv())).rejects.toBeInstanceOf(SchedulerStopped);
    untouched();
  });
});
