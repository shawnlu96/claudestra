/** 子 DAG 两张图单测共用的假快照（形状照 web/features/collab/dag/dag-types.ts，即 i28-L4 的响应） */
import type { BoardNode, DagBoard, FeatureCard, NodePhase, ProgressRowView } from "../web/features/collab/dag/dag-types";
import type { TeamWorkBoard, TeamWorkRow, WorkBoard, WorkRow } from "../web/features/collab/work/work-types";

export function node(key: string, phase: NodePhase, deps: string[] = [], extra: Partial<BoardNode> = {}): BoardNode {
  const status = phase === "idle" ? "planned" : phase === "done" ? "done" : "build";
  return {
    key, taskId: phase === "idle" ? null : `T-${key}`, oneLine: `做 ${key}`, deps, estimate: "", inheritedFrom: null,
    status, statusAtVersion: status, title: phase === "idle" ? null : `卡 ${key}`, satisfied: phase === "done", ready: false, missing: false,
    phase, round: phase === "active" ? 1 : null,
    handler: phase === "active" ? { role: "executor", agent: `exec-${key}`, since: 1000 } : null,
    stepLine: phase === "active" ? { active: { step: "write", round: 1 }, steps: [{ step: "restate", round: 0, state: "done" }, { step: "write", round: 1, state: "assigned" }] } : null,
    since: phase === "active" ? 1000 : null, pr: null, branch: null,
    ...extra,
  };
}

export function feature(id: string, nodes: BoardNode[], extra: Partial<FeatureCard> = {}): FeatureCard {
  const count = (p: NodePhase) => nodes.filter((n) => n.phase === p).length;
  return {
    id, title: `Feature ${id}`, status: "active", ownerWords: "", currentVersion: 1,
    version: { version: 1, reasonKind: "initial", reasonText: "初版", proposedBy: "agent-pm", approvedBy: null, createdAt: 1, cancels: [], scopeChange: false, askId: null },
    pending: null,
    counts: { total: nodes.length, done: count("done"), active: count("active"), idle: count("idle"), missing: nodes.filter((n) => n.missing).length },
    lastActivityAt: 1000, nodes,
    ...extra,
  };
}

/** 进度行：每个 active 节点的 handler.agent 进它那一行的 work，PM 名单各占一行（L4 规格第 1 条的口径） */
export function rowsFor(features: FeatureCard[], pms: string[] = ["pm"]): ProgressRowView[] {
  const rows = new Map<string, ProgressRowView>(pms.map((p) => [p, { agent: p, pm: true, work: [], offGraph: [] }]));
  for (const f of features) {
    for (const n of f.nodes) {
      if (n.phase !== "active" || !n.handler?.agent) continue;
      const r = rows.get(n.handler.agent) ?? { agent: n.handler.agent, pm: false, work: [], offGraph: [] };
      r.work.push({ featureId: f.id, nodeKey: n.key, taskId: n.taskId!, role: n.handler.role, step: n.stepLine?.active?.step ?? null, round: n.round, since: n.since! });
      rows.set(n.handler.agent, r);
    }
  }
  return [...rows.values()];
}

export function board(features: FeatureCard[], agents: ProgressRowView[] = rowsFor(features)): DagBoard {
  return { ok: true, project: "p", exists: true, now: 5000, asOfSeq: 1, features, agents };
}

/** /work 本机行（work-types.ts WorkRow）：默认挂在 F1 的 nodeKey 上、在写、未超时 */
export function workRow(nodeKey: string, extra: Partial<WorkRow> = {}): WorkRow {
  return {
    taskId: `T-${nodeKey}`, featureId: "F1", nodeKey, title: `卡 ${nodeKey}`, who: `exec-${nodeKey}`, machine: "local", step: "write",
    round: 1, since: 1000, normalMinutes: 30, remainingMinutes: 10, overMinutes: 0, reason: null, code: null, estimate: "",
    ...extra,
  };
}

/** /work 团队行（work-types.ts TeamWorkRow）：中心没有开工时间、常规耗时 */
export function teamRow(nodeKey: string, extra: Partial<TeamWorkRow> = {}): TeamWorkRow {
  return { taskId: `T-${nodeKey}`, featureId: "F1", nodeKey, title: `卡 ${nodeKey}`, who: null, instance: null, machine: null, stage: "build", reason: null, team: null, ...extra };
}

