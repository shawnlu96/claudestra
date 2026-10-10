/** 只读等待图（src/lib/ledger-deadlock.ts）：纯函数口径——边的来源、环、缺卡节点、unknown、去重稳定 */
import { describe, expect, test } from "bun:test";
import { waitAudit, waitGraph, type WaitCard, type WaitFacts, type WaitFeature, type WaitHeld } from "../src/lib/ledger-deadlock.js";
import type { LedgerDep } from "../src/lib/ledger-deps.js";
import type { Stage } from "../src/lib/ledger-stages.js";

function card(id: string, stage: Stage, globs?: unknown, mode: "auto" | "manual" | null = "auto"): WaitCard {
  return { id, kind: "code", stage, stageBefore: null, extra: globs === undefined ? {} : { fileGlobs: globs }, workflow: mode ? { mode, rev: 2 } : null };
}
/** to 等 from（task_deps 的方向：from 是前置） */
const dep = (from: string, to: string, rev = 1): LedgerDep =>
  ({ project: "p", from, to, kind: "blocks", when: "", state: null, rev, createdBy: "pm", createdAt: 10, updatedAt: 10 + rev });
const lock = (taskId: string, resource: string, intentId = `i-${taskId}`, acquiredAt = 50): WaitHeld => ({ resource, taskId, intentId, acquiredAt, scope: "card" });
const feat = (id: string, nodes: [string, string | null, string[]][], version = 1): WaitFeature =>
  ({ id, version, createdAt: 30, nodes: nodes.map(([key, taskId, deps]) => ({ key, taskId, deps })) });
function facts(over: Partial<WaitFacts>): WaitFacts {
  return { project: "p", asOfSeq: 99, tasks: [], deps: [], features: [], held: [], unknown: [], ...over };
}

/** 本次事故的形状：UPDW -依赖-> UGCFG -文件-> MQ1 -DAG-> REBOR2 -文件-> UPDW（MQ1/REBOR2 在另一个 feature） */
function incident(over: Partial<WaitFacts> = {}): WaitFacts {
  return facts({
    tasks: [
      card("UPDW", "build", ["src/lib/update-gate.ts"]),
      card("UGCFG", "spec", ["src/lib/scheduler-config.ts"]),
      card("MQ1", "build", ["src/lib/scheduler-config.ts"]),
      card("REBOR2", "fix", ["src/lib/update-*.ts"]),
    ],
    deps: [dep("UGCFG", "UPDW")],
    features: [feat("ab-mq", [["MQ1", "MQ1", ["REBOR2"]], ["REBOR2", "REBOR2", []]]), feat("ab-upd", [["UPDW", "UPDW", []]])],
    held: [lock("UPDW", "src/lib/update-gate.ts"), lock("MQ1", "src/lib/scheduler-config.ts"), lock("MQ1", "slot:p:0")],
    ...over,
  });
}

