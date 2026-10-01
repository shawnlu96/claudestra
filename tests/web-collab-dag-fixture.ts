/** 子 DAG 两张图单测共用的假快照（形状照 web/features/collab/dag/dag-types.ts，即 i28-L4 的响应） */
import type { BoardNode, DagBoard, FeatureCard, NodePhase, ProgressRowView } from "../web/features/collab/dag/dag-types";

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
