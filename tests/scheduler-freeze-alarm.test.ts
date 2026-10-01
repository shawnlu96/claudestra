import { describe, expect, test } from "bun:test";
import { listEvents } from "../src/lib/ledger-store.js";
import { PLAN_REJECT_MS } from "../src/lib/scheduler-auto-tick.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const FROZEN = "项目合并队列已冻结";

/** A card in build whose write plan the ledger refuses with whatever `refuse.with` says (null = let it through). */
async function refusedCard() {
  const f = autoFixture();
  await toBuild(f);
  const refuse: { with: { code: string; error: string } | null } = { with: { code: "conflict", error: FROZEN } };
  const real = f.tickDeps.manager;
  f.tickDeps.manager = async (...args) => (args[1] === "scheduler-plan" && refuse.with ? { ok: false, ...refuse.with } : real(...args));
  const alarms = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "scheduler" && e.data.op === "plan_rejected");
  return { f, refuse, alarms };
}

describe("i28-M10 refused scheduler plans alarm PM once per reason", () => {
  test("three refusals for one reason: one ledger event and one notice, then silence", async () => {
    const { f, alarms } = await refusedCard();
    try {
      expect(await f.tick()).toMatchObject({ step: "replan", detail: `计划没写进台账：${FROZEN}` });
      await f.tick();
      expect(f.notices).toEqual([]);
      expect(await f.tick()).toMatchObject({ step: "replan", detail: `计划没写进台账：${FROZEN}；已报警 PM` });
      expect(f.notices).toHaveLength(1);
      expect(f.notices[0]).toContain("T1 的调度计划连续 3 次被台账拒收");
      expect(f.notices[0]).toContain(`[conflict] ${FROZEN}`);
      expect(f.notices[0]).toContain("查 scheduler_merges 未结运行 → scheduler-merge-resolve → unfreeze");
      expect(alarms().map((e) => [e.actor, e.data.code, e.data.reason])).toEqual([["scheduler", "conflict", FROZEN]]);
      for (let i = 0; i < 5; i++) await f.tick();
      expect(f.notices).toHaveLength(1);
      expect(alarms()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("a changed reason restarts the count and is reported on its own; the advice follows the reason", async () => {
    const { f, refuse, alarms } = await refusedCard();
    try {
      for (let i = 0; i < 3; i++) await f.tick();
      refuse.with = { code: "conflict", error: "任务被前置挡住：T0\n第二行不算原因" };
      await f.tick();
      await f.tick();
      expect(f.notices).toHaveLength(1);
      await f.tick();
      expect(f.notices).toHaveLength(2);
      expect(f.notices[1]).toContain("[conflict] 任务被前置挡住：T0");
      expect(f.notices[1]).not.toContain("第二行");
      expect(f.notices[1]).toContain("workflow-set --mode manual");
      refuse.with = { code: "invalid", error: "任务被前置挡住：T0" }; // same text, other code = another reason
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.notices).toHaveLength(3);
      expect(alarms()).toHaveLength(3);
    } finally { f.close(); }
  });

  test("one successful write clears the count; the same reason later is reported again", async () => {
    const { f, refuse, alarms } = await refusedCard();
    try {
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.notices).toHaveLength(1);
      refuse.with = null;
      expect(await f.tick()).toMatchObject({ step: "sent" });
      // The card now waits on its order; pull it back to an unplanned state by cancelling the order intent.
      const sent = f.intents().at(-1)!;
      f.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?").run(sent.id);
      f.db.query("DELETE FROM scheduler_resources WHERE intentId = ?").run(sent.id);
      refuse.with = { code: "conflict", error: FROZEN };
      await f.tick();
      await f.tick();
      expect(f.notices).toHaveLength(1);
      await f.tick();
      expect(f.notices).toHaveLength(2);
      expect(alarms()).toHaveLength(1); // the ledger keeps one event per card + reason
    } finally { f.close(); }
  });

  test("a refusal older than five minutes is reported before the third tick", async () => {
    const { f } = await refusedCard();
    try {
      await f.tick();
      f.advance(PLAN_REJECT_MS);
      expect(await f.tick()).toMatchObject({ detail: expect.stringContaining("已报警 PM") });
      expect(f.notices[0]).toContain("连续 2 次被台账拒收（5 分钟）");
    } finally { f.close(); }
  });

  test("a lost notice is logged, not marked told, and retried on the next tick", async () => {
    const { f, alarms } = await refusedCard();
    const real = f.tickDeps.notifyPm;
    let down = true;
    f.tickDeps.notifyPm = async (t, text) => { if (down) throw new Error("bridge 不在"); return real(t, text); };
    const logged: string[] = [];
    const err = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try {
      await f.tick();
      await f.tick();
      expect(await f.tick()).toMatchObject({ detail: expect.stringContaining("报警没发出去，下个 tick 重发") });
      expect(logged.some((l) => l.includes("计划拒收报警没发出去") && l.includes("bridge 不在"))).toBe(true);
      expect(f.notices).toEqual([]);
      expect(await f.tick()).toMatchObject({ detail: expect.stringContaining("报警没发出去") });
      down = false;
      expect(await f.tick()).toMatchObject({ detail: expect.stringContaining("已报警 PM") });
      expect(f.notices).toHaveLength(1);
      await f.tick();
      expect(f.notices).toHaveLength(1);
      expect(alarms()).toHaveLength(1);
    } finally { console.error = err; f.close(); }
  });

  test("an alarm that cannot be recorded is not sent and is retried", async () => {
    const { f, alarms } = await refusedCard();
    const real = f.tickDeps.manager;
    let broken = true;
    f.tickDeps.manager = async (...args) => (args[1] === "scheduler-plan-rejected" && broken ? { ok: false, error: "台账锁住了" } : real(...args));
    try {
      for (let i = 0; i < 3; i++) await f.tick();
      expect(await f.tick()).toMatchObject({ step: "held", detail: expect.stringContaining("拒收报警没记上") });
      expect(f.notices).toEqual([]);
      broken = false;
      await f.tick();
      expect(f.notices).toHaveLength(1);
      expect(alarms()).toHaveLength(1);
    } finally { f.close(); }
  });

  test("the ledger command is scheduler-only and dedups by card + reason", async () => {
    const f = autoFixture();
    try {
      expect(await f.cli("pm", "scheduler-plan-rejected", "T1", "--code", "conflict", "--text", FROZEN)).toMatchObject({ ok: false, code: "forbidden" });
      const first = await f.cli("scheduler", "scheduler-plan-rejected", "T1", "--code", "conflict", "--text", FROZEN);
      expect(first).toMatchObject({ ok: true, duplicate: false, event: { kind: "scheduler", data: { op: "plan_rejected" } } });
      const again = await f.cli("scheduler", "scheduler-plan-rejected", "T1", "--code", "conflict", "--text", FROZEN);
      expect(again).toMatchObject({ ok: true, duplicate: true, event: { seq: (first.event as { seq: number }).seq } });
      expect(await f.cli("scheduler", "scheduler-plan-rejected", "T1", "--code", "conflict", "--text", "别的原因")).toMatchObject({ duplicate: false });
      expect(await f.cli("scheduler", "scheduler-plan-rejected", "T1", "--code", "conflict", "--text", "两行\n原因")).toMatchObject({ ok: false, code: "invalid" });
    } finally { f.close(); }
  });
});
