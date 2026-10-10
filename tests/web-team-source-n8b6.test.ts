/**
 * team-project-N8B6：团队子 DAG 三处对齐台账——已取消算完成、开了工的卡不标「未派」、阶段那一步的最后一行已结束就不显示旧轮次。
 * 合成夹具 n8b6Fixture() 同时给团队（中心 list / detail）和本机（DagBoard，节点带执行人和真实步骤行）两份，截图测试
 * tests/web-team-source-n8b6-browser.test.ts 也用它。节点卡在子进程里 SSR（同 web-team-work-model.test.ts），免得 React / CSS 漏进根测试。
 */
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { teamStepLine } from "@/features/collab/team-source-steps";
import { stepLineView } from "@/features/collab/collab-step-line-model";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import type { BoardNode, DagBoard } from "@/features/collab/dag/dag-types";
import type { LedgerOverview } from "@/features/collab/collab-model";
import type { FeatureDetail, FeatureList, PlanNode, TaskProjection } from "@/lib/api/shared-ledger";
import { testChildEnv } from "./test-env";

export const N8B6_NOW = Date.UTC(2026, 9, 11, 4, 0);
const HOME = "inst-home";
type Steps = [string, string][];
const DONE_1: Steps = [["write:1", "done"], ["review:1", "done"]];
/** [节点, 阶段（null = 没绑卡）, 依赖, 步骤行]：X12 已取消、Y1 只依赖它；S2D2C 修第 1 轮已派；T44 最后一行是已交付的 fix:2；R5 审第 5 轮已派 */
const PLAN: [string, string | null, string[], Steps][] = [
  ["D1", "done", [], [...DONE_1, ["merge:1", "done"], ["verify:1", "done"]]],
  ["X12", "cancelled", [], [["write:1", "delivered"]]],
  ["Y1", null, ["X12"], []],
  ["S2D2C", "fix", ["D1"], [...DONE_1, ["fix:1", "assigned"]]],
  ["T44", "fix", ["D1"], [...DONE_1, ["fix:1", "delivered"], ["review:2", "done"], ["fix:2", "delivered"]]],
  ["R5", "review", ["D1"], [...DONE_1, ["fix:1", "done"], ["review:2", "done"], ["fix:2", "done"], ["review:3", "done"], ["fix:3", "done"],
    ["review:4", "done"], ["fix:4", "done"], ["review:5", "assigned"]]],
];
/** 本机那份：开了工的节点有执行人 */
const AGENT: Record<string, string> = { S2D2C: "agent-dev-1", T44: "agent-dev-2", R5: "agent-rv-1" };

export function n8b6Fixture() {
  const project = "claude-orchestrator", team = "team-a", fid = "feat-n8b6";
  const nodes: PlanNode[] = PLAN.map(([key, , deps]) => ({ key, oneLine: `${key} 节点的一句话`, deps, fileGlobs: [], estimate: "2h" }));
  const tasks: TaskProjection[] = PLAN.filter(([, st]) => st).map(([key, stage, deps, steps]) => ({
    taskId: `t-${key}`, sourceTaskId: key, sourceRev: 1, sourceSeq: 10, stage: stage!, assigneeCode: `m-${key}`, executorInstanceId: HOME,
    pr: null, head: null, deps, specSummary: `${key} 规格摘要`, specDigest: null, fullText: "home_only",
    steps: steps.map(([id, state]) => ({ sourceStepId: id, sourceRev: 1, sourceSeq: 10, state })), asks: [] }));
  // 中心 counts（N8B3 之后）：done / verified / cancelled 都算完成
  const feature: FeatureList["features"][number] = { id: fid, projectId: project, title: "团队子 DAG 对齐台账", description: "已取消算完成",
    rev: 1, version: 1, authorityMode: "planning", homeInstanceId: HOME, executorInstanceIds: [HOME], status: "active",
    counts: { total: nodes.length, completed: 2, blocked: 0, missing: 0 }, updatedBy: "pm", updatedAt: N8B6_NOW,
    projection: { sourceInstanceId: HOME, sourceSeq: 10, observedAt: N8B6_NOW - 60_000, receivedAt: N8B6_NOW - 60_000 } };
  const list: FeatureList = { schemaVersion: 1, teamId: team, serverSeq: 5, capabilities: {}, features: [feature] };
  const detail: FeatureDetail = { schemaVersion: 1, teamId: team, serverSeq: 5, capabilities: {}, feature,
    dag: { version: 1, nodes, bindings: tasks.map((t) => ({ nodeKey: t.sourceTaskId, taskId: t.taskId })) }, tasks };
  const details = new Map([[fid, detail]]);
  const teamOv = teamOverview(list, details, N8B6_NOW);
  const board = teamDagBoard(project, list, details, teamOv);
  return { project, team, list, details, teamOv, board, local: localOf(board, teamOv.ov) };
}

