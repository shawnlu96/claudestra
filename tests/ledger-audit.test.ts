/** 台账巡检规则（src/lib/ledger-audit.ts）：每条规则一个正例一个反例、阈值边界、取数失败不跑、收件人路由、key 稳定 */
import { describe, expect, test } from "bun:test";
import {
  AUDIT_THRESHOLDS as TH, auditLedger, auditNoticeText, auditRecipient,
  type AuditAgent, type AuditRule, type AuditSnapshot,
} from "../src/lib/ledger-audit.js";
import type { EventKind, LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";

const MIN = 60_000;
const NOW = 1_000 * MIN;
const PM = "agent-claudestra";
const DISPATCH = "agent-pm-dispatch";
const EXE = "agent-task-t1";

let seq = 0;
function ev(target: string, ts: number, kind: EventKind, data: Record<string, unknown> = {}): LedgerEvent {
  return { seq: ++seq, ts, actor: "x", project: "p", target, kind, text: "", data, dedupKey: null };
}
function task(id: string, stage: Stage, over: Partial<LedgerTask> = {}): LedgerTask {
  return {
    id, project: "p", itemId: null, title: id, kind: "code", stage, stageBefore: null, round: 1, agent: EXE, pm: PM, branch: null,
    pr: null, headSHA: null, spec: null, specRev: 1, model: null, rev: 1, extra: {}, createdAt: 0, updatedAt: 0,
    assigneeKind: "agent", assignee: over.agent ?? EXE, ...over,
  };
}
/** 任务 id 在 stageAt 时刻进入 stage（建任务事件在 0 时刻） */
function entered(id: string, stage: Stage, stageAt: number, extra: LedgerEvent[] = [], over: Partial<LedgerTask> = {}) {
  return { task: task(id, stage, over), events: [ev(id, 0, "task", { op: "new", patch: { stage: "spec" } }), ev(id, stageAt, "stage", { from: "x", to: stage }), ...extra] };
}
function agent(name: string, over: Partial<AuditAgent> = {}): AuditAgent {
  return { name, projectId: "p", windowAlive: true, turn: "idle", lastWriteAt: null, startedAt: 0, ...over };
}
function snap(over: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return { project: "p", pms: [PM], tasks: [], agents: [agent(PM), agent(EXE)], reviewers: [], held: [], ownerInbox: [], ...over };
}
const rules = (s: AuditSnapshot, now = NOW) => auditLedger(s, now).findings.map((f) => f.rule);
const only = (s: AuditSnapshot, rule: AuditRule, now = NOW) => auditLedger(s, now).findings.filter((f) => f.rule === rule);

describe("review 阶段没有审查员", () => {
  const t = (at: number, extra: LedgerEvent[] = []) => entered("T1", "review", at, extra);
  test("超过 20 分钟、没有审查员也没有 note / review → 报「派审查员」", () => {
    const f = only(snap({ tasks: [t(NOW - 21 * MIN)] }), "review_no_reviewer");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ taskId: "T1", suggestion: "派审查员", notify: PM });
  });
  test("审查员在跑 → 不报", () => {
    expect(only(snap({ tasks: [t(NOW - 60 * MIN)], reviewers: [{ taskId: "T1", round: 1 }] }), "review_no_reviewer")).toEqual([]);
  });
  test("任务号不分大小写（审查员名单统一小写，台账 id 原样）", () => {
    expect(only(snap({ tasks: [t(NOW - 60 * MIN)], reviewers: [{ taskId: "t1", round: 1 }] }), "review_no_reviewer")).toEqual([]);
  });
  test("别的任务的审查员不算", () => {
    expect(only(snap({ tasks: [t(NOW - 60 * MIN)], reviewers: [{ taskId: "T9", round: 1 }] }), "review_no_reviewer")).toHaveLength(1);
  });
  test("最近的 note 把计时往后推", () => {
    const s = snap({ tasks: [t(NOW - 60 * MIN, [ev("T1", NOW - 5 * MIN, "note")])] });
    expect(only(s, "review_no_reviewer")).toEqual([]);
  });
  test("边界：恰好 20 分钟不报，多 1ms 报", () => {
    expect(only(snap({ tasks: [t(NOW - TH.reviewNoReviewerMs)] }), "review_no_reviewer")).toEqual([]);
    expect(only(snap({ tasks: [t(NOW - TH.reviewNoReviewerMs - 1)] }), "review_no_reviewer")).toHaveLength(1);
  });
  test("导入推断的近似时间不拿来判超时", () => {
    const x = entered("T1", "review", 0);
    x.events[1] = ev("T1", 0, "stage", { from: "build", to: "review", approxTime: true });
    expect(only(snap({ tasks: [x] }), "review_no_reviewer")).toEqual([]);
  });
  test("有调度助理时推给调度助理", () => {
    const f = only(snap({ pms: [PM, DISPATCH], tasks: [t(NOW - 30 * MIN)] }), "review_no_reviewer");
    expect(f[0].notify).toBe(DISPATCH);
  });
  test("审查员名单取不到（null）→ 规则不跑，也不列进 evaluated", () => {
    const r = auditLedger(snap({ tasks: [t(NOW - 60 * MIN)], reviewers: null }), NOW);
    expect(r.findings).toEqual([]);
    expect(r.evaluated).not.toContain("review_no_reviewer");
  });
});

