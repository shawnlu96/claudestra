/**
 * team-project-N8B5：团队数据源的「谁在干活」由已加载的团队总览 + 团队子 DAG 转出（team-work-model.ts），不调本机 /work。
 * 夹具一张卡一个阶段：写、审、修、合并、上线、被挡、有开着的阻塞提问、done、verified、cancelled，外加未绑卡节点（就绪 / 被挡）
 * 和一张没挂在节点上的卡；断言三栏归属、每行字段、成员名对不上时显示实例代号原样。走真实的 teamOverview / teamDagBoard。
 */
import { expect, test } from "bun:test";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { machineName, teamWorkBoard } from "@/features/collab/team-work-model";
import type { TeamWorkRow } from "@/features/collab/work/work-types";
import type { FeatureDetail, FeatureList, PlanNode, TaskProjection } from "@/lib/api/shared-ledger";

const now = Date.UTC(2026, 9, 10, 4, 0);
const M_A = "inst-a", M_B = "inst-unknown";
const NAMES = new Map([[M_A, "He 的 MacBook"]]);

/** [节点, 阶段（null = 没绑卡）, 依赖, 阻塞提问开着] */
const PLAN: [string, string | null, string[], boolean?][] = [
  ["N-write", "build", []], ["N-review", "review", []], ["N-fix", "fix", []], ["N-merge", "merge", []], ["N-live", "live", []],
  ["N-blocked", "blocked", []], ["N-ask", "review", [], true], ["N-done", "done", []], ["N-verified", "verified", []],
  ["N-cancel", "cancelled", []], ["N-ready", null, ["N-done"]], ["N-wait", null, ["N-write", "N-verified"]],
];

function fixture() {
  const nodes: PlanNode[] = PLAN.map(([key, , deps]) => ({ key, oneLine: `${key} 一句话`, deps, fileGlobs: [], estimate: "2h" }));
  const task = (key: string, stage: string, ask = false, exec: string | null = M_A): TaskProjection => ({
    taskId: `t-${key}`, sourceTaskId: key, sourceRev: 1, sourceSeq: 10, stage, assigneeCode: `code-${key}`, executorInstanceId: exec,
    pr: null, head: null, deps: [], specSummary: `${key} 规格摘要`, specDigest: null, fullText: "home_only", steps: [],
    asks: ask ? [{ kind: "question", state: "open", blocking: true }, { kind: "note", state: "open", blocking: false }] : [] });
  const tasks = PLAN.filter(([, st]) => st).map(([key, st, , ask]) => task(key, st!, ask, key === "N-merge" ? M_B : M_A));
  tasks.push(task("OFF-1", "fix")); // 没挂在任何节点上的执行镜像
  const feature: FeatureList["features"][number] = { id: "f1", projectId: "p", title: "F1", description: "", rev: 1, version: 1,
    authorityMode: "planning", homeInstanceId: M_A, executorInstanceIds: [M_A], status: "active",
    counts: { total: nodes.length, completed: 2, blocked: 0, missing: 0 }, updatedBy: "pm", updatedAt: now,
    projection: { sourceInstanceId: M_A, sourceSeq: 10, observedAt: now - 60_000, receivedAt: now - 60_000 } };
  const list: FeatureList = { schemaVersion: 1, teamId: "team-a", serverSeq: 5, capabilities: {}, features: [feature] };
  const detail: FeatureDetail = { schemaVersion: 1, teamId: "team-a", serverSeq: 5, capabilities: {}, feature,
    dag: { version: 1, nodes, bindings: tasks.filter((t) => t.sourceTaskId !== "OFF-1").map((t) => ({ nodeKey: t.sourceTaskId, taskId: t.taskId })) }, tasks };
  const details = new Map([["f1", detail]]);
  const team = teamOverview(list, details, now);
  return { team, dag: teamDagBoard("p", list, details, team) };
}

const keys = (rows: readonly TeamWorkRow[]) => rows.map((r) => r.taskId ?? r.nodeKey);

