/** i28-L5 纯函数：并行车道（文件重叠不能并行、依赖没满足要等、旧节点没 fileGlobs 不猜）与 rewrite_dag / plan_feature 的节点拼装 */
import { describe, expect, test } from "bun:test";
import { computeLanes, globsOverlap, type LaneNode } from "../src/lib/dag-tools-lanes.js";
import { composeRewrite, parseRewriteOps, parseToolNodes, planOverExisting } from "../src/lib/dag-tools-plan.js";
import type { NodePhase } from "../src/lib/ledger-dag-rules.js";
import type { DagNode } from "../src/lib/ledger-feature.js";

const n = (key: string, fileGlobs: string[] | undefined, over: Partial<LaneNode> = {}): LaneNode =>
  ({ key, deps: [], fileGlobs, taskId: null, phase: "idle", depsMet: true, satisfied: false, ...over });

describe("并行车道", () => {
  test("两个文件不重叠的节点：两条车道，都能现在开工", () => {
    const r = computeLanes([n("a", ["src/lib/a*.ts"]), n("b", ["src/bridge/b.ts"])]);
    expect(r.startNow).toEqual(["a", "b"]);
    expect(r.lanes).toEqual([["a"], ["b"]]);
    expect(r.waiting).toEqual([]);
  });

  test("文件重叠的两个节点不会被算成可并行：后一个排在前一个后面，同一条车道", () => {
    const r = computeLanes([n("a", ["src/lib/dag-*.ts"]), n("b", ["src/lib/dag-tools.ts"]), n("c", ["docs/x.md"])]);
    expect(r.startNow).toEqual(["a", "c"]);
    expect(r.waiting).toEqual([{ key: "b", why: "files", on: ["a"] }]);
    expect(r.lanes).toEqual([["a", "b"], ["c"]]);
  });

  test("和进行中的节点、图外正占着文件的卡重叠也要排队；满足了的节点不再占文件", () => {
    const nodes = [n("x", ["src/a.ts"], { taskId: "T1", phase: "active" }), n("y", ["src/a.ts"]), n("z", ["src/b.ts"]), n("w", ["src/c.ts"])];
    const r = computeLanes(nodes, [{ taskId: "T9", fileGlobs: ["src/b.ts"] }]);
    expect(r.startNow).toEqual(["w"]);
    expect(r.waiting).toEqual([{ key: "y", why: "files", on: ["x"] }, { key: "z", why: "files", on: ["T9"] }]);
    const live = computeLanes([n("x", ["src/a.ts"], { taskId: "T1", phase: "active", satisfied: true }), n("y", ["src/a.ts"])]);
    expect(live.startNow).toEqual(["y"]);
  });

  test("依赖没满足的等依赖；没写 fileGlobs 的旧节点不猜能并行", () => {
    const r = computeLanes([n("a", ["src/a.ts"], { taskId: "T1", phase: "active" }), n("b", ["src/b.ts"], { deps: ["a"], depsMet: false }), n("old", undefined)]);
    expect(r.startNow).toEqual([]);
    expect(r.waiting).toEqual([{ key: "b", why: "deps", on: ["a"] }, { key: "old", why: "no_globs", on: [] }]);
  });

  test("重叠判定和调度器同一口径：前缀包含才算重叠，不合法的资源名不算", () => {
    expect(globsOverlap(["src/lib/*"], ["src/lib/x/y.ts"])).toBe(true);
    expect(globsOverlap(["src/lib/a.ts"], ["src/lib/b.ts"])).toBe(false);
    expect(globsOverlap(["../etc"], ["../etc"])).toBe(false);
  });
});

const G = ["src/x.ts"];
const cur: DagNode[] = [
  { key: "done", taskId: "T1", oneLine: "做完了", deps: [], status: "done", estimate: "", inheritedFrom: null, fileGlobs: ["a.ts"] },
  { key: "run", taskId: "T2", oneLine: "在做", deps: ["done"], status: "build", estimate: "", inheritedFrom: null, fileGlobs: ["b.ts"] },
  { key: "plan", taskId: null, oneLine: "计划", deps: ["done"], status: "planned", estimate: "", inheritedFrom: null, fileGlobs: ["c.ts"] },
];
const phase = (x: DagNode): NodePhase => (x.key === "done" ? "done" : x.key === "run" ? "active" : "idle");

