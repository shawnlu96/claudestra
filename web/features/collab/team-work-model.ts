/**
 * 团队数据源的「谁在干活」（team-project-N8B5）：把已经加载的团队总览（team-source-adapter.ts）和团队子 DAG（team-source-dag.ts）
 * 转成 WorkBoardContent 吃的展示模型。纯函数，不发请求（要不要读本机 /work 由 use-work-board.ts useTeamWorkBoard 按主场判断）。
 * 分栏口径（UXWHO1 四栏）：合并阶段一律进「在等合并」（团队卡没有进入合并的时刻，不排队位，写「等合并」）；在等 = 被挡、主场有开着的
 * 阻塞提问、已上线等验证（live）、等 PM 放行（restate）；在干活 = 有执行者且在写 / 审 / 修；待做 = 当前 DAG 里没绑卡的节点，
 * 按依赖是否都满足分就绪 / 被挡。done / verified / cancelled 不进栏；绑了卡还在规格、又没被挡的也不进（中心不知道它在等什么）。
 * 机器名在这里不填（instance 留执行实例原值）：本机 / peer 名 / 其他成员的机器由 team-work-merge.ts 统一命名，主场本机的行也在那里换成本机看板。
 * 中心没有开工时间、轮次、估时：不填、不算，视图据此不显示计时 / 剩余 / 全部做完。
 * now 是显示时的当前时钟（不是快照的 ov.now）：主场停推不会有新快照，镜像新鲜度 / 同步年龄要随时间重判（collab-model.ts MirrorFact）。
 */
import type { LedgerOverview, Stage } from "./collab-model";
import type { BoardNode, DagBoard } from "./dag/dag-types";
import type { TeamWorkBoard, TeamWorkRow } from "./work/work-types";

const WORKING: ReadonlySet<Stage> = new Set(["build", "review", "fix"]);
const CLOSED: ReadonlySet<Stage> = new Set(["done", "verified", "cancelled"]);
/** 不是被挡、却也没人在动的阶段：行上写在等什么（同 collab-model.ts stageLabel 的短语） */
const WAIT_REASON: Partial<Record<Stage, string>> = { live: "已上线 · 等验证", restate: "等 PM 放行" };

export function teamWorkBoard(dag: DagBoard | null, ov: LedgerOverview, now: number): TeamWorkBoard {
  const board: TeamWorkBoard = { now, working: [], merging: [], waiting: [], todo: { ready: [], blocked: [] }, machines: {}, mirror: ov.mirror ?? [] };
  const features = dag?.features ?? [];
  const nodeOf = new Map<string, { featureId: string; node: BoardNode }>();
  for (const f of features) for (const n of f.nodes) if (n.taskId) nodeOf.set(n.taskId, { featureId: f.id, node: n });
  for (const t of ov.tasks) {
    if (!t.team || CLOSED.has(t.stage)) continue;
    const at = nodeOf.get(t.id);
    const row: TeamWorkRow = { taskId: t.id, featureId: at?.featureId ?? null, nodeKey: at?.node.key ?? null, title: at?.node.oneLine || t.title,
      who: t.team.assigneeCode, instance: t.team.executorInstanceId, machine: null, stage: t.stage, reason: null, team: t.team };
    if (t.stage === "merge") board.merging.push({ ...row, reason: "等合并" });
    else if (t.stage === "blocked" || t.team.blockingAsks > 0) board.waiting.push(row);
    else if (WAIT_REASON[t.stage]) board.waiting.push({ ...row, reason: WAIT_REASON[t.stage]! });
    else if ((row.who !== null || row.instance !== null) && WORKING.has(t.stage)) board.working.push(row);
  }
  for (const f of features.filter((x) => x.status !== "done")) for (const n of f.nodes) {
    if (n.taskId || n.missing) continue;
    // 与本机 ledger-work-board.ts 同一句：依赖节点没满足就是被挡；中心没有「是否已写规格」，不判缺规格
    const blocked = n.deps.filter((key) => !f.nodes.find((x) => x.key === key)?.satisfied);
    const row: TeamWorkRow = { taskId: null, featureId: f.id, nodeKey: n.key, title: n.oneLine, who: null, instance: null, machine: null, stage: null,
      reason: blocked.length ? `被 ${blocked.join("、")} 挡住` : null, team: null };
    board.todo[row.reason ? "blocked" : "ready"].push(row);
  }
  return board;
}
