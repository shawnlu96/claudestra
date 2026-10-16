/**
 * PMQUIET1 验收线 1 / 2 / 3 / 5 / 6（缺截图自动派作者补齐）：真台账 + 进程内正规 ledger CLI 的整轮（autoFixture，ui 卡），
 * 以及规划器单元（同一张卡的快照改一处）。pmQuiet 开关经 configurePmQuietMode 注入。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { UI_REJECTED } from "../src/lib/ledger-ui-approve-verdict.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { pmNoticeGate, pmNoticeRefOf } from "../src/lib/pm-notice-current.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { takeOrderResult } from "../src/lib/order-take.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { configureSelfHealMode } from "../src/lib/scheduler-fix-selfheal.js";
import { planScheduler, type PlannerSnapshot } from "../src/lib/scheduler-plan.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { configurePmQuietMode, UI_REPAIR_FAMILY, uiRepairAttempts } from "../src/lib/scheduler-ui-evidence-repair.js";
import { autoFixture, DIGEST, H2, P1, P2, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const H3 = "3".repeat(40);
let restore: (() => void)[] = [];
const quiet = (m: RecoveryMode) => restore.push(configurePmQuietMode(() => m));
afterEach(() => { for (const r of restore.splice(0).reverse()) r(); });

const dropShots = (f: F) => (shotsOf.set(f, f.task().extra.screenshots), f.db.run("UPDATE tasks SET extra = json_remove(extra, '$.screenshotsDigest', '$.screenshots') WHERE id = 'T1'"));
const snap = (f: F): PlannerSnapshot => autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 10_000 });
const plan = (f: F) => planScheduler(snap(f));
const stages = (f: F) => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "stage").map((e) => `${e.data.from}>${e.data.to}`);
/** 已送达作者的修复派单（补截图单走 fix 节点；没有代码 P1 时 fix 节点只派补截图单） */
const repairOrders = (f: F) => f.intents().filter((i) => i.action === "dispatch" && i.node === "fix" && i.status === "done");
const shotsOf = new WeakMap<F, unknown>();

/** UI 卡：build 交付 H2，审查派出，交付里没有截图（摘要缺失）；`rows` 是审查结论 */
async function reviewed(rows: object[] = [], verdict: "pass" | "changes" = "pass"): Promise<F> {
  const f = autoFixture({ template: "ui" });
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H2);
  await f.tick();
  await f.tick();
  dropShots(f);
  await f.review(verdict, H2, rows);
  return f;
}

/** 作者按补图单交付（同 head），审查员对新一轮再给 pass（默认 A：补齐后照现有流程进下一轮审查） */
async function redeliver(f: F, shots: boolean) {
  await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", H2);
  if (shots) f.db.run(`UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?, '$.screenshots', json(?)) WHERE id = 'T1'`, [DIGEST, JSON.stringify(shotsOf.get(f))]);
  await f.tick();
  await f.tick();
  await f.review("pass", H2, []);
}

