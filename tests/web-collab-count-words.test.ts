/**
 * UXNUM1 [验收线 1]：同一份看板 + 总览，顶栏、大纲芯片、右栏「现在」与「各阶段」、产品卡（按 feature）、子 DAG 框头六处的
 * 在干活 / 在等 / 没开工 / 已完成一致；各阶段之和 = 在干活 + 在等；规格卡不进进行中；合并卡在「在等」。
 * 团队看板走真的 teamWorkBoard（UXWHO1 四栏），本机看板走 /work 形状经 localColumns。纯函数，不挂 React。
 */
import { describe, expect, test } from "bun:test";
import { attentionOf, countBoardOf, countSnap, doneCount, featureWords, missingFeatures, quotaPcts } from "../web/features/collab/count-words";
import { homeView } from "../web/features/collab/collab-model";
import { teamWorkBoard } from "../web/features/collab/team-work-model";
import { filterCount, outlineOf, stageCounts } from "../web/features/collab/v4/v4-model";

import type { WorkBoard, WorkRow } from "../web/features/collab/work/work-types";
import type { QuotaLinesView } from "../web/features/lend/lend-quota-model";
import { FEATURES, NOW, synthTeam } from "./web-collab-count-words-fixture.test";

/** 六处各自读到的数（调用的就是界面用的那几个函数） */
function sixPlaces(snap: ReturnType<typeof countSnap>, ov: Parameters<typeof filterCount>[0] & { items: { id: string; title: string; oneLine: string }[] }) {
  const sum = (k: "working" | "waiting" | "notStarted") => FEATURES.reduce((s, f) => s + featureWords(snap, f)[k], 0);
  return {
    top: { working: snap.words.working, waiting: snap.words.waiting, notStarted: snap.words.notStarted, done: snap.words.done },
    chips: { active: filterCount(ov, "active", snap), listed: outlineOf({ ...ov, tasks: ov.tasks }, "active", snap.active).flatMap((g) => g.tasks).length,
      done: filterCount(ov, "done", snap) },
    now: { working: snap.words.working, waiting: snap.words.waiting, stages: stageCounts(snap).reduce((s, c) => s + c.n, 0) },
    product: { working: sum("working"), waiting: sum("waiting") },
    frame: { working: sum("working"), waiting: sum("waiting"), notStarted: sum("notStarted") },
  };
}

describe("团队合成数据（12 feature）", () => {
  const { ov, dag } = synthTeam();
  const board = countBoardOf(teamWorkBoard(dag, ov, NOW), true);
  const snap = countSnap(board, ov);

  test("在干活 8、在等 6（合并 4 + 受阻 2）、没开工 12 个节点、已完成 20；规格 30 张不进进行中", () => {
    expect(snap.words).toEqual({ working: 8, waiting: 6, notStarted: 12, done: 20 });
    const specIds = ov.tasks.filter((t) => t.stage === "spec").map((t) => t.id);
    expect(specIds.length).toBe(30);
    expect(specIds.filter((id) => snap.active.has(id))).toEqual([]);
    const merge = ov.tasks.filter((t) => t.stage === "merge").map((t) => t.id);
    expect(merge.every((id) => board.merging.some((r) => r.taskId === id))).toBe(true);
  });

  test("六处同一组数；各阶段之和 = 在干活 + 在等；按 feature 加起来等于全站", () => {
    const p = sixPlaces(snap, ov);
    const ww = p.top.working + p.top.waiting;
    expect(p.chips).toEqual({ active: ww, listed: ww, done: p.top.done });
    expect(p.now).toEqual({ working: p.top.working, waiting: p.top.waiting, stages: ww });
    expect(p.product).toEqual({ working: p.top.working, waiting: p.top.waiting });
    expect(p.frame).toEqual({ working: p.top.working, waiting: p.top.waiting, notStarted: p.top.notStarted });
    expect(stageCounts(snap).map((c) => c.label)).not.toContain("规格");
  });

  test("出问题 / 卡住只是标注：只数进行中的线，不另成一类", () => {
    const lines = homeView(ov, NOW).lines;
    const a = attentionOf(snap, lines);
    expect(a.problem + a.stuck).toBeLessThanOrEqual(snap.words.working + snap.words.waiting);
    expect(attentionOf(snap, [{ id: "T1", attention: "problem" }, { id: "T31", attention: "problem" }, { id: "T43", attention: "stuck" }])).toEqual({ problem: 1, stuck: 1 });
  });

  test("没读到详情的 feature 数：列表对比已有详情；不是团队源 = 0；列表还没读到 = null", () => {
    const list = { features: FEATURES.map((id) => ({ id })) };
    const details = new Map(FEATURES.slice(0, 9).map((id) => [id, {}]));
    expect(missingFeatures({ last: () => ({ list, details }) })).toBe(3);
    expect(missingFeatures({ last: () => null })).toBeNull();
    expect(missingFeatures({})).toBe(0);
  });
});