describe("review 阶段审查已通过", () => {
  const passed = (stageAt: number, passAt: number, extra: LedgerEvent[] = [], verdict = "pass") =>
    entered("T1", "review", stageAt, [ev("T1", passAt, "review", { round: 1, verdict }), ...extra]);
  test("pass 之后 31 分钟还在 review → 推 PM「审查已通过，推进 merge 或等拍板」，不推「派审查员」", () => {
    const s = snap({ pms: [PM, DISPATCH], tasks: [passed(NOW - 60 * MIN, NOW - 31 * MIN)] });
    expect(only(s, "review_no_reviewer")).toEqual([]);
    const f = only(s, "review_passed_idle");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ taskId: "T1", since: NOW - 31 * MIN, suggestion: "审查已通过，推进 merge 或等拍板", notify: PM });
  });
  test("pass 之后 PM 写 note 不重开计时（key 与 since 都跟着 pass 那条）", () => {
    const f = only(snap({ tasks: [passed(NOW - 60 * MIN, NOW - 40 * MIN, [ev("T1", NOW - 5 * MIN, "note")])] }), "review_passed_idle");
    expect(f).toHaveLength(1);
    expect(f[0].since).toBe(NOW - 40 * MIN);
  });
  test("边界：pass 恰好 30 分钟不报，多 1ms 报", () => {
    expect(only(snap({ tasks: [passed(NOW - 60 * MIN, NOW - TH.reviewPassedIdleMs)] }), "review_passed_idle")).toEqual([]);
    expect(only(snap({ tasks: [passed(NOW - 60 * MIN, NOW - TH.reviewPassedIdleMs - 1)] }), "review_passed_idle")).toHaveLength(1);
  });
  test("最后一条结论不是 pass（changes）→ 仍按「没有审查员」判；又有审查员在跑 → 都不报", () => {
    const changes = passed(NOW - 60 * MIN, NOW - 25 * MIN, [], "changes");
    expect(only(snap({ tasks: [changes] }), "review_passed_idle")).toEqual([]);
    expect(only(snap({ tasks: [changes] }), "review_no_reviewer")).toHaveLength(1);
    const running = snap({ tasks: [passed(NOW - 60 * MIN, NOW - 40 * MIN)], reviewers: [{ taskId: "t1", round: 1 }] });
    expect(rules(running)).toEqual([]);
  });
  describe("开了编排班子（T30）：pass 之后还欠对抗式就不是等推 merge", () => {
    const POLICY = "Claude 审查员一轮；最后一轮对抗式";
    // 派审要排在 pass 前面（按 seq 判先后），所以先建派审再建 pass
    const withDispatch = (kind: string, passAt: number) =>
      entered("T1", "review", NOW - 60 * MIN, [ev("T1", passAt - MIN, "dispatch", { reviewer: kind, round: 1, head: null }), ev("T1", passAt, "review", { round: 1, verdict: "pass" })]);
    test("常规 pass 之后 31 分钟、规格卡要求对抗式 → 不对 PM 报「推进 merge」，只对调度助理报「派对抗式」", () => {
      const s = snap({ pms: [PM, DISPATCH], team: { dispatcher: DISPATCH }, tasks: [{ ...withDispatch("regular", NOW - 31 * MIN), specPolicy: POLICY }] });
      expect(only(s, "review_passed_idle")).toEqual([]);
      const f = auditLedger(s, NOW).findings;
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule: "review_no_reviewer", taskId: "T1", since: NOW - 31 * MIN, suggestion: "还欠对抗式，派对抗式", notify: DISPATCH });
    });
    test("说不清（规格卡提到对抗式但读不出策略）→ 同样交调度助理核对；对抗式 pass 还清了 → 照旧报「推进 merge」给 PM", () => {
      const unknown = snap({ pms: [PM, DISPATCH], team: { dispatcher: DISPATCH }, tasks: [{ ...withDispatch("regular", NOW - 31 * MIN), specPolicy: undefined }] });
      expect(auditLedger(unknown, NOW).findings.map((f) => [f.rule, f.notify, f.suggestion])).toEqual([["review_no_reviewer", DISPATCH, "按规格卡核对还欠不欠对抗式，欠就派对抗式"]]);
      const settled = snap({ pms: [PM, DISPATCH], team: { dispatcher: DISPATCH }, tasks: [{ ...withDispatch("adversarial", NOW - 31 * MIN), specPolicy: POLICY }] });
      expect(only(settled, "review_passed_idle")[0]).toMatchObject({ notify: PM, suggestion: "审查已通过，推进 merge 或等拍板" });
    });
    test("没开班子的项目不按规格卡判，照旧报「推进 merge」", () => {
      const s = snap({ pms: [PM, DISPATCH], tasks: [{ ...withDispatch("regular", NOW - 31 * MIN), specPolicy: POLICY }] });
      expect(only(s, "review_passed_idle")).toHaveLength(1);
    });
  });
  test("上一轮的 pass（进入本轮 review 之前）不算", () => {
    const old = entered("T1", "review", NOW - 25 * MIN, [], {});
    old.events.splice(1, 0, ev("T1", NOW - 90 * MIN, "review", { round: 1, verdict: "pass" }));
    expect(only(snap({ tasks: [old] }), "review_passed_idle")).toEqual([]);
    expect(only(snap({ tasks: [old] }), "review_no_reviewer")).toHaveLength(1);
  });
});

