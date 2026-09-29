/** 协作视图 v4 因果线画布的布局模型（web/features/collab/v4/causal-model.ts）：分组、按依赖从左往右、折叠、边状态映射 */
import { describe, expect, test } from "bun:test";
import type { LedgerDepView, LedgerTaskView, Stage } from "../web/features/collab/collab-model";
import { causalCanvas, COL_GAP, edgeStyle, LOOSE_GROUP, type Box, type CEdge } from "../web/features/collab/v4/causal-model";
import { initialView, labelWidth, offscreen, placeLabels, READABLE_K } from "../web/features/collab/v4/canvas-view";

function task(id: string, stage: Stage, over: Partial<LedgerTaskView> = {}): LedgerTaskView {
  return {
    id, itemId: "I1", title: `任务 ${id}`, kind: "code", stage, stageBefore: null, round: 0, agent: null, pm: "agent-pm", pr: null, spec: null, model: null,
    extra: {}, createdAt: 0, updatedAt: 0, lastEvent: null, metrics: { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 },
    ...over,
  };
}
const dep = (from: string, to: string, effective: LedgerDepView["effective"], over: Partial<LedgerDepView> = {}): LedgerDepView => ({
  from, to, kind: "blocks", when: `${from} 合并后`, state: null, derived: effective, effective, createdBy: "agent-pm", createdAt: 0, updatedAt: 0, ...over,
});
const items = [{ id: "I1", title: "事项一", oneLine: "" }, { id: "I2", title: "事项二", oneLine: "" }];
const nodeIds = (c: ReturnType<typeof causalCanvas>, g: string) => c.groups.find((x) => x.id === g)!.nodes.map((n) => n.id);

describe("分组", () => {
  test("按事项分框（大纲顺序），没归事项 / 事项不存在的进「未归事项」；完成的记 ✓ N，ops 不进画布但完成了也记", () => {
    const c = causalCanvas({
      items, deps: [],
      tasks: [task("A", "build"), task("B", "review", { itemId: "I2" }), task("C", "build", { itemId: null }), task("D", "done"), task("E", "done", { kind: "ops" }),
        task("F", "build", { kind: "ops" }), task("G", "cancelled"), task("H", "build", { itemId: "nope" })],
    });
    expect(c.groups.map((g) => [g.id, g.done])).toEqual([["I1", 2], ["I2", 0], [LOOSE_GROUP, 0]]);
    expect(nodeIds(c, "I1")).toEqual(["A"]);
    expect(nodeIds(c, LOOSE_GROUP).sort()).toEqual(["C", "H"]);
    expect(c.boxOf.has("F")).toBe(false);
    expect(c.groups[1]!.y).toBeGreaterThan(c.groups[0]!.y + c.groups[0]!.h - 1);
  });
  test("在跑的展开成大节点；没开工 / 上线 / 验证中的收成小节点", () => {
    const c = causalCanvas({ items, deps: [], tasks: [task("A", "fix"), task("B", "spec"), task("C", "live"), task("D", "verified"), task("E", "blocked", { stageBefore: "build" })] });
    const kinds = Object.fromEntries(c.groups[0]!.nodes.map((n) => [n.id, n.kind]));
    expect(kinds).toEqual({ A: "full", B: "mini", C: "mini", D: "mini", E: "full" });
    const a = c.groups[0]!.nodes.find((n) => n.id === "A")!, b = c.groups[0]!.nodes.find((n) => n.id === "B")!;
    expect(a.h).toBeGreaterThan(b.h);
  });
});

describe("按依赖从左往右", () => {
  test("列 = 沿依赖的最长路径：A→B→C、A→C 时 C 在第 3 列；框里最左一列从 0 起", () => {
    const c = causalCanvas({
      items, tasks: [task("C", "build"), task("B", "build"), task("A", "build"), task("X", "build", { itemId: "I2" })],
      deps: [dep("A", "B", "done"), dep("B", "C", "active"), dep("A", "C", "done"), dep("C", "X", "waiting")],
    });
    const g = c.groups[0]!;
    const x = (id: string) => g.nodes.find((n) => n.id === id)!.x;
    expect(x("A")).toBeLessThan(x("B"));
    expect(x("B")).toBeLessThan(x("C"));
    expect(c.groups[1]!.nodes[0]!.x).toBe(x("A")); // 跨事项的依赖不把后面的框撑出空列
  });
  test("有环不死循环", () => {
    const c = causalCanvas({ items, tasks: [task("A", "build"), task("B", "build")], deps: [dep("A", "B", "waiting"), dep("B", "A", "waiting")] });
    expect(c.groups[0]!.nodes).toHaveLength(2);
  });
});

describe("折叠", () => {
  test("被挡住、还没开工的按「挡着它的第一个」折成一组；已开工的照常画；边指向折叠组、同一对框只画一根", () => {
    const c = causalCanvas({
      items,
      tasks: [task("A", "review"), task("B", "spec", { blockedBy: ["A"] }), task("C", "restate", { blockedBy: ["A"] }), task("D", "build", { blockedBy: ["A"] }),
        task("E", "spec", { blockedBy: ["D"] })],
      deps: [dep("A", "B", "active"), dep("A", "C", "active"), dep("A", "D", "active"), dep("D", "E", "waiting")],
    });
    const g = c.groups[0]!;
    expect(g.folds.map((f) => [f.waitFor, [...f.members].sort()])).toEqual([["A", ["B", "C"]], ["D", ["E"]]]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["A", "D"]);
    expect(c.boxOf.get("B")).toBe(c.boxOf.get("C"));
    const intoFold = c.edges.filter((e) => e.to === c.boxOf.get("B"));
    expect(intoFold).toHaveLength(1);
    expect(c.edges).toHaveLength(3);
  });
});