describe("[验收线 1] review 阶段：同 head、本轮有效 pass，唯一缺截图", () => {
  test("修前红（off：退人工 + 推 PM）；修后绿（on：作者补图 channel 工单，卡保持 auto，不退人工、不推 PM、不加审查轮次）", async () => {
    quiet("off");
    const red = await reviewed();
    try {
      const notices = red.notices.length;
      expect(await red.tick()).toMatchObject({ step: "manual", detail: "ui_missing_screenshots：前后截图摘要缺失，不能请人看旧图" });
      expect(red.notices.length).toBe(notices + 1);
      expect(getWorkflow(red.db, "T1")?.mode).toBe("manual");
    } finally { red.close(); }

    restore.splice(0).forEach((r) => r());
    quiet("on");
    const f = await reviewed();
    try {
      const notices = f.notices.length, round = f.task().round, reviews = f.intents().filter((i) => i.action === "review").length;
      await f.tick(); // review → fix（不换轮）
      expect(f.task()).toMatchObject({ stage: "fix", round });
      const d = plan(f);
      expect(d).toMatchObject({ kind: "intent", action: "dispatch", node: "fix", recipient: "agent-task-one" });
      const probe = d.kind === "intent" ? d.workOrder?.findings[0]?.probe ?? "" : "";
      for (const s of [H2, "规格第 1 版", `第 ${round} 轮`, "uiEvidence", "不用改代码", "视觉验收仍由 PM / owner 做"]) expect(probe).toContain(s);
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(f.sent.at(-1)).toMatchObject({ agent: "agent-task-one", route: "channel" });
      for (let i = 0; i < 3; i++) await f.tick(); // 重复 tick：不多派
      expect(repairOrders(f)).toHaveLength(1);
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
      expect(f.notices.length).toBe(notices);
      expect(f.task().round).toBe(round);
      expect(f.intents().filter((i) => i.action === "review").length).toBe(reviews);
      expect(stages(f).filter((s) => s === "fix>review")).toEqual([]); // 不走 SELFHEAL1 同 head 回审
    } finally { f.close(); }
  });
});

describe("[验收线 1] 作者真实领单（复审 repair-pull）", () => {
  const take = (f: F) => {
    const author = getSchedulerSession(f.db, "T1", "author")!;
    return takeOrderResult(f.db, { agent: author.agent, sessionId: author.sessionId!, family: "claude-code", channelId: "" });
  };
  test("wake 派出补截图单后 take_order 领到同一张补图工单（findingId / probe 与规划器一致）；off 照旧空列表", async () => {
    quiet("on");
    const f = await reviewed();
    try {
      await f.tick(); // review → fix
      const d = plan(f), planned = d.kind === "intent" ? d.workOrder!.findings[0] : null;
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(f.sent.at(-1)?.text ?? "").toContain("take_order"); // wake：只叫作者去领
      const r = take(f);
      expect(r.ok && r.order).toMatchObject({ step: "fix", findings: [{ findingId: planned!.findingId, family: UI_REPAIR_FAMILY, severity: "P1" }] });
      const probe = r.ok ? r.order?.findings[0]?.probe ?? "" : "";
      for (const s of [H2, "规格第 1 版", "uiEvidence", "不用改代码"]) expect(probe).toContain(s);
      quiet("off");
      const old = take(f);
      expect(old.ok && old.order?.findings).toEqual([]);
    } finally { f.close(); }
  });

  test("审查来源证明失效（原派审意图作废）、规划器退人工：领单不合成补图单（复审 repair-proof）", async () => {
    quiet("on");
    const f = await reviewed();
    try {
      await f.cli("pm", "stage", "T1", "--from", "review", "--to", "fix", "--text", "缺截图退回");
      f.db.run("UPDATE scheduler_intents SET status = 'cancelled' WHERE taskId = 'T1' AND action = 'review'");
      expect(snap(f).reviewDispatches).toHaveLength(0);
      expect(plan(f)).toMatchObject({ kind: "escalate" });
      const r = take(f);
      expect(r.ok ? r.order?.findings.map((x) => x.family) ?? [] : ["?"]).not.toContain(UI_REPAIR_FAMILY);
    } finally { f.close(); }
  });

  test("有 P1 / 截图被拒：领单不出补图工单", async () => {
    quiet("on");
    const f = await reviewed([P1], "changes");
    try {
      await f.tick();
      expect(f.task().stage).toBe("fix");
      const r = take(f), fams = r.ok ? r.order?.findings.map((x) => x.family) ?? [] : [];
      expect(fams.length).toBeGreaterThan(0);
      expect(fams).not.toContain(UI_REPAIR_FAMILY);
    } finally { f.close(); }
    const g = await reviewed();
    try {
      await g.tick();
      expect(g.task().stage).toBe("fix");
      appendEvent(g.db, { actor: "pm", now: 20_000 }, { project: "p", target: "T1", kind: "decision", text: "截图不过",
        data: { op: UI_REJECTED, head: H2, specRev: 1, round: g.task().round } });
      const rej = take(g);
      expect(rej.ok ? rej.order?.findings.map((x) => x.family) ?? [] : ["?"]).not.toContain(UI_REPAIR_FAMILY);
    } finally { g.close(); }
  });
});

