/**
 * dispatch-recovery-RVWAKE1 验收线 1、3：S2W 形状（tests/scheduler-review-pm-kit.test.ts：正式 manual 远端签审查回执、卡停 review）在真实只读
 * LedgerReader + 正规 ledger CLI 上跑完整自动开卡 tick。线 1：旧路径（off / 缺省 observe / 其它提醒开着）不叫醒 PM，on 一轮送 feature PM 恰好一条，
 * 台账只多本功能事件。线 3：on / observe / off、重启、重复 note / memory、新审查 / 新 head / 换 PM、失败有界重试、记录到发送之间推进 / 换 PM / 失租。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { REVIEW_PM_REPEAT_MS } from "../src/lib/scheduler-review-pm-ledger.js";
import { reviewPmCandidate } from "../src/lib/scheduler-review-pm-wait.js";
import { business, FPM, ok, PM, pmEvents, pooledManual, setMode, type World } from "./scheduler-review-pm-kit.test.js";

let w: World & Awaited<ReturnType<typeof pooledManual>>;
beforeEach(async () => { w = await pooledManual(); });
afterEach(() => w.close());

const kinds = () => pmEvents(w.db).map((e) => [e.actor, e.data.kind, e.data.pm]);
const later = (ms: number) => w.f.advance(ms);

describe("线 1：S2W 形状", () => {
  test("旧路径不发：off 零写；缺省 observe 只记 would；其它 PM 提醒开着也不碰 review 卡；on 一轮给 feature PM 恰好 1 条，业务台账不变", async () => {
    expect(w.reader().query("PRAGMA query_only").get()).toEqual({ query_only: 1 });
    expect(w.f.task().stage).toBe("review");
    await setMode(w, "off");
    await setMode(w, "on", "--merge-pm-wait");
    await setMode(w, "on", "--spec-wait");
    const off = business(w.db);
    expect(await w.tick()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(business(w.db)).toEqual(off);
    expect(pmEvents(w.db)).toEqual([]);

    await setMode(w, "observe");
    expect(await w.tick()).toEqual([]);
    expect(w.sent).toEqual([]);
    expect(kinds()).toEqual([["scheduler", "would", FPM]]);

    await setMode(w, "on");
    const before = business(w.db);
    expect(await w.tick()).toEqual([]);
    expect(w.sent).toHaveLength(1);
    const { to, project, text } = w.sent[0];
    expect([to, project]).toEqual([FPM, "p"]);
    expect(text).toStartWith(`[审查已回] T1 head 111111111111 / specRev 1 / 第 1 轮：正规跨族审查 #${w.reviewSeq}（pass）已登记、无 P0/P1；卡仍停在 review`);
    for (const s of ["核当前完整门", "本提醒不代为确认", "推 merge", `审查 #${w.reviewSeq} 的 manual-merge-request`]) expect(text).toContain(s);
    expect(text).not.toMatch(/\/(Users|tmp|private|var)\/|b-sess|lend:|sig|report\.md|## 结论|peer:mate/);
    expect(business(w.db)).toEqual(before); // 审查 / 阶段 / 审批 / 截图 / 请求 / 意图 / 槽 / 出借单一样不动
    expect(w.f.task().stage).toBe("review");
    expect(kinds()).toEqual([["scheduler", "would", FPM], ["scheduler", "try", FPM], ["scheduler", "sent", FPM]]);
  });
});

describe("线 3：开关、去重、重试、重启", () => {
  test("observe 每实例只一条 would；切 on 立即发 1 条；之后同一实例不再发，重启、普通 note / memory / rev 变化也不重发", async () => {
    await w.tick();
    later(5 * REVIEW_PM_REPEAT_MS);
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(kinds()).toEqual([["scheduler", "would", FPM]]);
    await setMode(w, "on");
    await w.tick();
    await w.tick();
    expect(w.sent).toHaveLength(1);
    await ok(w.as(PM, "note", "T1", "PM 随手记一笔"));
    insertEvent(w.db, w.f.at("pm"), { project: "p", target: "T1", kind: "memory", text: "项目记忆", data: { op: "memory" } }, false);
    w.db.query("UPDATE tasks SET rev = rev + 1, title = '改了标题' WHERE id = 'T1'").run();
    for (let i = 0; i < 3; i++) {
      w.restart();
      later(REVIEW_PM_REPEAT_MS);
      expect(await w.tick()).toEqual([]);
    }
    expect(w.sent).toHaveLength(1);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["would", "try", "sent"]);
  });

  test("发送失败不记已送：30 分钟内不重发（重启也不），满 30 分钟同一实例重试一次，送达后停", async () => {
    await setMode(w, "on");
    w.send = async () => { throw new Error("bridge 不通"); };
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining(`审查已回提醒发给 ${FPM} 失败`)]);
    w.restart();
    later(REVIEW_PM_REPEAT_MS - 100);
    expect(await w.tick()).toEqual([]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
    w.send = async (s) => void w.sent.push(s);
    later(100);
    await w.tick();
    expect(w.sent).toHaveLength(1);
    expect(pmEvents(w.db).map((e) => [e.data.kind, e.data.n ?? null])).toEqual([["try", 1], ["try", 2], ["sent", null]]);
    later(10 * REVIEW_PM_REPEAT_MS);
    await w.tick();
    expect(w.sent).toHaveLength(1);
  });

  test("发送端回 false 不冒充已送", async () => {
    await setMode(w, "on");
    w.send = async () => false;
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("发送端回 false")]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  test("换 feature PM 是新实例：发给新 PM 一次；PM 推进阶段后旧实例不再发", async () => {
    await setMode(w, "on");
    await w.tick();
    await ok(w.as(PM, "autostart-set", "on", "--feature", w.fid, "--pm", PM, "--reason", "换人", "--project", "p"));
    await w.tick();
    expect(w.sent.map((s) => s.to)).toEqual([FPM, PM]);
    expect(new Set(pmEvents(w.db).map((e) => e.data.key)).size).toBe(2);
    await ok(w.as(PM, "stage", "T1", "--from", "review", "--to", "merge"));
    later(10 * REVIEW_PM_REPEAT_MS);
    await w.tick();
    expect(w.sent).toHaveLength(2);
    expect(reviewPmCandidate(w.db, "T1", 0)).toBeNull();
  });

  test("新一轮（退 fix → 交新 head → 回 review）旧实例不发；新轮没有正规审查前零提醒", async () => {
    await setMode(w, "on");
    await w.tick();
    await ok(w.as(PM, "stage", "T1", "--from", "review", "--to", "fix"));
    await ok(w.as("agent-task-one", "deliver", "T1", "--from", "fix", "--head", "3".repeat(40)));
    later(10 * REVIEW_PM_REPEAT_MS);
    expect(await w.tick()).toEqual([]);
    expect(w.f.task().round).toBe(2);
    expect(w.sent).toHaveLength(1);
    expect(reviewPmCandidate(w.db, "T1", 0)).toBeNull();
  });
});

describe("线 3：记录后到发送前的变化", () => {
  const afterRecord = (fn: () => unknown) => {
    w.afterLedger = async (args) => { if (args.includes("record")) { w.afterLedger = null; await fn(); } };
  };

  test("记录后 PM 推了 merge：不发陈旧动作，也不补发", async () => {
    await setMode(w, "on");
    afterRecord(() => ok(w.as(PM, "stage", "T1", "--from", "review", "--to", "merge")));
    expect(await w.tick()).toEqual([]);
    later(10 * REVIEW_PM_REPEAT_MS);
    await w.tick();
    expect(w.sent).toEqual([]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  for (const mode of ["off", "observe"]) {
    test(`记录后开关改成 ${mode}：不发、不追加已送；之后 ${mode === "off" ? "零写零发" : "只记 would"}`, async () => {
      await setMode(w, "on");
      afterRecord(() => setMode(w, mode));
      expect(await w.tick()).toEqual([]);
      expect(w.sent).toEqual([]);
      const before = JSON.stringify(w.db.query("SELECT * FROM events").all());
      later(10 * REVIEW_PM_REPEAT_MS);
      expect(await w.tick()).toEqual([]);
      expect(w.sent).toEqual([]);
      if (mode === "off") expect(JSON.stringify(w.db.query("SELECT * FROM events").all())).toBe(before);
      expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(mode === "off" ? ["try"] : ["try", "would"]);
    });
  }

  test("发出后到记已送前开关改 off：台账拒写 sent，只进本轮 failed，不冒已送", async () => {
    await setMode(w, "on");
    w.send = async (s) => { w.sent.push(s); await setMode(w, "off"); };
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("记已发失败")]);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  test("记录后换了 feature PM：不发给旧 PM，下一轮按新 PM 的新实例发", async () => {
    await setMode(w, "on");
    afterRecord(() => ok(w.as(PM, "autostart-set", "on", "--feature", w.fid, "--pm", PM, "--reason", "换人", "--project", "p")));
    await w.tick();
    expect(w.sent).toEqual([]);
    await w.tick();
    expect(w.sent.map((s) => s.to)).toEqual([PM]);
    expect(kinds()).toEqual([["scheduler", "try", FPM], ["scheduler", "try", PM], ["scheduler", "sent", PM]]);
  });

  test("记录后失租：发送端按存活检查拒发、不记已送；之后台账写 lease-lost 按原路径抛 SchedulerStopped", async () => {
    await setMode(w, "on");
    w.send = async (s) => { if (!w.lease) throw new Error("服务已不在租约内，不发"); w.sent.push(s); };
    afterRecord(() => { w.lease = false; });
    expect((await w.tick()).map((f) => f.error)).toEqual([expect.stringContaining("不发")]);
    expect(w.sent).toEqual([]);
    later(REVIEW_PM_REPEAT_MS);
    await expect(w.tick()).rejects.toBeInstanceOf(SchedulerStopped);
    expect(pmEvents(w.db).map((e) => e.data.kind)).toEqual(["try"]);
  });

  test("本功能记账失败只进本轮 failed，不抛、不盖别的错误", async () => {
    await setMode(w, "on");
    const ledger = w.tickEnv().ledger;
    const r = await w.tick({ ledger: async (...a: string[]) => (a.includes("review-pm") ? { ok: false, code: "internal", error: "坏了" } : ledger(...a)) });
    expect(r).toEqual([{ taskId: "T1", error: "审查已回提醒记账失败：坏了" }]);
    expect(w.sent).toEqual([]);
  });
});
