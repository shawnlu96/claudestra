/** 概览「出问题 / 卡住」列表页的行（web/features/collab/v4/attention-list.ts）与选中透传（v4-selection.ts），team-project-UXPROB1 */
import { describe, expect, test } from "bun:test";
import { homeView, type LedgerOverview, type LedgerTaskView, type Stage } from "../web/features/collab/collab-model";
import { attentionOf } from "../web/features/collab/count-words";
import { attentionMeta, attentionRows } from "../web/features/collab/v4/attention-list";
import { narrowPane, resolveSelection } from "../web/features/collab/v4/v4-selection";

const NOW = Date.UTC(2026, 9, 14, 10, 0), MIN = 60_000;
const metrics = { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 };
function task(id: string, stage: Stage, sinceMin: number, over: Partial<LedgerTaskView> = {}): LedgerTaskView {
  return { id, itemId: "I1", title: `${id} 标题`, kind: "code", stage, stageBefore: null, round: 1, agent: `agent-dev-${id}`, pm: "agent-pm", pr: null, spec: null,
    model: null, extra: {}, createdAt: 0, updatedAt: NOW, lastEvent: null, stageSince: NOW - sinceMin * MIN, metrics, ...over };
}
const review = (text: string) => ({ round: 1, verdict: "block", p0: 1, p1: 0, p2: 0, text, ts: NOW - 5 * MIN });
/** 对照基准：在途 10 张，2 张出问题（审查不过 / CI 失败，返工都停过 2 小时），3 张卡住（40 分钟 / 1 小时 / 3 小时），1 张在等你，其余在干活或刚进等待 */
const TASKS = [
  task("T1", "fix", 130, { lastReview: review("审查不过：P0 接口没鉴权\n细节……") }),
  task("T2", "fix", 160, { lastReview: review("CI 失败：web typecheck") }),
  task("T3", "review", 40), task("T4", "merge", 60), task("T5", "restate", 180),
  task("T6", "build", 90), task("T7", "build", 10), task("T8", "review", 5), task("T9", "build", 30), task("T10", "build", 15),
  task("D1", "done", 300),
];
const ov: LedgerOverview = { exists: true, now: NOW, meta: { pms: ["agent-pm"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
  items: [{ id: "I1", title: "事项", oneLine: "一句话" }], tasks: TASKS, deps: [] };
const waits = [{ id: "ask-1", taskId: "T9", fromAgent: null, title: "接口命名二选一" }];
const tr = (s: string, p?: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p?.[k] ?? ""));

describe("attentionRows", () => {
  const hv = homeView(ov, NOW, undefined, waits);
  test("同一份 homeView：行数 = headline.problem / stuck（对照基准 2 / 3），在等你的不进", () => {
    expect(hv.headline).toMatchObject({ advancing: 10, problem: 2, stuck: 3, owner: 1 });
    expect(attentionRows(hv.lines, "problem").length).toBe(hv.headline.problem);
    expect(attentionRows(hv.lines, "stuck").length).toBe(hv.headline.stuck);
    expect(attentionRows(hv.lines, "stuck").map((r) => r.id)).not.toContain("T9");
  });
  test("按停留时长倒序（卡住：3 小时 → 1 小时 → 40 分钟），同长按 id 兜底，没有时长的排最后", () => {
    expect(attentionRows(hv.lines, "stuck").map((r) => r.id)).toEqual(["T5", "T4", "T3"]);
    expect(attentionRows(hv.lines, "problem").map((r) => r.id)).toEqual(["T2", "T1"]);
    const same = homeView({ ...ov, tasks: [task("B", "fix", 130), task("A", "fix", 130), task("C", "blocked", 0, { stageSince: null })] }, NOW).lines;
    expect(attentionRows(same, "problem").map((r) => r.id)).toEqual(["A", "B", "C"]);
  });
  test("行带卡号、标题、阶段短语、原因、停留时长（原文取 LineView，不另算）", () => {
    const [t2] = attentionRows(hv.lines, "problem");
    const line = hv.lines.find((l) => l.id === "T2")!;
    expect(t2).toEqual({ id: "T2", title: "T2 标题", stageLabel: line.stageLabel, reason: "CI 失败：web typecheck", dwellMs: 160 * MIN, dwellApprox: false });
    expect(attentionRows(hv.lines, "problem")[1]!.reason).toBe("审查不过：P0 接口没鉴权");
    expect(attentionRows(hv.lines, "stuck")[0]!.reason).toContain("超过 30 分钟");
  });
  test("带上进行中集合（count-words.ts CountSnap.active）时和右栏「现在」那句的数同口径", () => {
    const active = new Set(["T1", "T3", "T4", "T6"]);
    const a = attentionOf({ words: { working: 0, waiting: 0, notStarted: 0, done: 0 }, active, stages: [], byFeature: new Map() }, hv.lines);
    expect(attentionRows(hv.lines, "problem", active).length).toBe(a.problem);
    expect(attentionRows(hv.lines, "stuck", active).map((r) => r.id)).toEqual(["T4", "T3"]);
    expect(attentionRows(hv.lines, "stuck", null).length).toBe(3);
  });
  test("这一类清零 = 空列表（页面写「现在没有」）", () => {
    expect(attentionRows(homeView({ ...ov, tasks: [task("X", "build", 10)] }, NOW).lines, "problem")).toEqual([]);
  });
});

describe("attentionMeta", () => {
  test("阶段短语 · 原因 · 停留时长；推断的时长前面加 ≈；空段不出", () => {
    const r = { id: "X", title: "", stageLabel: "等合并", reason: "已经等了 1小时，超过 30 分钟", dwellMs: 60 * MIN, dwellApprox: false };
    expect(attentionMeta(r, tr)).toBe("等合并 · 已经等了 1小时，超过 30 分钟 · 1小时");
    expect(attentionMeta({ ...r, reason: "", dwellApprox: true }, tr)).toBe("等合并 · ≈1小时");
    expect(attentionMeta({ ...r, reason: "", dwellMs: null }, tr)).toBe("等合并");
  });
});

describe("选中", () => {
  test("resolveSelection 原样透传 attention；窄屏整屏显示它（为 D6 留口子）", () => {
    for (const which of ["problem", "stuck"] as const) {
      const sel = { kind: "attention" as const, which };
      expect(resolveSelection(sel, { deps: [] }, { groups: [] })).toEqual(sel);
      expect(narrowPane(null, sel)).toBe("attention");
      expect(narrowPane("T1", sel)).toBe("detail");
    }
  });
});
