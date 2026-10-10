/**
 * 团队数据源的「谁在干活」（team-project-N8B5）：把已经加载的团队总览（team-source-adapter.ts）和团队子 DAG（team-source-dag.ts）
 * 转成 WorkBoardContent 吃的展示模型。纯函数，不发请求——团队视图不调本机 /ledger/:p/work（team-source-shared.ts UNAVAILABLE）。
 * 分栏口径同本机：在等 = 被挡或主场有开着的阻塞提问；在干活 = 有执行者且在写 / 审 / 修 / 合并 / 上线；待做 = 当前 DAG 里没绑卡的节点，
 * 按依赖是否都满足分就绪 / 被挡。done / verified / cancelled 不进三栏；绑了卡但还在规格 / 复述、又没被挡的也不进（中心不知道它在等什么）。
 * 中心没有开工时间、轮次、估时：不填、不算，视图据此不显示计时 / 剩余 / 全部做完。
 */
import type { LedgerOverview, Stage } from "./collab-model";
import type { BoardNode, DagBoard } from "./dag/dag-types";
import type { TeamWorkBoard, TeamWorkRow } from "./work/work-types";

const WORKING: ReadonlySet<Stage> = new Set(["build", "review", "fix", "merge", "live"]);
const CLOSED: ReadonlySet<Stage> = new Set(["done", "verified", "cancelled"]);

/** 执行实例 → 成员名；对不上（或名字空）就是实例代号原样，不猜 */
export const machineName = (id: string | null, names: ReadonlyMap<string, string>): string | null =>
  id === null ? null : names.get(id)?.trim() || id;

export function teamWorkBoard(dag: DagBoard | null, ov: LedgerOverview, names: ReadonlyMap<string, string> = new Map()): TeamWorkBoard {
  const board: TeamWorkBoard = { now: ov.now, working: [], waiting: [], todo: { ready: [], blocked: [] }, machines: {}, mirror: ov.mirror ?? [] };
  const features = dag?.features ?? [];
  const nodeOf = new Map<string, { featureId: string; node: BoardNode }>();
  for (const f of features) for (const n of f.nodes) if (n.taskId) nodeOf.set(n.taskId, { featureId: f.id, node: n });
  for (const t of ov.tasks) {
    if (!t.team || CLOSED.has(t.stage)) continue;
    const at = nodeOf.get(t.id);
    const row: TeamWorkRow = { taskId: t.id, featureId: at?.featureId ?? null, nodeKey: at?.node.key ?? null, title: at?.node.oneLine || t.title,
      who: t.team.assigneeCode, machine: machineName(t.team.executorInstanceId, names), stage: t.stage, reason: null, team: t.team };
    if (t.stage === "blocked" || t.team.blockingAsks > 0) board.waiting.push(row);
    else if ((row.who !== null || row.machine !== null) && WORKING.has(t.stage)) {
      board.working.push(row);
      if (row.machine) board.machines[row.machine] = (board.machines[row.machine] ?? 0) + 1;
    }
  }
  for (const f of features.filter((x) => x.status !== "done")) for (const n of f.nodes) {
    if (n.taskId || n.missing) continue;
    // 与本机 ledger-work-board.ts 同一句：依赖节点没满足就是被挡；中心没有「是否已写规格」，不判缺规格
    const blocked = n.deps.filter((key) => !f.nodes.find((x) => x.key === key)?.satisfied);
    const row: TeamWorkRow = { taskId: null, featureId: f.id, nodeKey: n.key, title: n.oneLine, who: null, machine: null, stage: null,
      reason: blocked.length ? `被 ${blocked.join("、")} 挡住` : null, team: null };
    board.todo[row.reason ? "blocked" : "ready"].push(row);
  }
  return board;
}