describe("build / fix 执行者空闲", () => {
  const s = (lastWriteAt: number | null, over: Partial<AuditAgent> = {}, stageAt = NOW - 60 * MIN, extra: LedgerEvent[] = []) =>
    snap({ tasks: [entered("T1", "build", stageAt, extra)], agents: [agent(PM), agent(EXE, { lastWriteAt, ...over })] });
  test("主回合空闲、会话 16 分钟没写 → 报", () => {
    const f = only(s(NOW - 16 * MIN), "executor_idle");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("16 分钟");
  });
  test("主回合在跑 → 不报", () => {
    expect(only(s(NOW - 60 * MIN, { turn: "busy" }), "executor_idle")).toEqual([]);
    expect(only(s(NOW - 60 * MIN, { turn: "compacting" }), "executor_idle")).toEqual([]);
  });
  test("画面认不出（unknown）按会话写入时间照判", () => {
    expect(only(s(NOW - 60 * MIN, { turn: "unknown" }), "executor_idle")).toHaveLength(1);
  });
  test("边界：刚好 15 分钟不报，多 1ms 报", () => {
    expect(only(s(NOW - TH.executorIdleMs), "executor_idle")).toEqual([]);
    expect(only(s(NOW - TH.executorIdleMs - 1), "executor_idle")).toHaveLength(1);
  });
  test("刚进阶段不到 15 分钟（会话更早就停写）不报", () => {
    expect(only(s(NOW - 60 * MIN, {}, NOW - 5 * MIN), "executor_idle")).toEqual([]);
  });
  test("进阶段后已交付 → 不报", () => {
    expect(only(s(NOW - 60 * MIN, {}, NOW - 60 * MIN, [ev("T1", NOW - 30 * MIN, "deliver")]), "executor_idle")).toEqual([]);
  });
  test("会话再写入后又空闲 = 新 key（会再推一次）", () => {
    const a = only(s(NOW - 20 * MIN), "executor_idle")[0].key;
    const b = only(s(NOW - 17 * MIN), "executor_idle")[0].key;
    expect(a).not.toBe(b);
  });
});