describe("[验收线 2] 已在 fix、没有 P1、满足原自救条件", () => {
  test("不再同 head 回审，交补截图工单；off 时原 selfHealBeforeManual 回审保留", async () => {
    quiet("off");
    const f = await reviewed();
    try {
      restore.push(configureSelfHealMode(() => "on"));
      await f.cli("pm", "stage", "T1", "--from", "review", "--to", "fix", "--text", "缺截图退回");
      expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "review" }); // 旧：fix→review 自救
      quiet("on");
      const d = plan(f);
      expect(d).toMatchObject({ kind: "intent", action: "dispatch", node: "fix", recipient: "agent-task-one",
        workOrder: { findings: [{ family: UI_REPAIR_FAMILY, severity: "P1" }] } });
    } finally { f.close(); }
  });

  test("补齐 uiEvidence 后照常走 UI 验收（通知 PM 看图，不是自动批准）", async () => {
    quiet("on");
    const f = await reviewed();
    try {
      await f.tick();
      await f.tick();
      await redeliver(f, true);
      const before = f.notices.length;
      expect(await f.tick()).toMatchObject({ step: "ask", detail: expect.stringContaining("pm_notice") });
      expect(f.notices.length).toBe(before + 1);
      expect(f.notices.at(-1)).toContain("请看前后截图");
      expect(f.task().stage).toBe("review"); // 截图补齐 ≠ 批准：仍等 PM ui-approve
    } finally { f.close(); }
  });
});

describe("[验收线 3] 计次、重启、超限、换 head", () => {
  test("两次补图仍缺才退人工一次（带可复核尾签）；重复 tick / 重启不多计", async () => {
    quiet("on");
    const f = await reviewed();
    try {
      await f.tick();
      await f.tick();
      expect(uiRepairAttempts(snap(f))).toBe(1);
      await redeliver(f, false);
      await f.tick(); // 第 2 段 fix
      await f.tick(); // 第 2 张补图单
      expect(repairOrders(f)).toHaveLength(2);
      // 计次只从台账读（事件 + 意图），进程重启不丢不多
      expect(uiRepairAttempts(snap(f))).toBe(2);
      await redeliver(f, false);
      const before = f.notices.length;
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("2 次补截图仍未补齐") });
      for (let i = 0; i < 2; i++) await f.tick();
      expect(repairOrders(f)).toHaveLength(2);
      expect(f.notices.length).toBe(before + 1);
      const text = f.notices.at(-1)!;
      expect(pmNoticeRefOf(f.db, "p", text)).toEqual({ kind: "ui_evidence_repair", taskId: "T1", key: `${H2}:s1` });
      expect(pmNoticeGate(f.db, "p", text, 10_000)).toEqual({ send: true }); // 待办仍是现状
    } finally { f.close(); }
  });

  test("head 变了是新窗口：旧窗口的尝试不计；旧补图待办过期", async () => {
    quiet("on");
    const f = await reviewed();
    try {
      await f.tick();
      await f.tick();
      expect(uiRepairAttempts(snap(f))).toBe(1);
      f.db.run(`UPDATE tasks SET headSHA = '${H3}' WHERE id = 'T1'`);
      expect(uiRepairAttempts(snap(f))).toBe(0);
      expect(pmNoticeGate(f.db, "p", `x 〔提醒复核 ui_evidence_repair T1 ${H2}:s1〕`, 10_000)).toMatchObject({ send: false });
    } finally { f.close(); }
  });
});