describe("等待环", () => {
  test("复合环（依赖 + 文件 + 跨 feature DAG）报出整条链，边带类型与来源", () => {
    const g = waitGraph(incident());
    expect(g.unknown).toEqual([]);
    expect(g.cycles).toHaveLength(1);
    const c = g.cycles[0];
    expect(c.nodes).toEqual(["MQ1", "REBOR2", "UPDW", "UGCFG"]);
    expect(c.edges.map((e) => [e.from, e.kind, e.to])).toEqual([
      ["MQ1", "dag", "REBOR2"], ["REBOR2", "resource", "UPDW"], ["UPDW", "dep", "UGCFG"], ["UGCFG", "resource", "MQ1"],
    ]);
    expect(c.edges[0]).toMatchObject({ feature: "ab-mq", version: 1, node: "MQ1", dep: "REBOR2" });
    expect(c.edges[1]).toMatchObject({ wanted: "src/lib/update-*.ts", held: "src/lib/update-gate.ts", intentId: "i-UPDW", workflowRev: 2 });
    expect(c.edges[2]).toMatchObject({ depKind: "blocks", rev: 1 });
    expect(c.since).toBe(50);
    const a = waitAudit(g, 1000);
    expect(a.evaluated).toEqual(["wait_cycle", "wait_missing_node"]);
    expect(a.findings).toEqual([expect.objectContaining({ rule: "wait_cycle", taskId: "MQ1", since: 50 })]);
    expect(a.findings[0].detail).toContain("REBOR2 -文件(src/lib/update-*.ts⇄src/lib/update-gate.ts intent i-UPDW wf rev2)-> UPDW");
    expect(a.findings[0].detail).toContain("as of #99");
  });

  test("纯依赖环（task_deps 与子 DAG 拼出来的）", () => {
    const g = waitGraph(facts({
      tasks: [card("A", "build"), card("B", "spec")],
      deps: [dep("B", "A")],
      features: [feat("ab-f", [["A", "A", []], ["B", "B", ["A"]]])],
    }));
    expect(g.cycles.map((c) => c.nodes)).toEqual([["A", "B"]]);
    expect(g.cycles[0].edges.map((e) => e.kind)).toEqual(["dep", "dag"]);
  });

  test("终态 / 已满足解环：环上一张卡上线（code 满足）或取消，环就没了", () => {
    for (const stage of ["live", "done", "cancelled"] as const) {
      const f = incident();
      const tasks = f.tasks.map((t) => (t.id === "REBOR2" ? { ...t, stage } : t));
      expect(waitGraph({ ...f, tasks }).cycles).toEqual([]);
    }
  });

  test("已释放的锁不留旧环；持锁行只认 scheduler_resources，不按对方声明的范围猜", () => {
    const f = incident({ held: [lock("MQ1", "src/lib/scheduler-config.ts")] });
    expect(waitGraph(f).cycles).toEqual([]);
    expect(waitGraph(f).edges.some((e) => e.kind === "resource" && e.to === "UPDW")).toBe(false);
  });

  test("文件不重叠没有资源边；通配符前缀相交才算", () => {
    const tasks = [card("W", "build", ["src/lib/a*.ts"]), card("H", "review", ["x.ts"])];
    expect(waitGraph(facts({ tasks, held: [lock("H", "src/lib/b.ts")] })).edges).toEqual([]);
    expect(waitGraph(facts({ tasks, held: [lock("H", "src/lib/ab.ts")] })).edges).toEqual([
      expect.objectContaining({ kind: "resource", from: "W", to: "H", wanted: "src/lib/a*.ts", held: "src/lib/ab.ts" }),
    ]);
    expect(waitGraph(facts({ tasks, held: [lock("H", "SRC/lib/ab.ts")] })).edges).toHaveLength(1); // 资源名按 resourceKey 规范化
  });

  test("只有容量 / 命名资源等待不构造文件死锁", () => {
    const g = waitGraph(facts({
      tasks: [card("A", "build", ["a.ts"]), card("B", "build", ["b.ts"])],
      held: [lock("A", "slot:p:0"), lock("A", "task:s1"), lock("B", "slot:p:1"), lock("B", "reviewer:x")],
      deps: [dep("B", "A")],
    }));
    expect(g.edges.map((e) => e.kind)).toEqual(["dep"]);
    expect(g.cycles).toEqual([]);
  });

  test("自己持有的文件不算等待；manual 卡与已过写阶段的卡不当文件等待者（规格例外按限制注明）", () => {
    const held = [lock("W", "a.ts"), lock("H", "a.ts")];
    expect(waitGraph(facts({ tasks: [card("W", "build", ["a.ts"]), card("H", "build", ["b.ts"])], held })).edges).toEqual([]);
    const other = [lock("H", "a.ts")];
    expect(waitGraph(facts({ tasks: [card("W", "build", ["a.ts"], "manual"), card("H", "build")], held: other })).edges).toEqual([]);
    expect(waitGraph(facts({ tasks: [card("W", "review", ["a.ts"]), card("H", "build")], held: other })).edges).toEqual([]);
    const blocked = { ...card("W", "blocked", ["a.ts"]), stageBefore: "build" as Stage };
    expect(waitGraph(facts({ tasks: [blocked, card("H", "build")], held: other })).edges).toHaveLength(1);
    expect(waitGraph(facts({})).limits.join("\n")).toContain("已审批");
  });
});

describe("等未建卡的 DAG 节点", () => {
  const dag = (a: Stage, plannedDeps: string[] = []) => facts({
    tasks: [card("A", a), card("C", "build")],
    features: [feat("ab-f", [["A", "A", ["P"]], ["P", null, plannedDeps], ["C", "C", []]])],
  });

  test("活卡等一个依赖都满足却没建卡的节点：报节点与整条链", () => {
    const g = waitGraph(dag("build"));
    expect(g.missing).toEqual([expect.objectContaining({ origin: "A", node: "ab-f#P", feature: "ab-f", nodeKey: "P", chain: ["A", "ab-f#P"] })]);
    const f = waitAudit(g, 1000).findings;
    expect(f).toEqual([expect.objectContaining({ rule: "wait_missing_node", taskId: "A", keyParts: ["ab-f#P<A"] })]);
    expect(f[0].detail).toContain("A -DAG(ab-f v1 A→P)-> ab-f#P");
  });

  test("planned 节点还没到开工条件（依赖在跑）不报；没人等的 planned 节点也不报", () => {
    expect(waitGraph(dag("build", ["C"])).missing).toEqual([]);
    expect(waitGraph(facts({ tasks: [card("C", "build")], features: [feat("ab-f", [["P", null, []], ["C", "C", []]])] })).missing).toEqual([]);
  });

  test("spec 卡只是还没开工，不当起点；blocked 卡算", () => {
    expect(waitGraph(dag("spec")).missing).toEqual([]);
    expect(waitGraph(dag("blocked")).missing).toHaveLength(1);
  });

  test("链跨过没到开工条件的 planned 节点，停在第一个能开工的缺卡节点", () => {
    const g = waitGraph(facts({
      tasks: [card("A", "build")],
      features: [feat("ab-f", [["A", "A", ["P"]], ["P", null, ["Q"]], ["Q", null, []]])],
    }));
    expect(g.missing.map((m) => [m.node, m.chain])).toEqual([["ab-f#Q", ["A", "ab-f#P", "ab-f#Q"]]]);
  });
});

