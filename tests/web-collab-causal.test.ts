/** 协作视图 v4 因果线画布的布局模型（web/features/collab/v4/causal-model.ts）：分组、按依赖从左往右、折叠、边状态映射 */
import { describe, expect, test } from "bun:test";
import type { LedgerDepView, LedgerTaskView, Stage } from "../web/features/collab/collab-model";
import { causalCanvas, COL_GAP, edgeStyle, LOOSE_GROUP, type Box, type CEdge } from "../web/features/collab/v4/causal-model";
import { fitAllView, fitsAll, initialView, labelWidth, MIN_K, offscreen, panView, placeLabels, reanchor, reconcileView, type View, type ViewState } from "../web/features/collab/v4/canvas-view";

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
    const [g0, g1] = [c.groups[0]!, c.groups[1]!];
    expect(g1.x >= g0.x + g0.w || g1.y >= g0.y + g0.h).toBe(true); // 框按行排，彼此不重叠
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
    const g1 = c.groups[1]!;
    expect(g1.nodes[0]!.x - g1.x).toBe(x("A") - g.x); // 跨事项的依赖不把后面的框撑出空列
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
  const edge = (id: string, when: string, x1 = 0, y1 = 100, x2 = 300, y2 = 100): CEdge => {
    const d = dep("a", "b", "active", { when });
    return { id, from: "a", to: "b", style: "flow", dep: d, deps: [d], label: when, x1, y1, x2, y2 };
  };
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
  test("整张在文字下限（MIN_K）以上放得下就整张放；放不下用 MIN_K、在跑的对齐左上，视口外的件数按方向报", () => {
    const small = causalCanvas({ items, deps: [], tasks: [task("A", "build")] });
    const v0 = initialView(small, 800, 600);
    expect(v0.k).toBeGreaterThanOrEqual(MIN_K);
    expect(offscreen(small, v0, 800, 600)).toEqual({ right: 0, down: 0, left: 0, up: 0 });
    const chain = ["A", "B", "C", "D", "E"];
    const wide = causalCanvas({
      items, tasks: [...chain.map((id, i) => task(id, i < 2 ? "build" : "live")), task("F", "spec", { blockedBy: ["E"] }), task("G", "spec", { blockedBy: ["E"] })],
      deps: chain.slice(1).map((id, i) => dep(chain[i]!, id, "waiting")).concat([dep("E", "F", "waiting"), dep("E", "G", "waiting")]),
    });
    const v1 = initialView(wide, 540, 800);
    expect(v1.k).toBe(MIN_K);
    const a = wide.groups[0]!.nodes.find((n) => n.id === "A")!;
    expect(v1.x + a.x * v1.k).toBeGreaterThanOrEqual(0);
    // 540 宽放下前两列；第三列起出框：C、D、E 三个节点 + 折叠组按件数算的 F、G
    expect(offscreen(wide, v1, 540, 800)).toEqual({ right: 5, down: 0, left: 0, up: 0 });
  });
});

