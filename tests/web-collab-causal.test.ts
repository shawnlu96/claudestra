/** 协作视图 v4 因果线画布的布局模型（web/features/collab/v4/causal-model.ts）：分组、按依赖从左往右、折叠、边状态映射 */
import { describe, expect, test } from "bun:test";
import type { LedgerDepView, LedgerTaskView, Stage } from "../web/features/collab/collab-model";
import { causalCanvas, edgeStyle, LOOSE_GROUP } from "../web/features/collab/v4/causal-model";

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