describe("[验收线 5] 不误走补截图", () => {
  const blocked = async (setup: (f: F) => Promise<unknown> | unknown, rows: object[] = [], verdict: "pass" | "changes" = "pass") => {
    quiet("on");
    const f = await reviewed(rows, verdict);
    try {
      await setup(f);
      const d = plan(f);
      expect(d.kind === "intent" && d.action === "stage" && d.targetStage === "fix" && d.reason.includes("截图")).toBe(false);
      expect(d.kind === "intent" && d.workOrder?.findings.some((x) => x.family === UI_REPAIR_FAMILY)).toBeFalsy();
      return d;
    } finally { f.close(); }
  };

  test("存在 P1：照 P1 进 fix，修复单是代码 P1", async () => {
    const d = await blocked(() => {}, [P1], "changes");
    expect(d).toMatchObject({ kind: "intent", action: "stage", targetStage: "fix", reason: "P1 1 项，自动进入 fix" });
  });

  test("审查证明不足（派审回执对不上）：fix 阶段不交补截图单", async () => {
    quiet("on");
    const f = await reviewed();
    try {
      await f.cli("pm", "stage", "T1", "--from", "review", "--to", "fix", "--text", "缺截图退回");
      expect(plan(f)).toMatchObject({ kind: "intent", action: "dispatch", workOrder: { findings: [{ family: UI_REPAIR_FAMILY }] } });
      const d = planScheduler({ ...snap(f), reviewDispatches: [] });
      expect(d.kind === "intent" && d.workOrder?.findings.some((x) => x.family === UI_REPAIR_FAMILY)).toBeFalsy();
    } finally { f.close(); }
  });

  test("UI 被拒 / owner 审批未通过：不走补截图", async () => {
    await blocked((f) => appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision",
      data: { op: UI_REJECTED, by: "pm", head: H2, specRev: 1, round: f.task().round, screenshotsDigest: null, note: "不行" } }));
    quiet("on");
    const f = await reviewed();
    try {
      const s = snap(f);
      expect(planScheduler({ ...s, uiGate: { state: "rejected" } })).toMatchObject({ kind: "escalate", code: "ui_missing_screenshots" });
      expect(planScheduler({ ...s, pmUiGate: { state: "rejected", head: H2, specRev: 1, round: s.task.round, screenshotsDigest: "", seq: 1 } as never }))
        .toMatchObject({ kind: "escalate", code: "ui_missing_screenshots" });
    } finally { f.close(); }
  });

  test("只有 P2 的 changes 仍按原路，只看截图门；修复阶段仅凭「没有 P1」而不是 ui 卡 / 不缺截图都不算缺图", async () => {
    quiet("on");
    const f = await reviewed([P2], "changes");
    try {
      const s = snap(f);
      expect(planScheduler({ ...s, screenshotsDigest: DIGEST })).not.toMatchObject({ kind: "intent", action: "stage", targetStage: "fix" });
      expect(planScheduler({ ...s, workflow: { ...s.workflow!, template: "code" } })).not.toMatchObject({ targetStage: "fix" });
    } finally { f.close(); }
  });
});

describe("[验收线 6] pmQuiet=off 与 observe：逐字旧行为", () => {
  test("同一输入：决定、原因、通知正文、派单结果逐字一致", async () => {
    const run = async (m: RecoveryMode | null) => {
      if (m) quiet(m);
      const f = await reviewed();
      try {
        const d = plan(f), out = await f.tick();
        return JSON.stringify({ d, out, notices: f.notices, sent: f.sent.map((s) => s.text), wf: getWorkflow(f.db, "T1")?.mode, stage: f.task().stage });
      } finally { f.close(); restore.splice(0).forEach((r) => r()); }
    };
    const off = await run("off");
    expect(off).toContain("ui_missing_screenshots");
    expect(await run("observe")).toBe(off);
  });
});