describe("unknown 与稳定性", () => {
  test("坏来源进 unknown：已看到的环照报，但规则不进 evaluated（不当无环）", () => {
    const f = incident({ tasks: [...incident().tasks, card("Z", "build", ["../x"])], held: [...incident().held, lock("GHOST", "q.ts")] });
    const g = waitGraph(f);
    expect(g.unknown).toEqual([
      "Z 的 extra.fileGlobs 不是合法资源名列表",
      "文件锁 q.ts（GHOST）名字不合法或持有卡不在本项目台账",
    ]);
    expect(g.cycles).toHaveLength(1);
    const a = waitAudit(g, 1000);
    expect(a.evaluated).toEqual([]);
    expect(a.skipped.map((s) => s.rule)).toEqual(["wait_cycle", "wait_missing_node"]);
    expect(a.skipped[0].reason).toContain("等待图取数不完整");
    expect(a.findings).toHaveLength(1);
  });

  test("DAG 绑了不在台账的卡、依赖指向不存在的节点、读侧失败都是 unknown", () => {
    const g = waitGraph(facts({ unknown: ["task_deps 读不了：disk I/O"], features: [feat("ab-f", [["A", "GONE", []], ["B", null, ["NOPE"]]])] }));
    expect(g.unknown).toEqual([
      "ab-f v1 节点 A 绑的卡 GONE 不在本项目台账", "ab-f v1 节点 B 的依赖指向不存在的节点", "task_deps 读不了：disk I/O",
    ]);
    expect(waitGraph(facts({ tasks: [card("A", "build")], deps: [dep("GONE", "A")] })).unknown).toEqual(["依赖 GONE → A 的前置卡不在本项目台账"]);
  });

  test("重复扫描与输入顺序无关：同一份事实同一份输出；rev 漂移不换 key，换了持有的资源才换", () => {
    const f = incident();
    const g1 = waitGraph(f);
    const shuffled = { ...f, tasks: [...f.tasks].reverse(), held: [...f.held].reverse(), features: [...f.features].reverse() };
    expect(waitGraph(shuffled)).toEqual(g1);
    expect(waitGraph(f)).toEqual(g1);
    const drift = waitGraph({ ...f, deps: [dep("UGCFG", "UPDW", 7)] });
    expect(drift.cycles[0].key).toBe(g1.cycles[0].key);
    expect(drift.cycles[0].edges[2]).toMatchObject({ rev: 7 });
    const moved = waitGraph({ ...f, held: [lock("UPDW", "src/lib/update-x.ts"), lock("MQ1", "src/lib/scheduler-config.ts")] });
    expect(moved.cycles[0].key).not.toBe(g1.cycles[0].key);
  });

  test("有限复杂度：大环与很多小环都有上限，截断会标出来", () => {
    const n = 300;
    const ring = Array.from({ length: n }, (_, i) => `T${String(i).padStart(3, "0")}`);
    const tasks = ring.map((id) => card(id, "build"));
    const big = waitGraph(facts({ tasks, features: [feat("ab-r", ring.map((id, i) => [id, id, [ring[(i + 1) % n]]] as [string, string, string[]]))] }));
    expect(big.cycles).toHaveLength(1);
    expect(big.cycles[0].nodes).toHaveLength(n);
    expect(big.truncated).toBe(true);
    const pairs = Array.from({ length: 30 }, (_, i) => [`P${i}a`, `P${i}b`]);
    const many = waitGraph(facts({
      tasks: pairs.flat().map((id) => card(id, "build")),
      features: [feat("ab-m", pairs.flatMap(([a, b]) => [[a, a, [b]], [b, b, [a]]] as [string, string, string[]][]))],
    }));
    expect(many.cycles).toHaveLength(20);
    expect(many.truncated).toBe(true);
  });

  test("没取图 = 不跑也不列 skipped（老调用方）", () => {
    expect(waitAudit(undefined, 0)).toEqual({ findings: [], evaluated: [], skipped: [] });
  });
});