export const workBoard = (extra: Partial<WorkBoard> = {}): WorkBoard => ({
  now: 0, asOfSeq: 1, working: [], waiting: [], todo: { ready: [], blocked: [] }, machines: {}, completionHours: null, availableSlots: 1, ...extra,
});

export const teamWorkBoard = (extra: Partial<TeamWorkBoard> = {}): TeamWorkBoard => ({
  now: 0, working: [], merging: [], waiting: [], todo: { ready: [], blocked: [] }, machines: {}, mirror: [], ...extra,
});

export const MAIN_NOW = Date.UTC(2026, 9, 14, 12);
const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * 主线形状（B 稿 §2，已完成数缩小）：已完成 30（1 个 cancelled；doneAt 近 24 小时 12、昨天 8、更早 10）；
 * 进行中 8（等 owner / 等 CI / 等审查员领单 / 合并排队 / 超常规各 1，在干活 3，其中 1 张是 peer:Sekai · claude）；
 * 没开始 16（可开工 0、下一批 n1..n7、更远 f1..f9）。配 mainlineWork() 用。
 */
export function mainlineFeature(now = MAIN_NOW): FeatureCard {
  const doneAt = (i: number) => (i < 12 ? now - (i + 1) * 30 * MIN : i < 20 ? now - 30 * HOUR - (i - 12) * HOUR : now - 72 * HOUR - (i - 20) * HOUR);
  const done = Array.from({ length: 30 }, (_, i) => {
    const key = `d${String(i + 1).padStart(2, "0")}`;
    return node(key, "done", i ? [`d${String(i).padStart(2, "0")}`] : [], { doneAt: doneAt(i), round: 2, ...(i === 25 ? { status: "cancelled" } : {}) });
  });
  const act = (key: string, deps: string[] = ["d30"]) => node(key, "active", deps, { since: now - 5 * MIN });
  const active = ["a-owner", "a-ci", "a-pool", "a-mq", "a-over", "a-w1", "a-w2", "a-peer"].map((k) => act(k));
  const idle = (key: string, deps: string[]) => node(key, "idle", deps, { estimate: `${key} 1h` });
  const next = [
    idle("n1", ["a-w1"]), idle("n2", ["a-w1"]), idle("n3", ["a-w1"]), idle("n4", ["a-peer"]), idle("n5", ["a-over"]),
    idle("n6", ["a-ci", "a-pool"]), idle("n7", ["a-mq", "d01"]),
  ];
  const far = [
    idle("f1", ["n1"]), idle("f2", ["f1"]), idle("f3", ["n2", "n3"]), idle("f4", ["n4"]), idle("f5", ["f4"]), idle("f6", ["f5"]),
    idle("f7", ["n5", "a-owner"]), idle("f8", ["gone"]), idle("f9", ["f2", "n7"]),
  ];
  return feature("F1", [...done, ...active, ...next, ...far]);
}

export function mainlineWork(now = MAIN_NOW): WorkBoard {
  const row = (key: string, extra: Partial<WorkRow>) => workRow(key, { since: now - 5 * MIN, ...extra });
  return workBoard({
    now,
    waiting: [
      row("a-owner", { code: "owner", reason: "等 owner", since: now - 50 * MIN }),
      row("a-ci", { code: "ci", reason: "等 CI", step: "merge", since: now - 20 * MIN }),
      row("a-pool", { code: "pooled", reason: "等审查员领单", step: "review", since: now - 90 * MIN }),
      row("a-mq", { code: "merge_queue", reason: "合并排队：前面是 T-x", step: "merge", since: now - 10 * MIN }),
    ],
    working: [
      row("a-over", { overMinutes: 35, since: now - 65 * MIN }),
      row("a-w1", { since: now - 3 * MIN }),
      row("a-w2", { since: now - 40 * MIN }),
      row("a-peer", { who: "peer:Sekai · claude", machine: "Sekai", since: now - 15 * MIN }),
      row("a-w1", { featureId: "F2", who: "别的 feature", machine: "other" }),
    ],
    machines: { local: 3, Sekai: 1 },
  });
}
