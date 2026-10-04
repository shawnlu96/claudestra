/**
 * team-parity-B：节点 / 卡算出来的进度和中心 Feature.counts 交叉核对，对不上以中心为准并 warn；
 * 子 DAG 节点挂上执行镜像的步骤线，branch 仍是 null（head 不冒充分支）。纯数据，不碰网络。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { checkedCounts, teamDagBoard } from "@/features/collab/team-source-dag";
import { teamStepLine } from "@/features/collab/team-source-steps";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import { nodeSteps } from "@/features/collab/dag/dag-steps";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { sharedCollabSource } from "@/features/collab/team-source-shared";
import { SharedLedgerSession } from "@/lib/api/shared-ledger";

const warns: string[] = [];
const realWarn = console.warn;
beforeEach(() => { warns.length = 0; console.warn = (...a: unknown[]) => void warns.push(a.join(" ")); });
afterEach(() => { console.warn = realWarn; });

const build = (mutate?: (fx: ReturnType<typeof generateTeamFixture>) => void) => {
  const fx = generateTeamFixture();
  mutate?.(fx);
  const details = new Map(fx.details.map((d) => [d.feature.id, d]));
  const team = teamOverview(fx.list, details, fx.now);
  return { fx, details, team, board: teamDagBoard(fx.project, fx.list, details, team) };
};

test("复现测试：中心 counts 和节点一致时照节点，不 warn", () => {
  const { fx, board } = build();
  for (const f of board.features) {
    const c = fx.list.features.find((x) => x.id === f.id)!.counts;
    expect(f.counts.total).toBe(c.total);
    expect(f.counts.done).toBe(c.completed);
    expect(f.counts.done).toBe(f.nodes.filter((n) => n.phase === "done").length);
  }
  expect(warns).toEqual([]);
});

test("复现测试：子 DAG 计数和中心对不上时以中心为准并 warn；在跑 / 未开始仍照节点", () => {
  const { fx, board } = build((fx) => { fx.details[0]!.feature.counts.completed = 1; fx.details[0]!.feature.counts.missing = 2; });
  const f = board.features.find((x) => x.id === fx.details[0]!.feature.id)!;
  expect(f.counts.done).toBe(1);
  expect(f.counts.missing).toBe(2);
  expect(f.counts.active).toBe(f.nodes.filter((n) => n.phase === "active").length);
  expect(warns.length).toBe(1);
  expect(warns[0]).toContain(fx.details[0]!.feature.id);
  expect(warns[0]).toContain("以中心为准");
  // 纯函数同口径
  expect(checkedCounts(fx.details[0]!.feature, f.nodes).done).toBe(1);
});

test("复现测试：产品看板完成数对不上中心时以中心为准并 warn；在跑数来自镜像阶段，不再固定 0", () => {
  const { fx, team } = build((fx) => { fx.details[1]!.feature.counts.completed = 0; });
  const board = sharedProductBoard(fx.list, fx.now, team.ov.tasks);
  const f = board.features.find((x) => x.id === fx.details[1]!.feature.id)!;
  expect(f.counts.completed).toBe(0);
  expect(warns.some((w) => w.includes(fx.details[1]!.feature.id) && w.includes("以中心为准"))).toBe(true);
  const active = team.ov.tasks.filter((t) => t.itemId === f.id && !["done", "verified", "spec", "cancelled"].includes(t.stage)).length;
  expect(active).toBeGreaterThan(0);
  expect(f.counts.active).toBe(active);
  // 一致的 feature 不 warn
  const ok = board.features.find((x) => x.id === fx.details[0]!.feature.id)!;
  expect(ok.counts.completed).toBe(fx.details[0]!.feature.counts.completed);
  expect(warns.filter((w) => w.includes(fx.details[0]!.feature.id))).toEqual([]);
});

test("复现测试：子 DAG 节点挂上步骤线（当前步来自 steps），branch 仍是 null（不把 head 当分支）", () => {
  const { fx, board } = build();
  const d = fx.details[0]!;
  const task = d.tasks.find((t) => t.stage === "review")!;
  const node = board.features[0]!.nodes.find((n) => n.key === task.sourceTaskId)!;
  expect(node.stepLine).toEqual(teamStepLine(task.steps, "review"));
  expect(nodeSteps(node.stepLine).current).toMatchObject({ key: "review", round: 1 });
  expect(task.head).not.toBeNull();
  expect(board.features.flatMap((f) => f.nodes).every((n) => n.branch === null)).toBe(true);
  // 没开卡的计划节点没有步骤线
  const plan = board.features.flatMap((f) => f.nodes).find((n) => n.status === "planned");
  if (plan) expect(plan.stepLine).toBeNull();
});

test("复现测试：列表成功而首次 feature 详情失败（无缓存）：子 DAG / 产品看板保留中心 counts，不因读失败变 0，并明确 warn 在跑未知", async () => {
  const fx = generateTeamFixture();
  fx.list.features[0]!.counts = { total: 9, completed: 3, blocked: 0, missing: 2 };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, {
    list: async () => structuredClone(fx.list),
    detail: async () => { throw new Error("synthetic detail failure"); },
    command: async () => { throw new Error("read only"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  }), "team", "label");
  await src.overview(new AbortController().signal);
  const board = await src.dag!.board("team");
  const product = await src.product!("team");
  for (const f of fx.list.features) {
    expect(f.counts.total).toBeGreaterThan(0);
    const dag = board.features.find((x) => x.id === f.id)!;
    expect(dag.nodes).toEqual([]);
    expect(dag.counts).toMatchObject({ total: f.counts.total, done: f.counts.completed, missing: f.counts.missing, activeUnknown: true });
    const p = product.features.find((x) => x.id === f.id)!;
    expect(p.counts).toMatchObject({ total: f.counts.total, completed: f.counts.completed, blocked: f.counts.blocked, activeUnknown: true });
    expect(warns.some((w) => w.includes(f.id) && w.includes("在跑") && w.includes("未知"))).toBe(true);
  }
});