/** 同一份节点的本机形状：执行人、步骤行原样（当前步 = 阶段那一步的最后一行，带真实轮次），没有团队标记 */
function localOf(team: DagBoard, ov: LedgerOverview): { board: DagBoard; ov: LedgerOverview } {
  const nodes = team.features[0]!.nodes.map((n): BoardNode => {
    const { ownerUnknown, ...rest } = n;
    void ownerUnknown;
    const steps = PLAN.find(([k]) => k === n.key)![3].map(([id, state]) => ({ step: id.split(":")[0]!, round: Number(id.split(":")[1]), state }));
    const last = steps.at(-1);
    const agent = AGENT[n.key];
    return { ...rest, handler: agent && n.phase === "active" ? { role: n.status === "review" ? "reviewer" : "executor", agent, since: N8B6_NOW - 3600_000 } : null,
      stepLine: steps.length && last ? { active: n.phase === "active" ? { step: last.step, round: last.round } : null, steps } : null,
      round: last?.round ?? null };
  });
  const tasks = ov.tasks.map((t) => {
    const { roundUnknown, team: teamFacts, ...rest } = t;
    void roundUnknown; void teamFacts;
    return { ...rest, agent: AGENT[t.id] ?? null, round: PLAN.find(([k]) => k === t.id)![3].filter(([id]) => id.startsWith("review:")).length };
  });
  return { board: { ...team, features: [{ ...team.features[0]!, nodes }], agents: [] }, ov: { ...ov, tasks, mirror: undefined } };
}

