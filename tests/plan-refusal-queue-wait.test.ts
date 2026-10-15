import { describe, expect, test } from "bun:test";
import { listEvents } from "../src/lib/ledger-store.js";
import { PLAN_REJECT_MS } from "../src/lib/scheduler-auto-tick.js";
import { isResourceWait } from "../src/lib/scheduler-plan-refusal.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const held = (holder: string) => `统一合并队列：既有意图持槽，先结清（${holder} 先）`;
const STILL_REFUSED = [
  "统一合并队列：先核实在途运行（T0 先）",
  "统一合并队列：先核实在途运行",
  "统一合并队列：既有意图待恢复，不建第二意图（T0 先）",
  "统一合并队列：既有意图持槽，先结清",
  "统一合并队列：没有可认领版本",
  `别的失败：${held("T0")}`,
  `${held("T0")}；队列已冻结`,
  "项目合并队列已冻结",
];

function observePlans(f: ReturnType<typeof autoFixture>, error: string) {
  const manager = f.tickDeps.manager;
  const state = { rejectedWrites: 0, plans: 0 };
  f.tickDeps.manager = async (...args) => {
    if (args[1] === "scheduler-plan-rejected") state.rejectedWrites++;
    if (args[1] === "scheduler-plan") { state.plans++; return { ok: false, code: "conflict", error }; }
    return manager(...args);
  };
  const alarms = () => listEvents(f.db, { target: "T1", project: "p" }).filter((e) => e.data.op === "plan_rejected");
  return { state, alarms };
}

describe("QUEUEWAIT1 unified merge queue slot held by another card is queueing", () => {
  test("classifier: another card holding the slot waits; own slot, other queue reasons and loose matches do not", () => {
    expect(isResourceWait("conflict", held("rename-floka-INSTALLCFG1"), "T1")).toBe(true);
    expect(isResourceWait("conflict", held("T 0"), "T1")).toBe(true);
    expect(isResourceWait("conflict", held("T1"), "T1")).toBe(false);
    expect(isResourceWait("conflict", held("T0"))).toBe(false);
    expect(isResourceWait("invalid", held("T0"), "T1")).toBe(false);
    for (const error of STILL_REFUSED) expect(isResourceWait("conflict", error, "T1")).toBe(false);
  });

  test("[验收线 1] another card holding the slot never counts, records or tells PM", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      const error = held("T0");
      const { state, alarms } = observePlans(f, error);
      for (let tick = 0; tick < 8; tick++) {
        expect(await f.tick()).toMatchObject({ step: "wait", detail: error });
        f.advance(PLAN_REJECT_MS);
      }
      expect(state).toMatchObject({ plans: 8, rejectedWrites: 0 });
      expect([alarms(), f.notices]).toEqual([[], []]);
    } finally { f.close(); }
  });

  for (const error of [held("T1"), ...STILL_REFUSED.slice(0, 3)]) {
    test(`[验收线 2/3] still a refusal, alarms once on tick three: ${error}`, async () => {
      const f = autoFixture();
      try {
        await toBuild(f);
        const { state, alarms } = observePlans(f, error);
        for (let tick = 0; tick < 2; tick++) expect(await f.tick()).toMatchObject({ step: "replan" });
        expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([0, 0, 0]);
        await f.tick();
        expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([1, 1, 1]);
        expect(f.notices[0]).toContain(`连续 3 次被台账拒收（0 分钟）：[conflict] ${error}`);
        for (let tick = 0; tick < 4; tick++) await f.tick();
        expect([state.rejectedWrites, alarms().length, f.notices.length]).toEqual([1, 1, 1]);
      } finally { f.close(); }
    });
  }
});