describe("交付记了、阶段没进 review", () => {
  const deliverAt = NOW - 40 * MIN;
  /** 在 stage 阶段（进入时刻 deliverAt - 5 分钟）里记了一次交付 */
  const t = (stage: Stage, extra: LedgerEvent[] = [], at = deliverAt) => entered("T1", stage, at - 5 * MIN, [ev("T1", at, "deliver"), ...extra]);
  test("build 里记了交付 40 分钟、阶段没动、没有审查结论 → 报", () => {
    expect(only(snap({ tasks: [t("build")] }), "deliver_not_in_review")).toHaveLength(1);
    expect(only(snap({ tasks: [t("fix")] }), "deliver_not_in_review")).toHaveLength(1);
  });
  test("交付之后有审查结论 → 不报", () => {
    expect(only(snap({ tasks: [t("fix", [ev("T1", NOW - 35 * MIN, "review")])] }), "deliver_not_in_review")).toEqual([]);
  });
  test("边界：交付恰好 30 分钟不报", () => {
    expect(only(snap({ tasks: [t("build", [], NOW - TH.deliverNoReviewMs)] }), "deliver_not_in_review")).toEqual([]);
  });
  /** 60 分钟前交付，35 分钟前（交付之后）被推到 stage */
  const movedAfterDeliver = (stage: Stage) => ({
    task: task("T1", stage),
    events: [ev("T1", 0, "task", { op: "new", patch: { stage: "spec" } }), ev("T1", NOW - 60 * MIN, "deliver"), ev("T1", NOW - 35 * MIN, "stage", { to: stage })],
  });
  test("交付早于进入当前阶段（上一轮的交付，已退回 fix 在修）→ 不报", () => {
    expect(only(snap({ tasks: [movedAfterDeliver("fix")] }), "deliver_not_in_review")).toEqual([]);
  });
  test("误报表：PM 跳过审查 review→merge 后停在 merge / live / verified、blocked、review、终态 → 都不报", () => {
    for (const stage of ["merge", "live", "verified", "blocked", "review", "done", "cancelled"] as Stage[]) {
      expect(only(snap({ tasks: [movedAfterDeliver(stage)] }), "deliver_not_in_review")).toEqual([]);
    }
  });
});