describe("审查修复轮（T58 P2）", () => {
  const chain = (n: number, ids = Array.from({ length: n }, (_, i) => `C${i}`)) => causalCanvas({
    items, tasks: ids.map((id) => task(id, "build")), deps: ids.slice(1).map((id, i) => dep(ids[i]!, id, "waiting")),
  });

  test("折叠边合成一根：线型取最活的，全部依赖都留着，和事件先后无关；条件不同带 +N", () => {
    const deps = [dep("X", "F", "waiting", { when: "条件乙" }), dep("X", "G", "active", { when: "条件甲" }), dep("X", "H", "done", { when: "条件丙" })];
    const tasks = [task("X", "build"), ...["F", "G", "H"].map((id) => task(id, "spec", { blockedBy: ["X"] }))];
    const a = causalCanvas({ items, tasks, deps }), b = causalCanvas({ items, tasks, deps: [...deps].reverse() });
    for (const c of [a, b]) {
      expect(c.edges).toHaveLength(1);
      expect(c.edges[0]).toMatchObject({ style: "flow", label: "条件甲 +2" });
      expect(c.edges[0]!.deps.map((d) => d.to)).toEqual(["G", "F", "H"]);
    }
    expect(a.groups[0]!.folds[0]!.id).toBe("fold:I1:X"); // 折叠组 id 只看事项和挡着它的那个，成员变了也不变
  });

  test("视口：打开时摆一次；数据刷新（新对象、尺寸也变了）不动用户拖好的位置；只有新的 Focus 才居中，同一个 seq 不重复", () => {
    const c = chain(3);
    let st: ViewState = { view: { x: 0, y: 0, k: 1 }, placed: false, centered: 0 };
    st = reconcileView(st, c, 900, 600, null);
    expect(st.placed).toBe(true);
    const dragged = { ...st, view: { ...st.view, x: -333, y: 44 } };
    expect(reconcileView(dragged, chain(5), 900, 600, null)).toBe(dragged);
    const focused = reconcileView(dragged, chain(5), 900, 600, { id: "C2", seq: 1 });
    expect(focused.view).not.toEqual(dragged.view);
    const again = { ...focused, view: { ...focused.view, x: 10 } };
    expect(reconcileView(again, chain(5), 900, 600, { id: "C2", seq: 1 })).toBe(again);
    const gone = reconcileView(again, chain(5), 900, 600, { id: "不在画布上", seq: 2 });
    expect(gone.view).toEqual(again.view);
    expect(gone.centered).toBe(2);
  });

  test("「适配全部」不低于文字下限：十列的链在 800 宽里放不下就从左上角看起，右边的由提示和拖拽补；小图照常整张放下", () => {
    const c = chain(10);
    const v = fitAllView(c, 800, 600);
    expect(v).toEqual({ x: 24, y: 24, k: MIN_K });
    expect(offscreen(c, v, 800, 600).right).toBeGreaterThan(0);
    expect(MIN_K * 12.5).toBeGreaterThanOrEqual(12); // 节点标题基准 --fs-2 = 12.5px
    expect(fitAllView(chain(2), 1200, 800).k).toBe(1);
  });
});

describe("按视口宽高重排（T67）", () => {
  const loose = (n: number, item = "I1") => Array.from({ length: n }, (_, i) => task(`${item}-${i}`, "build", { itemId: item }));
  const xs = (c: ReturnType<typeof causalCanvas>) => new Set(c.groups.flatMap((g) => g.nodes.map((n) => n.x)));
  const inside = (c: ReturnType<typeof causalCanvas>, w: number) => c.groups.every((g) => g.x + g.w <= w);

  test("8 件互不依赖不再排成一整列：宽屏拆成并排小列、框宽不超过视口；窄屏列数少一些", () => {
    const wide = causalCanvas({ items, deps: [], tasks: loose(8) }, { width: 1440, height: 900 });
    expect(xs(wide).size).toBeGreaterThan(1);
    expect(inside(wide, 1440)).toBe(true);
    const narrow = causalCanvas({ items, deps: [], tasks: loose(8) }, { width: 400, height: 900 });
    expect(xs(narrow).size).toBeLessThan(xs(wide).size);
    expect(narrow.h).toBeGreaterThan(wide.h);
  });

  test("事项框按行排：宽屏上两个小框并排，窄到放不下才换行", () => {
    const tasks = [...loose(2), ...loose(2, "I2")];
    const wide = causalCanvas({ items, deps: [], tasks }, { width: 1440, height: 900 });
    expect(wide.groups[1]!.y).toBe(wide.groups[0]!.y);
    expect(wide.groups[1]!.x).toBeGreaterThan(wide.groups[0]!.x + wide.groups[0]!.w - 1);
    const narrow = causalCanvas({ items, deps: [], tasks }, { width: 480, height: 900 });
    expect(narrow.groups[1]!.y).toBeGreaterThan(narrow.groups[0]!.y + narrow.groups[0]!.h - 1);
  });

  test("拆出来的小列都在下一深度左边，有往外连线的落在最右那条小列；宽度按 80px 分桶", () => {
    const tasks = [task("A", "build"), task("B", "build"), ...loose(9)];
    const size = { width: 1440, height: 700 };
    const c = causalCanvas({ items, deps: [dep("A", "B", "active")], tasks }, size);
    const g = c.groups[0]!, at = (id: string) => g.nodes.find((n) => n.id === id)!;
    const rank0 = g.nodes.filter((n) => n.id !== "B");
    expect(new Set(rank0.map((n) => n.x)).size).toBeGreaterThan(1);
    for (const n of rank0) expect(n.x + n.w).toBeLessThan(at("B").x);
    expect(at("A").x).toBe(Math.max(...rank0.map((n) => n.x)));
    expect(causalCanvas({ items, deps: [dep("A", "B", "active")], tasks }, { width: 1450, height: 700 })).toEqual(c);
  });
});

