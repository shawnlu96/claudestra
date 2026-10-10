/**
 * 产品板按 DAG 节点计数（team-project-N8B1）：本机产品板与团队产品卡同一个纯函数，twin 在 web/lib/product-node-counts.ts。
 * 节点阶段同 nodePhase：没绑卡或卡在 spec = 没开工；verified / done / cancelled = 完成；其余 = 进行中。
 * 远期节点计 deferred；绑了卡但卡读不到（stage = null）或卡 stage = blocked 计 blocked；没开工的依赖全完成计 ready，否则也计 blocked。
 */
export interface CountNode { key: string; deferred: boolean; taskId: string | null; stage: string | null; deps: readonly string[] }

const DONE_STAGES = new Set(["verified", "done", "cancelled"]);

/** 一句话以「（远期）」/「(远期)」开头的节点 */
export const deferredLine = (oneLine: string): boolean => /^\s*(?:（远期）|\(远期\))/.test(oneLine);

function countPhase(n: Pick<CountNode, "taskId" | "stage">): "idle" | "active" | "done" {
  if (!n.taskId || n.stage === "spec") return "idle";
  return n.stage !== null && DONE_STAGES.has(n.stage) ? "done" : "active";
}

export function productNodeCounts(nodes: readonly CountNode[]) {
  const counts = { total: nodes.length, completed: 0, active: 0, ready: 0, blocked: 0, deferred: 0 };
  const completed = new Set(nodes.filter((n) => !n.deferred && countPhase(n) === "done").map((n) => n.key));
  for (const n of nodes) {
    if (n.deferred) counts.deferred++;
    else if (countPhase(n) === "done") counts.completed++;
    else if ((n.taskId && n.stage === null) || n.stage === "blocked") counts.blocked++;
    else if (countPhase(n) === "active") counts.active++;
    else if (n.deps.every((key) => completed.has(key))) counts.ready++;
    else counts.blocked++;
  }
  return counts;
}