describe("押后队列里发给 PM 的消息", () => {
  const held = (heldAt: number, leaseAt: number | null = null, to = PM) => ({ to, from: "agent-task-t9", messageId: "m1", heldAt, leaseAt });
  test("PM 已空闲、押了 11 分钟 → 报 check_inbox", () => {
    const f = only(snap({ held: [held(NOW - 11 * MIN)] }), "pm_held");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ suggestion: "check_inbox 领回并处理", notify: PM });
  });
  test("PM 主回合在跑 → 押着是正常的，不报", () => {
    expect(only(snap({ held: [held(NOW - 60 * MIN)], agents: [agent(PM, { turn: "busy" })] }), "pm_held")).toEqual([]);
  });
  test("PM 忙闲认不出、会话文件也好久没写 → 当空闲报；3 分钟内写过 → 当在回合中不报", () => {
    expect(only(snap({ held: [held(NOW - 60 * MIN)], agents: [agent(PM, { turn: "unknown", lastWriteAt: NOW - 10 * MIN })] }), "pm_held")).toHaveLength(1);
    expect(only(snap({ held: [held(NOW - 60 * MIN)], agents: [agent(PM, { turn: "unknown", lastWriteAt: NOW - MIN })] }), "pm_held")).toEqual([]);
  });
  test("PM 忙时不报，但同一条的 key 进 keep（对账时保持打开，忙闲交替不重复推）", () => {
    const idle = only(snap({ held: [held(NOW - 60 * MIN)] }), "pm_held");
    const busy = auditLedger(snap({ held: [held(NOW - 60 * MIN)], agents: [agent(PM, { turn: "busy" })] }), NOW);
    expect(busy.findings).toEqual([]);
    expect(busy.keep).toEqual([idle[0].key]);
    expect(auditLedger(snap({ held: [held(NOW - 5 * MIN)], agents: [agent(PM, { turn: "busy" })] }), NOW).keep).toEqual([]);
  });
  test("check_inbox 领走 11 分钟还没确认 → PM 忙也报，key 与未领的不同", () => {
    const s = snap({ held: [held(NOW - 60 * MIN, NOW - 11 * MIN)], agents: [agent(PM, { turn: "busy" })] });
    const f = only(s, "pm_held");
    expect(f).toHaveLength(1);
    expect(f[0].key).toContain("lease");
  });
  test("边界：刚好 10 分钟不报；发给不在名单里的人不报", () => {
    expect(only(snap({ held: [held(NOW - TH.pmHeldMs)] }), "pm_held")).toEqual([]);
    expect(only(snap({ held: [held(NOW - 60 * MIN, null, "agent-other")] }), "pm_held")).toEqual([]);
  });
  test("推给 PM，不推调度助理", () => {
    expect(only(snap({ pms: [DISPATCH, PM], held: [held(NOW - 60 * MIN)] }), "pm_held")[0].notify).toBe(PM);
  });
});

