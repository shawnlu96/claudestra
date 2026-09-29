/**
 * 协作视图详情面板纯逻辑（web/features/collab/collab-detail-model.ts）：阶段用时条、最近 3 件事、审查摘要、参与者。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actorName, eventLine, fmtEventTime, latestChecklist, participants, recentThree, reviewRows, SOURCE_TEXT, stageSegments } from "../web/features/collab/collab-detail-model";
import { COLLAB_DICT } from "../web/lib/i18n-dict-collab";
import { INCOMPLETE_TEXT } from "../src/lib/ledger-probes";
import type { LedgerEventView, LedgerTaskView } from "../web/features/collab/collab-model";
import { fillParams } from "../web/lib/i18n-fill";

const MIN = 60_000;
let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}, text = "", actor = "agent-pm"): LedgerEventView => ({ seq: ++seq, ts: seq * MIN, actor, target: "T5", kind, text, data });

const task = { id: "T5", stage: "fix", stageBefore: null, agent: "agent-task-t5", pm: "agent-claudestra" } as unknown as LedgerTaskView;

describe("阶段用时条", () => {
  test("7 段与首页列对齐：审查与返工合在一段、同阶段多次进入累加；当前段之前为 past", () => {
    const timeline = [
      { stage: "spec", from: 0, to: 4 * MIN },
      { stage: "restate", from: 4 * MIN, to: 7 * MIN },
      { stage: "build", from: 7 * MIN, to: 82 * MIN },
      { stage: "review", from: 82 * MIN, to: 95 * MIN },
      { stage: "fix", from: 95 * MIN, to: 98 * MIN },
    ] as const;
    const segs = stageSegments({ task, timeline: [...timeline] });
    expect(segs.map((s) => [s.label, s.ms / MIN, s.state])).toEqual([
      ["规格", 4, "past"], ["复述", 3, "past"], ["开发", 75, "past"], ["审查", 16, "current"], ["合并", 0, "future"], ["上线", 0, "future"], ["验证", 0, "future"],
    ]);
  });
});

describe("最近 3 件事", () => {
  test("新的在上；建任务 / 改字段 / 空 note 不算；各类事件的一句话", () => {
    const events = [
      ev("task", { op: "new" }),
      ev("deliver", { headSHA: "0b7b79c1234" }, "", "agent-task-t5"),
      ev("review", { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 1, reviewer: "claude-reviewer" }, "全量重拉后位置没恢复\n细节"),
      ev("note", {}, ""),
      ev("stage", { from: "review", to: "fix" }),
      ev("task", { op: "set" }),
    ];
    expect(recentThree(events).map((r) => r.text)).toEqual([
      "pm 退回返工",
      "审查 · 第 1 轮：要改 · P0 0 · P1 2 · P2 1：全量重拉后位置没恢复",
      "task-t5 交付 · 0b7b79c",
    ]);
  });

  test("导入的近似时间标出来；拍板不写记录人；导入的事件不写操作者", () => {
    expect(recentThree([ev("decision", { approxTime: true }, "先按这个来", "agent-pm")])[0]).toMatchObject({ text: "拍板：先按这个来", approx: true });
    expect(actorName("owner")).toBe("你");
    expect(eventLine(ev("stage", { from: "spec", to: "restate" }, "", "import"))).toBe("推到「复述」");
    expect(eventLine(ev("note", {}, "老台账的一条日志", "import"))).toBe("老台账的一条日志");
    expect(eventLine(ev("stage", { from: "build", to: "review" }))).toBe("pm 推到「审查」");
    expect(eventLine(ev("verify", { result: "fail" }, "白屏"))).toBe("线上验证失败：白屏");
    expect(eventLine(ev("meta"))).toBeNull();
  });
});

describe("审查与参与者", () => {
  const events = [
    ev("review", { round: 1, verdict: "changes", p0: 0, p1: 3, p2: 7, reviewer: "claude-reviewer" }, "意见"),
    ev("review", { round: 2, verdict: "pass", p0: 0, p1: 0, p2: 1, reviewer: "claude-reviewer" }),
    ev("review", { round: 2, verdict: "pass", p0: null, reviewer: "codex" }),
  ];

  test("reviewRows：P 计数解析不出为 null", () => {
    expect(reviewRows(events).map((r) => [r.round, r.verdict, r.p0, r.p1, r.reviewer])).toEqual([
      [1, "changes", 0, 3, "claude-reviewer"],
      [2, "pass", 0, 0, "claude-reviewer"],
      [2, "pass", null, null, "codex"],
    ]);
  });

  test("执行者、PM、审查员按人去重并记轮次", () => {
    expect(participants({ task, events })).toEqual([
      { name: "task-t5", role: "executor" },
      { name: "claudestra", role: "pm" },
      { name: "claude-reviewer", role: "reviewer", rounds: [1, 2] },
      { name: "codex", role: "reviewer", rounds: [2] },
    ]);
  });

  test("跨实例委托：执行者是 extra.delegate", () => {
    const delegated = { ...task, agent: null, extra: { delegate: "claudestra@Shawn" } };
    expect(participants({ task: delegated, events: [] })[0]).toEqual({ name: "claudestra@Shawn", role: "executor" });
  });
});

describe("英文界面的标点", () => {
  test("拼句用的冒号走 tr：中文全角，英文半角", () => {
    const en = (x: string, p?: Record<string, string | number>) => fillParams(({ "：": ": ", "{who} 回滚": "{who} rolled back" } as Record<string, string>)[x] ?? x, p);
    expect(eventLine(ev("rollback", {}, "白屏", "agent-pm"), en)).toBe("pm rolled back: 白屏");
    expect(eventLine(ev("rollback", {}, "白屏", "agent-pm"))).toBe("pm 回滚：白屏");
  });
});

describe("事件时刻", () => {
  test("今天 / 昨天 / MM-DD，跨年也只写月日（同值守卡片）", () => {
    const now = new Date(2026, 8, 28, 9, 5).getTime();
    expect(fmtEventTime(new Date(2026, 8, 28, 0, 1).getTime(), now)).toBe("今天 00:01");
    expect(fmtEventTime(new Date(2026, 8, 27, 23, 59).getTime(), now)).toBe("昨天 23:59");
    expect(fmtEventTime(new Date(2026, 8, 26, 17, 30).getTime(), now)).toBe("09-26 17:30");
    const jan1 = new Date(2027, 0, 1, 8, 0).getTime();
    expect(fmtEventTime(new Date(2026, 11, 31, 22, 0).getTime(), jan1)).toBe("昨天 22:00");
    expect(fmtEventTime(new Date(2026, 11, 30, 22, 0).getTime(), jan1)).toBe("12-30 22:00");
  });
});

describe("完成检查单", () => {
  test("取最近一次系统核对的 verify；老的手填 verify（没有 checks）不算；豁免、模板、未知 id、坏状态都兜住", () => {
    expect(latestChecklist([ev("verify", { result: "pass", evidence: null })])).toBeNull();
    const checks = [
      { id: "pr-merged", status: "pass", detail: "已合并", tpl: "PR {pr} 状态是 {state}，还没合并", params: { pr: "#1", state: "OPEN", bad: { x: 1 } } },
      { id: "web-relay", status: "unknown", detail: "拿不到", waived: "中继维护" },
      { id: "daemon-bridge", status: "fail", detail: "还没重启" },
      { id: "new-probe", status: "weird" },
    ];
    const old = ev("verify", { result: "fail", checks: [{ id: "pr-merged", status: "fail" }] });
    const c = latestChecklist([old, ev("verify", { result: "fail", checks, checklistSource: "files+extra", incomplete: false }, "", "owner"), ev("note", {}, "别的")]);
    expect(c).toMatchObject({ result: "fail", actor: "owner", waived: 1, source: "files+extra", incomplete: false, note: null });
    expect(c!.rows).toEqual([
      { id: "pr-merged", label: "PR 已合并", status: "pass", detail: "已合并", tpl: "PR {pr} 状态是 {state}，还没合并", params: { pr: "#1", state: "OPEN" }, waived: null },
      { id: "web-relay", label: "中继网页已部署", status: "unknown", detail: "拿不到", tpl: null, params: {}, waived: "中继维护" },
      { id: "daemon-bridge", label: "bridge 已重启", status: "fail", detail: "还没重启", tpl: null, params: {}, waived: null },
      { id: "new-probe", label: "new-probe", status: "unknown", detail: "", tpl: null, params: {}, waived: null },
    ]);
    expect(latestChecklist([ev("verify", { result: "unknown", checks: [], checklistSource: "bogus", incomplete: true, note: "只核证据" })])).toMatchObject({
      source: null, incomplete: true, incompleteText: "拿不到 PR 的文件列表，推断不出检查单", note: { text: "只核证据", tpl: null, params: {} },
    });
    const owned = latestChecklist([ev("verify", {
      result: "unknown", checks: [], incomplete: true, incompleteReason: "ownership",
      note: "项目 p 的目录里没有本仓库", noteTpl: "项目 {project} 的目录里没有本仓库，只核证据文件（--evidence）", noteParams: { project: "p" },
    })]);
    expect(owned).toMatchObject({ incompleteText: expect.stringContaining("判断不了"), note: { tpl: expect.stringContaining("{project}"), params: { project: "p" } } });
  });
  test("verify 事件一句话：pass / fail / unknown 三种", () => {
    expect(eventLine(ev("verify", { result: "pass" }))).toBe("线上验证通过");
    expect(eventLine(ev("verify", { result: "unknown" }))).toBe("线上验证查不到结果");
  });
  test("探针说明与 note 模板（ledger-probes.ts / ledger-verify.ts 的中文字面量）在英文词表里都有译文，占位符一致", () => {
    const strip = (f: string) => readFileSync(join(import.meta.dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const probes = strip("../src/lib/ledger-probes.ts");
    const verifyTpls = [...strip("../src/manager/ledger-verify.ts").matchAll(/tpl: "([^"\n]+)"/g)].map((m) => m[1]);
    const lits = [...new Set([...probes.matchAll(/"([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g)].map((m) => m[1]))];
    // 「没采集」是参数值；INCOMPLETE_TEXT 只进 CLI 报错（网页用自己的短句，见 collab-detail-model 的 INCOMPLETE_TEXT）
    const tpls = [...lits.filter((l) => l !== "没采集" && !Object.values(INCOMPLETE_TEXT).includes(l)), ...verifyTpls];
    expect(verifyTpls.length).toBe(11);
    expect(tpls.length).toBeGreaterThan(30);
    const holes = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const t of tpls) {
      expect(COLLAB_DICT[t], t).toBeString();
      expect(holes(COLLAB_DICT[t]), t).toEqual(holes(t));
    }
    for (const k of Object.values(SOURCE_TEXT)) expect(COLLAB_DICT[k], k).toBeString();
    for (const k of ["拿不到 PR 的文件列表，推断不出检查单", "判断不了任务所属项目是不是本仓库，不知道该核什么"]) expect(COLLAB_DICT[k], k).toBeString();
  });
});
