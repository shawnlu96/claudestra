/**
 * UXNUM1 对照基准的合成团队数据（规格「对照基准」）：12 个 feature；卡里规格 30、开发 / 审查 / 返工 8、合并 4、受阻 2、已完成 20；
 * 每个 feature 另有一个没开卡的节点（没开工 12）。late = 详情首轮 429 的那 3 个 feature。纯数据，计数单测与 DOM 测试共用。
 */
import { expect, test } from "bun:test";
import type { LedgerOverview, LedgerTaskView, Stage } from "../web/features/collab/collab-model";
import type { BoardNode, DagBoard, FeatureCard } from "../web/features/collab/dag/dag-types";

export const NOW = new Date(2026, 9, 14, 12, 0).getTime();
const STAGES: Stage[] = [...Array<Stage>(30).fill("spec"), "build", "build", "build", "review", "review", "review", "fix", "fix",
  "merge", "merge", "merge", "merge", "blocked", "blocked", ...Array<Stage>(20).fill("done")];
export const FEATURES = Array.from({ length: 12 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
export const LATE = FEATURES.slice(9);

const team = { assigneeCode: "m-1", executorInstanceId: "instance-peer", head: null, blockingAsks: 0, mirror: "fresh" as const, freshUntil: NOW + 600_000, observedAt: NOW };
const metrics = { startTs: null, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 };

function task(i: number, stage: Stage): LedgerTaskView {
  return { id: `T${i + 1}`, itemId: FEATURES[i % 12]!, title: `卡 ${i + 1}`, kind: "code", stage, round: 0, roundUnknown: true, agent: null, pm: null, pr: null,
    updatedAt: NOW, metrics, team };
}

function node(key: string, taskId: string | null, stage: string, deps: string[] = []): BoardNode {
  const done = stage === "done";
  return { key, taskId, oneLine: key, deps, estimate: "", inheritedFrom: null, status: taskId ? stage : "planned", statusAtVersion: null, title: key,
    satisfied: done, ready: deps.length === 0, missing: false, phase: done ? "done" : taskId && stage !== "spec" ? "active" : "idle", round: null, handler: null,
    stepLine: null, since: null, pr: null, branch: null };
}

/** features = 已拉到详情的 feature（缺的那几个整份不出现在总览 / 子 DAG 里，同 team-source-adapter.ts） */
export function synthTeam(features: readonly string[] = FEATURES): { ov: LedgerOverview; dag: DagBoard } {
  const on = new Set(features);
  const tasks = STAGES.map((st, i) => task(i, st)).filter((t) => on.has(t.itemId!));
  const cards: FeatureCard[] = FEATURES.filter((f) => on.has(f)).map((f) => {
    const mine = tasks.filter((t) => t.itemId === f);
    const nodes = mine.map((t) => node(`${f}-${t.id}`, t.id, t.stage));
    // 没开卡的节点：单数 feature 的前置没满足（被挡），双数的就绪
    const blocked = Number(f.slice(1)) % 2 === 1 && nodes.some((n) => !n.satisfied);
    nodes.push(node(`${f}-next`, null, "planned", blocked ? [nodes.find((n) => !n.satisfied)!.key] : []));
    return { id: f, title: `Feature ${f}`, status: "active", ownerWords: "", currentVersion: 1, version: null, pending: null, lastActivityAt: NOW, nodes,
      counts: { total: nodes.length, done: nodes.filter((n) => n.satisfied).length, active: 0, idle: 0, missing: 0 } };
  });
  const ov: LedgerOverview = { exists: true, now: NOW, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: cards.map((c) => ({ id: c.id, title: c.title, oneLine: "" })), tasks, deps: [], unknownMetrics: ["todayDone", "reviewRounds", "fixed", "reviewWait"] };
  return { ov, dag: { ok: true, project: "team", exists: true, now: NOW, asOfSeq: 1, features: cards, agents: [] } };
}

test("合成数据照规格：64 张卡（规格 30 / 开发审查返工 8 / 合并 4 / 受阻 2 / 已完成 20），12 个没开卡节点", () => {
  const { ov, dag } = synthTeam();
  const by = (s: Stage[]) => ov.tasks.filter((t) => s.includes(t.stage)).length;
  expect([ov.tasks.length, by(["spec"]), by(["build", "review", "fix"]), by(["merge"]), by(["blocked"]), by(["done"])]).toEqual([64, 30, 8, 4, 2, 20]);
  expect(dag.features.flatMap((f) => f.nodes.filter((n) => !n.taskId)).length).toBe(12);
  expect(synthTeam(FEATURES.slice(0, 9)).dag.features.length).toBe(9);
});