describe("merge / live 没推进", () => {
  test("merge 31 分钟没有部署 → 报；有新部署事件就从那次算起", () => {
    expect(only(snap({ tasks: [entered("T1", "merge", NOW - 31 * MIN)] }), "ship_stalled")).toHaveLength(1);
    const deployed = entered("T1", "merge", NOW - 60 * MIN, [ev("T1", NOW - 10 * MIN, "deploy")]);
    expect(only(snap({ tasks: [deployed] }), "ship_stalled")).toEqual([]);
  });
  test("调度合并结果不明：冻结让 ship_stalled 静音，merge_unknown 照样推 PM，结清后消失", () => {
    const frozen = { tasks: [entered("T1", "merge", NOW - 60 * MIN)], queueFrozen: true, pms: [DISPATCH, PM] };
    const found = only(snap({ ...frozen, mergeUnknown: [{ intentId: "merge-1", taskId: "T1", reason: "gh timeout", since: NOW - 5 * MIN }] }), "merge_unknown");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ notify: PM, taskId: "T1", key: expect.stringContaining("merge-1") });
    expect(found[0].suggestion).toContain("scheduler-merge-resolve merge-1");
    expect(only(snap({ ...frozen, mergeUnknown: [] }), "merge_unknown")).toEqual([]);
  });
  test("部署结果不明（T68g）走同一条 merge_unknown，文案写明部署进程已不在、不挡 update", () => {
    const frozen = { tasks: [entered("T1", "merge", NOW - 60 * MIN)], queueFrozen: true, pms: [DISPATCH, PM] };
    const found = only(snap({ ...frozen, mergeUnknown: [{ intentId: "merge-1", taskId: "T1", reason: "部署：web 构建失败", since: NOW - 5 * MIN }] }), "merge_unknown");
    expect(found[0].detail).toContain("自动部署结果不明");
    expect(found[0].detail).toContain("web 构建失败");
    expect(found[0].suggestion).toContain("scheduler-merge-resolve merge-1");
  });
  test("合并队列冻结中：merge 停着不报，live 照报", () => {
    expect(only(snap({ tasks: [entered("T1", "merge", NOW - 60 * MIN)], queueFrozen: true }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [entered("T1", "live", NOW - 61 * MIN)], queueFrozen: true }), "ship_stalled")).toHaveLength(1);
  });
  test("依赖上还在等前置任务上线：merge 停着不报；前置已放行（blockedBy 空）照报；live 不看依赖", () => {
    const merge = entered("T1", "merge", NOW - 60 * MIN);
    expect(only(snap({ tasks: [{ ...merge, blockedBy: ["T0"] }] }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [{ ...merge, blockedBy: [] }] }), "ship_stalled")).toHaveLength(1);
    expect(only(snap({ tasks: [{ ...entered("T1", "live", NOW - 61 * MIN), blockedBy: ["T0"] }] }), "ship_stalled")).toHaveLength(1);
  });
  test("merge 停滞从解冻 / 依赖放行时算起；live 不看这两个", () => {
    const merge = entered("T1", "merge", NOW - 120 * MIN);
    expect(only(snap({ tasks: [merge], unfrozenAt: NOW - 10 * MIN }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [merge], unfrozenAt: NOW - 31 * MIN }), "ship_stalled")[0]?.since).toBe(NOW - 31 * MIN);
    expect(only(snap({ tasks: [{ ...merge, blockedBy: [], unblockedAt: NOW - 10 * MIN }] }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [{ ...merge, blockedBy: [], unblockedAt: NOW - 45 * MIN }] }), "ship_stalled")[0]?.since).toBe(NOW - 45 * MIN);
    const live = { ...entered("T1", "live", NOW - 120 * MIN), unblockedAt: NOW - 10 * MIN };
    expect(only(snap({ tasks: [live], unfrozenAt: NOW - 10 * MIN }), "ship_stalled")).toHaveLength(1);
  });
  test("阈值分开：merge 恰好 30 分钟不报、多 1ms 报；live 恰好 60 分钟不报、多 1ms 报（31 分钟的 live 不报）", () => {
    expect(TH.liveStallMs).toBe(60 * MIN);
    expect(only(snap({ tasks: [entered("T1", "merge", NOW - TH.mergeStallMs)] }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [entered("T1", "merge", NOW - TH.mergeStallMs - 1)] }), "ship_stalled")).toHaveLength(1);
    expect(only(snap({ tasks: [entered("T1", "live", NOW - 31 * MIN)] }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [entered("T1", "live", NOW - TH.liveStallMs)] }), "ship_stalled")).toEqual([]);
    expect(only(snap({ tasks: [entered("T1", "live", NOW - TH.liveStallMs - 1)] }), "ship_stalled")).toHaveLength(1);
  });
});

