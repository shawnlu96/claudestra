import { describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { PLAN_REJECT_MS } from "../src/lib/scheduler-auto-tick.js";
import { isResourceWait } from "../src/lib/scheduler-plan-refusal.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const OVERLAPS = [
  "资源 merge:claude-orchestrator 与 merge:claude-orchestrator 重叠（i28-C0 占用）",
  "资源 merge:p 与 merge:p 重叠（T 0 占用）",
  "资源 slot:p:0 与 slot:p:0 重叠（T0 占用）",
  "资源 src/lib/x.ts 与 src/lib/* 重叠（T0 占用）",
];
const OTHER_REFUSALS = [
  { code: "conflict", error: "项目合并队列已冻结" },
  { code: "conflict", error: "任务、流程或项目事件已前进，丢弃旧计划重新计算" },
  { code: "conflict", error: "一张卡最多持有一个 worker 槽；后续派单须沿用已持有的槽" },
  { code: "conflict", error: "资源 merge:p 与 merge:p 重叠" },
  { code: "invalid", error: OVERLAPS[0] },
  { code: "invalid", error: "资源名不合法或一次超过 32 个" },
];

function observePlans(f: ReturnType<typeof autoFixture>, refusal: { code: string; error: string } | null = null) {
  const manager = f.tickDeps.manager;
  const state = { refusal, rejectedWrites: 0, plans: 0 };
  f.tickDeps.manager = async (...args) => {
    if (args[1] === "scheduler-plan-rejected") state.rejectedWrites++;
    if (args[1] === "scheduler-plan") {
      state.plans++;
      if (state.refusal) return { ok: false, ...state.refusal };
    }
    return manager(...args);
  };
  const alarms = () => listEvents(f.db, { target: "T1", project: "p" }).filter((e) => e.data.op === "plan_rejected");
  return { state, alarms };
}

describe("i28-MQ1 resource occupancy waits without a plan refusal alarm", () => {
  test("pure classifier accepts only the resource-overlap conflict shape", () => {
    for (const error of OVERLAPS) expect(isResourceWait("conflict", error)).toBe(true);
    for (const { code, error } of OTHER_REFUSALS) expect(isResourceWait(code, error)).toBe(false);
    expect(isResourceWait("unknown", OVERLAPS[0])).toBe(false);
    expect(isResourceWait("conflict", `别的失败：${OVERLAPS[0]}`)).toBe(false);
    expect(isResourceWait("conflict", `${OVERLAPS[0]}；队列已冻结`)).toBe(false);
  });

  for (const error of OVERLAPS) {
    test(`repeated occupancy stays quiet beyond both thresholds: ${error}`, async () => {
      const f = autoFixture();
      try {
        await toBuild(f);
        const { state, alarms } = observePlans(f, { code: "conflict", error });
        for (let tick = 0; tick < 8; tick++) {
          expect(await f.tick()).toMatchObject({ step: "wait", detail: error });
          f.advance(PLAN_REJECT_MS);
        }
        expect(state).toMatchObject({ plans: 8, rejectedWrites: 0 });
        expect(alarms()).toEqual([]);
        expect(f.notices).toEqual([]);
        // A real refusal after queueing must start its own three-tick count.
        state.refusal = { code: "conflict", error: "任务被前置挡住：T0" };
        for (let tick = 0; tick < 2; tick++) expect(await f.tick()).toMatchObject({ step: "replan" });
        expect(state.rejectedWrites).toBe(0);
        expect(f.notices).toEqual([]);
        await f.tick();
        expect(state.rejectedWrites).toBe(1);
        expect(alarms()).toHaveLength(1);
        expect(f.notices[0]).toContain("连续 3 次被台账拒收");
      } finally { f.close(); }
    });
  }

  for (const refusal of OTHER_REFUSALS) {
    test(`other refusals still alarm once on tick three: ${refusal.code} ${refusal.error}`, async () => {
      const f = autoFixture();
      try {
        await toBuild(f);
        const { state, alarms } = observePlans(f, refusal);
        for (let tick = 0; tick < 2; tick++) expect(await f.tick()).toMatchObject({ step: "replan" });
        expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([0, 0, 0]);
        await f.tick();
        expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([1, 1, 1]);
        expect(f.notices[0]).toContain(`连续 3 次被台账拒收（0 分钟）：[${refusal.code}] ${refusal.error}`);
        for (let tick = 0; tick < 4; tick++) await f.tick();
        expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([1, 1, 1]);
      } finally { f.close(); }
    });
  }

  test("a resource wait breaks an earlier refusal streak", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      const frozen = { code: "conflict", error: "项目合并队列已冻结" };
      const wait = { code: "conflict", error: "资源 merge:p 与 merge:p 重叠（T0 占用）" };
      const { state, alarms } = observePlans(f, frozen);
      for (let tick = 0; tick < 2; tick++) expect(await f.tick()).toMatchObject({ step: "replan" });
      state.refusal = wait;
      expect(await f.tick()).toMatchObject({ step: "wait", detail: wait.error });
      state.refusal = frozen;
      expect(await f.tick()).toMatchObject({ step: "replan" });
      expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([0, 0, 0]);
      for (let tick = 0; tick < 2; tick++) await f.tick();
      expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([1, 1, 1]);
      expect(f.notices[0]).toContain("连续 3 次被台账拒收");
    } finally { f.close(); }
  });

  for (const holderId of ["T0", "T 0"]) {
    test(`a real merge resource lock held by ${holderId} queues the reviewed card; releasing it resumes automatic merge`, async () => {
      const f = autoFixture();
      try {
        await toBuild(f);
        await f.tick();
        expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).ok).toBe(true);
        await f.tick(); // bind reviewer
        await f.tick(); // dispatch review
        expect((await f.review("pass", H1, [])).ok).toBe(true);
        expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
        createTask(f.db, f.at("owner"), { project: "p", id: holderId, title: "merging first", kind: "code" });
        f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,
          templateVersion,status,reason,createdAt,updatedAt)
          VALUES ('merge-first',?,'p','merge_deploy','merge',0,0,1,1,2,'submitted','waiting for CI',100,100)`).run(holderId);
        f.db.query(`INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt)
          VALUES ('p','merge:p',?,'merge-first',100)`).run(holderId);
        const { state, alarms } = observePlans(f);
        for (let tick = 0; tick < 8; tick++) {
          expect(await f.tick()).toMatchObject({ step: "wait", detail: `资源 merge:p 与 merge:p 重叠（${holderId} 占用）` });
          f.advance(PLAN_REJECT_MS);
        }
        expect(state).toMatchObject({ plans: 8, rejectedWrites: 0 });
        expect([alarms(), f.notices]).toEqual([[], []]);
        expect(f.task().stage).toBe("merge");
        expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
        expect(f.intents().filter((i) => i.action === "merge")).toHaveLength(1);
        expect((await f.cli("scheduler", "scheduler-settle", "merge-first", "--from", "submitted", "--to", "done", "--receipt", "merged")).ok).toBe(true);
        expect(await f.tick()).toMatchObject({ step: "merge_queue" });
        expect(f.intents().at(-1)).toMatchObject({ action: "merge", status: "pending" });
        expect([alarms(), f.notices]).toEqual([[], []]);
      } finally { f.close(); }
    });
  }
});
