/** 进度图的行与两张图互跳（web/features/collab/dag/dag-progress.ts）：三处合并、PM 在前、节点负责人 = 行、跳转落点与 MAX_OPEN */
import { describe, expect, test } from "bun:test";
import { defaultOpen, MAX_OPEN, nodeId } from "../web/features/collab/dag/dag-layout";
import { jumpToNode, ownerOf, progressRows, rowOf } from "../web/features/collab/dag/dag-progress";
import { feature, node, rowsFor } from "./web-collab-dag-fixture";

const f1 = feature("f1", [node("A", "active"), node("B", "done"), node("C", "idle", ["A"])]);
const f2 = feature("f2", [node("D", "active", [], { handler: { role: "reviewer", agent: null, since: 2000 } })]);
// D 的 handler.agent 为空：L4 用 stepAtStage 补出执行者，放进那个人的行
const rows = [...rowsFor([f1]), { agent: "pm2", pm: true, work: [], offGraph: [] },
  {
    agent: "exec-D", pm: false,
    work: [{ featureId: "f2", nodeKey: "D", taskId: "T-D", role: "reviewer", step: "review", round: 2, since: 2000 }],
    offGraph: [{ taskId: "T9", stage: "build", role: "executor", since: 1 }],
  }];
const agents = [
  { name: "exec-A", projectId: "p", status: "active", busy: true },
  { name: "lazy", projectId: "p", status: "active", busy: false },
  { name: "other", projectId: "q", status: "active", busy: true },
  { name: "pm", projectId: "p", status: "stopped" },
];

describe("progressRows", () => {
  const out = progressRows(rows, agents, "p");
  test("PM 永远在前（每个 PM 一行，work 可以为空），其余按快照顺序，本项目没活的成员是空闲行", () => {
    expect(out.map((r) => r.agent)).toEqual(["pm", "pm2", "exec-A", "exec-D", "lazy"]);
    expect(out.filter((r) => r.pm).map((r) => r.agent)).toEqual(["pm", "pm2"]);
    expect(out.find((r) => r.agent === "lazy")!.work).toEqual([]);
    expect(out.some((r) => r.agent === "other")).toBe(false);
  });
  test("行首状态点按 /agents 的 busy；查不到的是 unknown", () => {
    const st = Object.fromEntries(out.map((r) => [r.agent, r.state]));
    expect(st).toMatchObject({ "exec-A": "busy", lazy: "idle", pm: "stopped", "exec-D": "unknown", pm2: "unknown" });
  });
  test("agent- 前缀写法不一的同名行并成一行", () => {
    const merged = progressRows([{ agent: "agent-x", pm: false, work: [], offGraph: [] }, { agent: "x", pm: true, work: [], offGraph: [] }], [], "p");
    expect(merged).toEqual([{ agent: "x", pm: true, member: false, state: "unknown", work: [], offGraph: [] }]);
  });
});

describe("两张图对得上", () => {
  const out = progressRows(rows, agents, "p");
  test("节点负责人从行里认；handler.agent 为空时也落到同一行", () => {
    expect(ownerOf(out, "f1", f1.nodes[0]!)).toEqual({ agent: "exec-A", role: "executor" });
    expect(ownerOf(out, "f2", f2.nodes[0]!)).toEqual({ agent: "exec-D", role: "reviewer" });
    expect(ownerOf(out, "f1", f1.nodes[2]!)).toBeNull();
  });
  test("每个进行中节点的负责人都有行，行里的每项活都能在节点上找到同一个人", () => {
    for (const f of [f1, f2]) for (const n of f.nodes.filter((x) => x.phase === "active")) expect(rowOf(out, ownerOf(out, f.id, n)!.agent)).not.toBeNull();
    for (const r of out) for (const w of r.work) {
      const f = [f1, f2].find((x) => x.id === w.featureId)!;
      expect(ownerOf(out, f.id, f.nodes.find((n) => n.key === w.nodeKey)!)!.agent).toBe(r.agent);
    }
  });
});

describe("jumpToNode：进度 → DAG", () => {
  const many = Array.from({ length: 10 }, (_, i) => feature(`f${i}`, [node("A", "active"), node("Z", "done")], { lastActivityAt: 100 + i }));
  test("feature 已展开：不动展开集合，落到那个节点", () => {
    const open = defaultOpen(many);
    expect(jumpToNode(many, open, open[0]!, "A")).toEqual({ open, evicted: null, expandDone: false, id: nodeId(open[0]!, "A") });
  });
  test("没展开就先展开，守住 MAX_OPEN（挤掉最久没动静的）", () => {
    const open = defaultOpen(many);
    const closed = many.map((f) => f.id).find((id) => !open.includes(id))!;
    const j = jumpToNode(many, open, closed, "A")!;
    expect(j.open).toContain(closed);
    expect(j.open).toHaveLength(MAX_OPEN);
    expect(j.evicted).not.toBeNull();
  });
  test("跳到 done 节点要点开 ✓N；节点 / feature 不在快照里 = null", () => {
    expect(jumpToNode(many, [], "f1", "Z")!.expandDone).toBe(true);
    expect(jumpToNode(many, [], "f1", "nope")).toBeNull();
    expect(jumpToNode(many, [], "nope", "A")).toBeNull();
  });
});