describe("执行者回收 / 孤儿 / 执行者不在 registry", () => {
  test("任务 done 超过宽限、执行者窗口还在 → 回收", () => {
    const f = only(snap({ tasks: [entered("T1", "done", NOW - 31 * MIN)] }), "reclaim_executor");
    expect(f).toHaveLength(1);
    expect(f[0].suggestion).toContain("回收");
  });
  test("窗口不在 / 宽限内 / 还有没结束的任务 → 不报", () => {
    expect(only(snap({ tasks: [entered("T1", "done", NOW - 60 * MIN)], agents: [agent(PM), agent(EXE, { windowAlive: false })] }), "reclaim_executor")).toEqual([]);
    expect(only(snap({ tasks: [entered("T1", "done", NOW - TH.reclaimGraceMs)] }), "reclaim_executor")).toEqual([]);
    const busy = snap({ tasks: [entered("T1", "done", NOW - 60 * MIN), entered("T2", "build", NOW - MIN)] });
    expect(only(busy, "reclaim_executor")).toEqual([]);
  });
  test("窗口状态未知（tmux 出错）→ 回收规则不列进 evaluated", () => {
    const r = auditLedger(snap({ tasks: [entered("T1", "done", NOW - 60 * MIN)], agents: [agent(PM), agent(EXE, { windowAlive: null })] }), NOW);
    expect(r.evaluated).not.toContain("reclaim_executor");
  });
  test("本项目的 agent-task-* 在 registry、台账没有它的任务 → 孤儿", () => {
    expect(only(snap({ agents: [agent(PM), agent("agent-task-t7")] }), "orphan_executor")).toHaveLength(1);
  });
  test("孤儿宽限：建出来不到 15 分钟 / 建出时间不明（会话文件还没有）→ 不报", () => {
    expect(only(snap({ agents: [agent(PM), agent("agent-task-t7", { startedAt: NOW - TH.orphanGraceMs })] }), "orphan_executor")).toEqual([]);
    expect(only(snap({ agents: [agent(PM), agent("agent-task-t7", { startedAt: null })] }), "orphan_executor")).toEqual([]);
    expect(only(snap({ agents: [agent(PM), agent("agent-task-t7", { startedAt: NOW - TH.orphanGraceMs - 1 })] }), "orphan_executor")).toHaveLength(1);
  });
  test("常驻 agent、别的项目的、PM 名单里的都不算孤儿", () => {
    const s = snap({ pms: [PM, "agent-task-pmx"], agents: [agent(PM), agent("agent-codex"), agent("agent-task-t8", { projectId: "q" }), agent("agent-task-pmx")] });
    expect(only(s, "orphan_executor")).toEqual([]);
  });
  test("在跑的任务的执行者不在 registry → 报；spec 阶段 / 终态 / 执行者是 PM 不报", () => {
    expect(only(snap({ tasks: [entered("T1", "build", NOW)], agents: [agent(PM)] }), "task_agent_missing")).toHaveLength(1);
    expect(only(snap({ tasks: [entered("T1", "spec", NOW)], agents: [agent(PM)] }), "task_agent_missing")).toEqual([]);
    expect(only(snap({ tasks: [entered("T1", "done", NOW)], agents: [agent(PM)] }), "task_agent_missing")).toEqual([]);
    for (const st of ["merge", "live", "verified", "blocked"] as Stage[]) {
      expect(only(snap({ tasks: [entered("T1", st, NOW)], agents: [agent(PM)] }), "task_agent_missing")).toEqual([]); // 执行者合并后被回收是正常的
    }
    for (const st of ["restate", "review", "fix"] as Stage[]) expect(only(snap({ tasks: [entered("T1", st, NOW)], agents: [agent(PM)] }), "task_agent_missing")).toHaveLength(1);
    expect(only(snap({ tasks: [entered("T1", "build", NOW, [], { agent: "agent-other-pm" })], pms: [PM, "agent-other-pm"], agents: [agent(PM)] }), "task_agent_missing")).toEqual([]);
  });
});

describe("ownerInbox 处理中太久", () => {
  const e = (ts: number | null, status = "doing") => ({ ts, text: "  把台账做成内置功能，随时更新，能看到做到哪一步  ", status, to: "T8" });
  test("doing / in_progress 超过 30 分钟 → 报，文案带 owner 原话开头", () => {
    const f = only(snap({ ownerInbox: [e(NOW - 31 * MIN), e(NOW - 40 * MIN, "in_progress")] }), "owner_inbox_stale");
    expect(f).toHaveLength(2);
    expect(f[0].detail).toContain("把台账做成内置功能");
  });
  test("done、时间缺失、恰好 30 分钟都不报", () => {
    expect(only(snap({ ownerInbox: [e(NOW - 60 * MIN, "done"), e(null), e(NOW - TH.ownerInboxDoingMs)] }), "owner_inbox_stale")).toEqual([]);
  });
  test("ledger.json 取不到（null）→ 不跑，skipped 里写明原因", () => {
    const r = auditLedger(snap({ ownerInbox: null, unavailable: { ownerInbox: "项目没有 meta.docsDir，找不到 ownerInbox" } }), NOW);
    expect(r.evaluated).not.toContain("owner_inbox_stale");
    expect(r.skipped).toEqual([{ rule: "owner_inbox_stale", reason: "项目没有 meta.docsDir，找不到 ownerInbox" }]);
  });
  test("registry 取不到 → 依赖它的规则全部进 skipped，原因一致", () => {
    const r = auditLedger(snap({ agents: null, reviewers: null, held: null, unavailable: { agents: "registry 读不了" } }), NOW);
    expect(r.skipped.map((x) => x.rule).sort()).toEqual(
      ["deliver_not_in_review", "executor_idle", "orphan_executor", "pm_held", "reclaim_executor", "review_no_reviewer", "review_passed_idle", "task_agent_missing"]);
    expect(new Set(r.skipped.map((x) => x.reason))).toEqual(new Set(["registry 读不了"]));
    expect(auditLedger(snap(), NOW).skipped).toEqual([]);
  });
});