describe("本机 /work 看板", () => {
  const row = (taskId: string | null, over: Partial<WorkRow> = {}): WorkRow => ({ taskId, featureId: "F01", nodeKey: taskId ?? "n", title: "", who: "dev", machine: "local",
    step: "write", round: 1, since: 0, normalMinutes: 0, remainingMinutes: 0, overMinutes: 0, reason: null, code: null, estimate: "", ...over });
  const work: WorkBoard = { now: NOW, asOfSeq: 1, machines: { local: 2 }, completionHours: 3, availableSlots: 1,
    working: [row("A"), row("B", { step: "merge" })], waiting: [row("C", { step: "merge", code: "ci", reason: "等 CI" }), row("D", { step: "review", reason: "等 owner" })],
    todo: { ready: [row(null)], blocked: [row(null, { nodeKey: "m" }), row(null, { nodeKey: "k", featureId: "F02" })] }, legacy: [{ taskId: "OLD", title: "", stage: "build" }] };
  const ov = { tasks: (["A", "B", "C", "D"] as const).map((id, i) => ({ id, title: id, kind: "code", stage: (["build", "merge", "merge", "review"] as const)[i]!,
    round: 0, updatedAt: 0, metrics: {} })), items: [] };
  const snap = countSnap(countBoardOf(work, false), ov);

  test("合并步骤 / CI 等待进「在等」；老卡不进四类；待做按节点", () => {
    expect(snap.words).toEqual({ working: 1, waiting: 3, notStarted: 3, done: 0 });
    expect([...snap.active].sort()).toEqual(["A", "B", "C", "D"]);
    expect(snap.active.has("OLD")).toBe(false);
    expect(featureWords(snap, "F01")).toEqual({ working: 1, waiting: 3, notStarted: 2 });
    expect(featureWords(snap, "F02")).toEqual({ working: 0, waiting: 0, notStarted: 1 });
    expect(stageCounts(snap)).toEqual([{ label: "开发", n: 1 }, { label: "审查 ⇄ 返工", n: 1 }, { label: "合并", n: 2 }]);
  });

  test("各阶段按看板有效步骤归列：总览还是规格、看板已在复述的行进「复述」列；团队规格卡有阻塞提问进在等也一样，不出规格列", () => {
    const restating: WorkBoard = { ...work, working: [row("S", { step: "restate" })], waiting: [], todo: { ready: [], blocked: [] } };
    const spec = { tasks: [{ ...ov.tasks[0]!, id: "S", stage: "spec" as const }], items: [] };
    const local = countSnap(countBoardOf(restating, false), spec);
    expect(stageCounts(local)).toEqual([{ label: "复述", n: 1 }]);
    const teamRow = { taskId: "S", featureId: "F01", nodeKey: "s", title: "", who: null, instance: null, machine: null, stage: "spec" as const, reason: "等 owner", team: null };
    const team = countSnap({ working: [], merging: [], waiting: [teamRow], todo: { ready: [], blocked: [] } }, spec);
    expect(stageCounts(team)).toEqual([{ label: "复述", n: 1 }]);
    expect(team.stages.reduce((n, c) => n + c.n, 0)).toBe(team.words.working + team.words.waiting);
  });

  test("已完成含窗口外的 doneRest", () => {
    const doneRest = { n: 4, byItem: {}, groups: [{ stage: "done" as const, kind: "code", blocked: false, p0: false, n: 4, reviewRounds: 0, p0p1: 0 }] };
    expect(doneCount({ tasks: [{ ...ov.tasks[0]!, stage: "verified" }], doneRest })).toBe(5);
  });
});

describe("周额度", () => {
  const fam = (family: "claude" | "codex", weekUsedPct: number | null) => ({ family, weekUsedPct }) as QuotaLinesView["families"][number];
  const view = (families: QuotaLinesView["families"]) => ({ families }) as QuotaLinesView;
  test("按族写百分比，某族为空就略去；全空 / 403·404（null）= 整格不出", () => {
    expect(quotaPcts(view([fam("claude", 75), fam("codex", null)]))).toEqual([{ family: "Claude", pct: 75 }]);
    expect(quotaPcts(view([fam("claude", 75), fam("codex", 40)]))).toEqual([{ family: "Claude", pct: 75 }, { family: "Codex", pct: 40 }]);
    expect(quotaPcts(view([fam("claude", null)]))).toBeNull();
    expect(quotaPcts(null)).toBeNull();
  });
});