describe("节点参数", () => {
  test("缺 fileGlobs、空数组、非字符串都拒", () => {
    expect(parseToolNodes([{ key: "a", oneLine: "x" }])).toMatchObject({ ok: false, error: expect.stringContaining("fileGlobs") });
    expect(parseToolNodes([{ key: "a", oneLine: "x", fileGlobs: [] }])).toMatchObject({ ok: false });
    expect(parseToolNodes([{ key: "a", oneLine: "x", fileGlobs: [1] }])).toMatchObject({ ok: false });
    expect(parseToolNodes([{ key: "a", oneLine: "x", fileGlobs: [" "] }])).toMatchObject({ ok: false });
    expect(parseToolNodes([{ key: "a", oneLine: "x", fileGlobs: G }])).toMatchObject({ ok: true, value: [{ key: "a", deps: [], fileGlobs: G }] });
  });

  test("rewrite 没有改动、cancel 没原因都拒", () => {
    expect(parseRewriteOps({})).toMatchObject({ ok: false });
    expect(parseRewriteOps({ cancel: { run: " " } })).toMatchObject({ ok: false, error: expect.stringContaining("原因") });
    expect(parseRewriteOps({ add: [{ key: "n", oneLine: "新" }] })).toMatchObject({ ok: false, error: expect.stringContaining("fileGlobs") });
  });
});

describe("rewrite_dag 拼下一版", () => {
  const ops = (o: Record<string, unknown>) => {
    const p = parseRewriteOps(o);
    if (!p.ok) throw new Error(p.error);
    return p.value;
  };

  test("remove 删不了进行中的节点（要走 cancel 带原因），也删不了已完成的", () => {
    expect(composeRewrite(cur, ops({ remove: ["run"] }), phase)).toMatchObject({ ok: false, error: expect.stringContaining("cancel") });
    expect(composeRewrite(cur, ops({ remove: ["done"] }), phase)).toMatchObject({ ok: false });
    expect(composeRewrite(cur, ops({ cancel: { plan: "不做了" } }), phase)).toMatchObject({ ok: false, error: expect.stringContaining("remove") });
  });

  test("拆一个计划节点：remove + add，绑的卡原样带入", () => {
    const r = composeRewrite(cur, ops({ remove: ["plan"], add: [{ key: "p1", oneLine: "一半", deps: ["done"], fileGlobs: G }, { key: "p2", oneLine: "另一半", deps: ["p1"], fileGlobs: G }] }), phase);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((x) => x.key)).toEqual(["done", "run", "p1", "p2"]);
    expect(r.value.find((x) => x.key === "run")?.taskId).toBe("T2");
  });

  test("cancel 进行中的节点带原因；依赖指向被移出节点的要先 update", () => {
    expect(composeRewrite(cur, ops({ cancel: { run: "需求变了" } }), phase)).toMatchObject({ ok: true });
    const withDep = [...cur, { ...cur[2], key: "after", deps: ["run"] }];
    expect(composeRewrite(withDep, ops({ cancel: { run: "需求变了" } }), phase)).toMatchObject({ ok: false, error: expect.stringContaining("after") });
  });

  test("plan_feature 覆盖已有 DAG：同 key 沿用绑的卡；漏掉进行中的节点要走 cancel", () => {
    const next = [{ key: "done", oneLine: "做完了", deps: [], fileGlobs: ["a.ts"] }, { key: "run", oneLine: "在做", deps: ["done"], fileGlobs: ["b.ts"] }];
    const r = planOverExisting(cur, next, phase);
    expect(r).toMatchObject({ ok: true, value: [{ key: "done", taskId: "T1" }, { key: "run", taskId: "T2" }] });
    expect(planOverExisting(cur, [next[0]], phase)).toMatchObject({ ok: false, error: expect.stringContaining("run") });
  });
});