test("三栏归属：在干活 = 有执行者且写 / 审 / 修 / 合并 / 上线；在等 = 被挡或开着阻塞提问；待做 = 未绑卡节点按依赖分组；收尾的不进", () => {
  const { team, dag } = fixture();
  const b = teamWorkBoard(dag, team.ov, NAMES);
  expect(keys(b.working).sort()).toEqual(["N-fix", "N-live", "N-merge", "N-review", "N-write", "OFF-1"]);
  expect(keys(b.waiting).sort()).toEqual(["N-ask", "N-blocked"]);
  expect(keys(b.todo.ready)).toEqual(["N-ready"]);
  expect(keys(b.todo.blocked)).toEqual(["N-wait"]);
  expect(b.todo.blocked[0]!.reason).toBe("被 N-write 挡住");
  const all = keys([...b.working, ...b.waiting, ...b.todo.ready, ...b.todo.blocked]);
  for (const closed of ["N-done", "N-verified", "N-cancel"]) expect(all).not.toContain(closed);
});

test("每行字段：卡号、节点一句话、阶段、执行者代号、机器（成员名；对不上显示实例代号原样）；不带计时 / 估时 / 轮次", () => {
  const { team, dag } = fixture();
  const b = teamWorkBoard(dag, team.ov, NAMES);
  const row = (k: string) => [...b.working, ...b.waiting].find((r) => r.taskId === k)!;
  expect(row("N-review")).toMatchObject({ taskId: "N-review", featureId: "f1", nodeKey: "N-review", title: "N-review 一句话", stage: "review",
    who: "code-N-review", machine: "He 的 MacBook" });
  expect(row("N-merge").machine).toBe(M_B);
  // 没挂节点的卡：标题用卡自己的，点开走任务详情（没有 nodeKey）
  expect(row("OFF-1")).toMatchObject({ featureId: null, nodeKey: null, stage: "fix", title: "OFF-1 规格摘要" });
  expect(row("N-ask").team!.blockingAsks).toBe(1);
  expect(row("N-blocked").team!.blockingAsks).toBe(0);
  for (const r of [...b.working, ...b.waiting, ...b.todo.ready, ...b.todo.blocked])
    for (const k of ["since", "round", "remainingMinutes", "overMinutes", "estimate", "normalMinutes"]) expect(k in r).toBe(false);
  expect(b.machines).toEqual({ "He 的 MacBook": 5, [M_B]: 1 });
  expect(b.mirror).toEqual(team.ov.mirror!);
  // 未绑卡节点：没有执行者 / 机器 / 镜像事实
  expect(b.todo.ready[0]).toMatchObject({ taskId: null, who: null, machine: null, stage: null, team: null, title: "N-ready 一句话" });
});

test("执行者：没有代号也没有执行实例的不算在干活；成员名空白 / 缺失时不猜", () => {
  const { team, dag } = fixture();
  const ov = { ...team.ov, tasks: team.ov.tasks.map((t) => (t.id === "N-write" ? { ...t, team: { ...t.team!, assigneeCode: null, executorInstanceId: null } } : t)) };
  expect(keys(teamWorkBoard(dag, ov, NAMES).working)).not.toContain("N-write");
  expect(machineName(M_A, new Map([[M_A, "  "]]))).toBe(M_A);
  expect(machineName(M_A, new Map())).toBe(M_A);
  expect(machineName(null, NAMES)).toBeNull();
});

test("子 DAG 没读到：在干活 / 在等照样从总览出，待做为空（不凭空造节点）", () => {
  const { team } = fixture();
  const b = teamWorkBoard(null, team.ov, NAMES);
  expect(b.working.length).toBe(6);
  expect(b.todo).toEqual({ ready: [], blocked: [] });
  expect(b.working.find((r) => r.taskId === "N-write")).toMatchObject({ nodeKey: null, title: "N-write 一句话" });
});