/** 节点卡（桌面画布那一款）在子进程里 SSR：每个节点一段 html */
function renderNodes(nodes: readonly BoardNode[]): Record<string, string> {
  const script = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { NodeBody } from './features/collab/dag/dag-node.tsx';
    const tr = (s, v = {}) => s.replace(/\\{(\\w+)\\}/g, (_, k) => String(v[k]));
    const out = {};
    for (const n of ${JSON.stringify(nodes)}) {
      const owner = n.handler && n.handler.agent ? { agent: n.handler.agent.replace(/^agent-/, ''), role: n.handler.role } : null;
      out[n.key] = renderToStaticMarkup(createElement(NodeBody, { node: n, kind: 'full', mark: null, owner, act: '', now: ${N8B6_NOW},
        hot: false, selected: false, flash: null, tr, onPick() {}, onOwner() {} }));
    }
    console.log(JSON.stringify(out));
  `;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  return JSON.parse(p.stdout.toString()) as Record<string, string>;
}

const node = (b: DagBoard, key: string) => b.features[0]!.nodes.find((n) => n.key === key)!;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("[验收线 1] 已取消的绑卡节点算完成：不在进行中，子 DAG 进行中数 = 产品卡进行中数，依赖它的节点不算被挡", () => {
  const { list, teamOv, board, details } = n8b6Fixture();
  const f = board.features[0]!;
  expect(node(board, "X12")).toMatchObject({ phase: "done", satisfied: true });
  expect(f.counts).toMatchObject({ total: 6, done: 2, active: 3, idle: 1 });
  const product = sharedProductBoard(list, N8B6_NOW, teamOv.ov.tasks, details).features[0]!;
  expect(f.counts.active).toBe(product.counts.active);
  // 依赖已取消节点的 Y1：不被挡，边按完成算
  expect(node(board, "Y1").ready).toBe(true);
  expect(teamOv.ov.tasks.find((t) => t.id === "Y1")!.blockedBy).toBeUndefined();
  expect(teamOv.ov.deps!.find((d) => d.from === "X12" && d.to === "Y1")).toMatchObject({ derived: "done", effective: "done" });
});

test("[验收线 2] 执行人未知的在做卡不出「未派」，没绑卡的节点照旧「未派」", () => {
  const { board } = n8b6Fixture();
  const html = renderNodes(board.features[0]!.nodes);
  for (const key of ["S2D2C", "T44", "R5", "X12", "D1"]) {
    expect(node(board, key).ownerUnknown).toBe(true);
    expect(text(html[key]!)).not.toContain("未派");
  }
  expect(node(board, "Y1").ownerUnknown).toBeUndefined();
  expect(text(html.Y1!)).toContain("未派");
});

test("[验收线 3] 修阶段最后一行是已交付的 fix:2 → 只写「修」不写「第 2 轮」；审阶段 review:5 已派 → 第 5 轮", () => {
  const { board } = n8b6Fixture();
  expect(node(board, "T44").stepLine!.active).toEqual({ step: "fix", round: 2, roundUnknown: true });
  expect(node(board, "R5").stepLine!.active).toEqual({ step: "review", round: 5 });
  const html = renderNodes(board.features[0]!.nodes);
  expect(text(html.T44!)).toContain("修");
  expect(text(html.T44!)).not.toMatch(/第\s*\d+\s*轮/);
  expect(text(html.R5!)).toContain("审 · 第 5 轮");
  expect(text(html.S2D2C!)).toContain("修");
  // 纯函数同口径：已派照它的轮次；退到兜底步骤（修阶段没有 fix 行）的照旧
  const steps = (rows: Steps) => rows.map(([id, state]) => ({ sourceStepId: id, sourceRev: 1, sourceSeq: 1, state }));
  expect(teamStepLine(steps([["fix:3", "assigned"]]), "fix")!.active).toEqual({ step: "fix", round: 3 });
  expect(teamStepLine(steps([["review:5", "delivered"]]), "review")!.active).toEqual({ step: "review", round: 5, roundUnknown: true });
  expect(teamStepLine(steps([["write:2", "done"]]), "fix")!.active).toEqual({ step: "write", round: 2 });
});

test("[验收线 4] 本机夹具（同样的节点和步骤行）：执行人、轮次照常，没有团队标记", () => {
  const { local } = n8b6Fixture();
  const nodes = local.board.features[0]!.nodes;
  for (const n of nodes) expect(n.ownerUnknown).toBeUndefined();
  for (const n of nodes) expect(n.stepLine?.active?.roundUnknown).toBeUndefined();
  const html = renderNodes(nodes);
  expect(text(html.T44!)).toContain("修 · 第 2 轮");
  expect(text(html.R5!)).toContain("审 · 第 5 轮");
  expect(text(html.S2D2C!)).toContain("dev-1");
  // 本机没有执行人的节点（未绑卡、已完成 / 已取消）照旧「未派」
  for (const key of ["Y1", "X12", "D1"]) expect(text(html[key]!)).toContain("未派");
});

test("[验收线 3] 同一份团队步骤线进任务详情 / 列表：当前步骤照样认得出（StepLine 标当前格、StepDots 写「修」），不出轮次", () => {
  const { teamOv } = n8b6Fixture();
  const d = teamTaskDetail(teamOv, "T44", N8B6_NOW)!;
  const v = stepLineView(d.stepLine, d.task.stage)!;
  expect(v.current).toMatchObject({ key: "fix", round: 2, current: true });
  const script = `
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StepLine, StepDots } from './features/collab/collab-step-line.tsx';
    const tr = (s, v = {}) => s.replace(/\\{(\\w+)\\}/g, (_, k) => String(v[k]));
    const v = ${JSON.stringify(v)};
    console.log(JSON.stringify({ line: renderToStaticMarkup(h(StepLine, { v, tr })), dots: renderToStaticMarkup(h(StepDots, { v, tr })) }));
  `;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString()).toBe("");
  const { line, dots } = JSON.parse(p.stdout.toString()) as { line: string; dots: string };
  expect(line).toMatch(/data-step="fix"[^>]*aria-current="step"/);
  expect(text(dots)).toContain("修");
  expect(text(dots)).not.toMatch(/第\s*\d+\s*轮/);
});
