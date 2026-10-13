/**
 * 产品板按 DAG 节点计数（team-project-N8B1）：twin，本体在 src/lib/product-node-counts.ts，两份去注释后逐行一致。
 * 节点阶段同 nodePhase：没绑卡或卡在 spec = 没开工；verified / done / cancelled = 完成；其余 = 进行中。
 * 远期节点计 deferred；绑了卡但卡读不到（stage = null）或卡 stage = blocked 计 blocked；没开工的依赖全完成计 ready，否则计 waiting。
 * 「在等前置」不算受阻：受阻只留真卡住的两种，产品板上的「N 受阻」才是要人管的数（team-project-PDSTATE1）。
 */
export interface CountNode { key: string; deferred: boolean; taskId: string | null; stage: string | null; deps: readonly string[] }

const DONE_STAGES = new Set(["verified", "done", "cancelled"]);

/** 一句话以「（远期）」/「(远期)」开头的节点 */
export const deferredLine = (oneLine: string): boolean => /^\s*(?:（远期）|\(远期\))/.test(oneLine);

function countPhase(n: Pick<CountNode, "taskId" | "stage">): "idle" | "active" | "done" {
  if (!n.taskId || n.stage === "spec") return "idle";
  return n.stage !== null && DONE_STAGES.has(n.stage) ? "done" : "active";
}

export type NodeClass = "deferred" | "completed" | "blocked" | "active" | "ready" | "waiting";

/** 按输入顺序给每行一个类别；计数与前沿节点（ledger-product-board-frontier.ts）都只认它 */
export function nodeClasses(nodes: readonly CountNode[]): NodeClass[] {
  const completed = new Set(nodes.filter((n) => !n.deferred && countPhase(n) === "done").map((n) => n.key));
  return nodes.map((n) => {
    if (n.deferred) return "deferred";
    if (countPhase(n) === "done") return "completed";
    if ((n.taskId && n.stage === null) || n.stage === "blocked") return "blocked";
    if (countPhase(n) === "active") return "active";
    return n.deps.every((key) => completed.has(key)) ? "ready" : "waiting";
  });
}

export function productNodeCounts(nodes: readonly CountNode[]) {
  const counts = { total: 0, completed: 0, active: 0, ready: 0, blocked: 0, deferred: 0, waiting: 0 };
  for (const c of nodeClasses(nodes)) { counts[c]++; counts.total++; }
  return counts;
}