describe("边状态映射", () => {
  test("effective：done 实线、active 流动虚线、waiting 灰点线；PM 定死的 state 优先（effective 已经合过）", () => {
    expect([edgeStyle("done"), edgeStyle("active"), edgeStyle("waiting")]).toEqual(["solid", "flow", "dotted"]);
    const c = causalCanvas({
      items, tasks: [task("A", "build"), task("B", "build"), task("C", "build")],
      deps: [dep("A", "B", "done", { state: "done", derived: "active" }), dep("B", "C", "waiting")],
    });
    expect(c.edges.map((e) => [e.id, e.style])).toEqual([["A>B", "solid"], ["B>C", "dotted"]]);
  });
  test("一端不在画布上（完成了 / ops / 取消）不画；老 bridge 没有 deps 也能画框", () => {
    const c = causalCanvas({ items, tasks: [task("A", "done"), task("B", "build")], deps: [dep("A", "B", "done")] });
    expect(c.edges).toEqual([]);
    expect(causalCanvas({ items, tasks: [task("B", "build")] }).groups).toHaveLength(1);
  });
  test("边从前一个框的右边中点连到后一个框的左边中点", () => {
    const c = causalCanvas({ items, tasks: [task("A", "build"), task("B", "build")], deps: [dep("A", "B", "active")] });
    const [a, b] = ["A", "B"].map((id) => c.groups[0]!.nodes.find((n) => n.id === id)!);
    expect(c.edges[0]).toMatchObject({ x1: a!.x + a!.w, y1: a!.y + a!.h / 2, x2: b!.x, y2: b!.y + b!.h / 2 });
  });
});

describe("边标签避让与打开时的视口（canvas-view.ts）", () => {
  const edge = (id: string, when: string, x1 = 0, y1 = 100, x2 = 300, y2 = 100): CEdge =>
    ({ id, from: "a", to: "b", style: "flow", dep: dep("a", "b", "active", { when }), x1, y1, x2, y2 });
  const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const rect = (l: { x: number; y: number; w: number; h: number }) => ({ x: l.x - l.w / 2, y: l.y - l.h / 2, w: l.w, h: l.h });

  test("中点撞在一起的标签错开，互不压、也不压节点；没条件的边不出标签", () => {
    const node = { x: 120, y: 60, w: 60, h: 20 };
    const ls = placeLabels([edge("e1", "步骤表合并后"), edge("e2", "定死 waitForIdle"), edge("e3", "")], [node]);
    expect(ls.map((l) => [l.id, l.dot])).toEqual([["e1", false], ["e2", false]]);
    expect(overlap(rect(ls[0]!), rect(ls[1]!))).toBe(false);
    for (const l of ls) expect(overlap(rect(l), node)).toBe(false);
  });
  test("实在放不下的退成一个点（悬停 / 点开看全文），先到的标签照常显示", () => {
    const ls = placeLabels(Array.from({ length: 30 }, (_, i) => edge(`e${i}`, "都过审合并", 0, 100, 120, 100)), []);
    expect(ls[0]!.dot).toBe(false);
    expect(ls.some((l) => l.dot)).toBe(true);
    const shown = ls.filter((l) => !l.dot).map(rect);
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlap(shown[i]!, shown[j]!)).toBe(false);
  });
  test("估宽：中文比英文宽，以列缝宽为上限", () => {
    expect(labelWidth("合并后")).toBeGreaterThan(labelWidth("abc"));
    expect(labelWidth("很".repeat(40))).toBe(COL_GAP - 6);
  });
  test("整张在 0.8 以上放得下就整张放；放不下用 0.8、在跑的对齐左上，视口外的件数按方向报", () => {
    const small = causalCanvas({ items, deps: [], tasks: [task("A", "build")] });
    const v0 = initialView(small, 800, 600);
    expect(v0.k).toBeGreaterThanOrEqual(READABLE_K);
    expect(offscreen(small, v0, 800, 600)).toEqual({ right: 0, down: 0, left: 0, up: 0 });
    const chain = ["A", "B", "C", "D", "E"];
    const wide = causalCanvas({
      items, tasks: [...chain.map((id, i) => task(id, i < 2 ? "build" : "live")), task("F", "spec", { blockedBy: ["E"] }), task("G", "spec", { blockedBy: ["E"] })],
      deps: chain.slice(1).map((id, i) => dep(chain[i]!, id, "waiting")).concat([dep("E", "F", "waiting"), dep("E", "G", "waiting")]),
    });
    const v1 = initialView(wide, 540, 800);
    expect(v1.k).toBe(READABLE_K);
    const a = wide.groups[0]!.nodes.find((n) => n.id === "A")!;
    expect(v1.x + a.x * v1.k).toBeGreaterThanOrEqual(0);
    // 540 宽放下前两列；第三列起出框：C、D、E 三个节点 + 折叠组按件数算的 F、G
    expect(offscreen(wide, v1, 540, 800)).toEqual({ right: 5, down: 0, left: 0, up: 0 });
  });
});