describe("收件人与去重 key", () => {
  test("审查 / 交付类优先调度助理，其余优先 PM；名单只有一人时都给他；没有名单 = null", () => {
    expect(auditRecipient("review_no_reviewer", [PM, DISPATCH])).toBe(DISPATCH);
    expect(auditRecipient("ship_stalled", [DISPATCH, PM])).toBe(PM);
    expect(auditRecipient("ship_stalled", [DISPATCH])).toBe(DISPATCH);
    expect(auditRecipient("executor_idle", [PM])).toBe(PM);
    expect(auditRecipient("pm_held", [])).toBeNull();
    // 配了 meta.team.dispatcher 就只认它：名字带 dispatch 的 PM 不再被当成调度助理
    const disp = "agent-helper";
    expect(auditRecipient("review_no_reviewer", [DISPATCH, disp], disp)).toBe(disp);
    expect(auditRecipient("ship_stalled", [DISPATCH, disp], disp)).toBe(DISPATCH);
    expect(auditRecipient("ship_stalled", [disp, DISPATCH], null)).toBe(disp);
  });
  test("同一个状态跑两次 key 一样；时间往后走 key 不变", () => {
    const s = snap({ tasks: [entered("T1", "review", NOW - 30 * MIN)] });
    expect(auditLedger(s, NOW).findings.map((f) => f.key)).toEqual(auditLedger(s, NOW + 30 * MIN).findings.map((f) => f.key));
  });
  test("重新进 review（新一轮）→ 新 key", () => {
    const a = only(snap({ tasks: [entered("T1", "review", NOW - 30 * MIN)] }), "review_no_reviewer")[0].key;
    const b = only(snap({ tasks: [entered("T1", "review", NOW - 25 * MIN, [], { round: 2 })] }), "review_no_reviewer")[0].key;
    expect(a).not.toBe(b);
  });
  test("什么都正常 → 没有异常，所有取到数的规则都算跑过", () => {
    const r = auditLedger(snap({ tasks: [entered("T1", "build", NOW - MIN)] }), NOW);
    expect(r.findings).toEqual([]);
    expect(r.evaluated.length).toBe(13);
    expect(r.evaluated).toContain("dispatch_blocked"); // events-only rule: runs whatever sources were readable
    for (const rule of ["review_no_reviewer", "executor_idle", "ship_stalled", "merge_unknown", "review_witness_mismatch", "owner_inbox_stale"] as const) expect(r.evaluated).toContain(rule);
    expect(rules(snap({ agents: [agent(PM)] }))).toEqual([]);
    expect(rules(snap())).toEqual(["orphan_executor"]); // 默认快照里的 agent-task-t1 没有任务
  });
  test("通知文案：一条一行，带对象、建议和查看命令", () => {
    const t = auditNoticeText([{ project: "p", taskId: "T1", detail: "d1", suggestion: "派审查员" }, { project: "p", taskId: null, detail: "d2", suggestion: "s" }], "CMD");
    expect(t).toContain("新发现 2 条");
    expect(t).toContain("1. T1 · 派审查员 — d1");
    expect(t).toContain("2. p · s — d2");
    expect(t.endsWith("CMD")).toBe(true);
  });
});