describe("审查修复轮（T67 r1）", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => task(`L${i}`, i % 3 ? "spec" : "build", { itemId: i % 2 ? "I1" : "I2" }));
  const ov = { items, deps: [], tasks: many(60) };
  const screen = (c: ReturnType<typeof causalCanvas>, v: View, left: number, id: string) => {
    const n = c.groups.flatMap((g) => g.nodes).find((x) => x.id === id)!;
    return [left + v.x + n.x * v.k, v.y + n.y * v.k].map((q) => Math.round(q * 1000) / 1000);
  };

  test("收起右栏（视口变宽、左边不动）：重排后正在看的节点屏幕位置不变", () => {
    const a = causalCanvas(ov, { width: 740, height: 700 }), b = causalCanvas(ov, { width: 1384, height: 700 });
    const v = { x: 24, y: -200, k: MIN_K };
    const pa = { left: 264, top: 60, w: 740, h: 700 }, pb = { ...pa, w: 1384 };
    const nv = reanchor(v, { c: a, p: pa }, b, pb, null);
    const moved = a.groups.flatMap((g) => g.nodes).filter((n) => {
      const m = b.groups.flatMap((g) => g.nodes).find((x) => x.id === n.id)!;
      return m.x !== n.x || m.y !== n.y;
    });
    expect(moved.length).toBeGreaterThan(0); // 布局确实重排了
    const near = (c: typeof a, vv: View, p: typeof pa) => c.groups.flatMap((g) => g.nodes)
      .map((n) => ({ id: n.id, d: Math.hypot(p.left + vv.x + (n.x + n.w / 2) * vv.k - (p.left + p.w / 2), vv.y + (n.y + n.h / 2) * vv.k - p.h / 2) }))
      .sort((x, y) => x.d - y.d)[0]!.id;
    const id = near(a, v, pa);
    expect(screen(b, nv, pb.left, id)).toEqual(screen(a, v, pa.left, id));
  });

  test("收起左栏（视口左边左移）：选中的任务优先钉住；原位置放不进新视口就挪进来；布局没变 = 原对象", () => {
    const a = causalCanvas(ov, { width: 1100, height: 700 }), b = causalCanvas(ov, { width: 1384, height: 700 });
    const v = { x: 24, y: 24, k: MIN_K };
    const pa = { left: 264, top: 60, w: 1100, h: 700 }, pb = { left: 28, top: 60, w: 1384, h: 700 };
    // 选中一个在视口右下部分的（不是离中心最近的那个），它应当被优先钉住
    const pick = a.groups.flatMap((g) => g.nodes).filter((n) => v.x + n.x * v.k > 600 && v.y + (n.y + n.h) * v.k < 680).at(-1)!.id;
    const nv = reanchor(v, { c: a, p: pa }, b, pb, pick);
    expect(screen(b, nv, pb.left, pick)).toEqual(screen(a, v, pa.left, pick));
    const small = { left: 264, top: 60, w: 400, h: 300 };
    const back = reanchor(nv, { c: b, p: pb }, a, small, pick);
    const [sx, sy] = screen(a, back, small.left, pick);
    expect(sx! - small.left).toBeGreaterThanOrEqual(0);
    expect(sx! - small.left).toBeLessThan(small.w);
    expect(sy).toBeGreaterThanOrEqual(0);
    expect(reanchor(v, { c: a, p: pa }, a, { ...pa }, null)).toBe(v);
  });

  test("「还有 N 件」点了往那边平移大半屏，件数变少；一路点下去到边为止，不越过画布", () => {
    const c = causalCanvas(ov, { width: 740, height: 700 });
    let v = fitAllView(c, 740, 700);
    expect(fitsAll(c, 740, 700)).toBe(false);
    const before = offscreen(c, v, 740, 700).down;
    expect(before).toBeGreaterThan(0);
    v = panView(c, v, 740, 700, "down");
    expect(offscreen(c, v, 740, 700).down).toBeLessThan(before);
    expect(offscreen(c, v, 740, 700).up).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) v = panView(c, v, 740, 700, "down");
    expect(offscreen(c, v, 740, 700).down).toBe(0);
    expect(v.y + c.h * v.k).toBeCloseTo(700 - 24, 5);
    for (let i = 0; i < 20; i++) v = panView(c, v, 740, 700, "up");
    expect(v.y).toBe(24);
    expect(fitsAll(causalCanvas({ items, deps: [], tasks: many(2) }, { width: 1200, height: 800 }), 1200, 800)).toBe(true);
  });
});
