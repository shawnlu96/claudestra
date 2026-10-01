/**
 * 进度图的行与两张图之间的跳转（纯函数，单测 tests/web-collab-dag-progress.test.ts）。
 * 行从三处合：L4 快照的 agents（PM 永远在前）、本项目成员（chat-store 的 agents 里 projectId 是本项目的，没活就是空闲行）、
 * /agents 的 busy（行首状态点，口径同 team-panel-model.ts workState）。节点上显示的负责人也从这些行里认，
 * 保证同一份快照下节点和行说的是同一个人；行里找不到才退回节点自己的 handler。
 */
import { workState, type WorkState } from "../team-panel-model";
import { nodeId, openWith } from "./dag-layout";
import type { BoardNode, FeatureCard, OffGraphItem, ProgressRowView, WorkItem } from "./dag-types";

export interface ProgressRow {
  agent: string;
  pm: boolean;
  /** 本项目成员（registry 里归这个项目的） */
  member: boolean;
  state: WorkState;
  work: WorkItem[];
  offGraph: OffGraphItem[];
}

export interface AgentLite {
  name: string;
  projectId?: string | null;
  status?: string;
  busy?: boolean;
}

const bare = (n: string) => n.replace(/^agent-/, "");

export function progressRows(rows: readonly ProgressRowView[], agents: readonly AgentLite[], project: string): ProgressRow[] {
  const byName = new Map(agents.map((a) => [bare(a.name), a]));
  const members = new Set(agents.filter((a) => a.projectId === project).map((a) => bare(a.name)));
  const seen = new Set<string>();
  const out: ProgressRow[] = [];
  const add = (agent: string, pm: boolean, work: WorkItem[], offGraph: OffGraphItem[]) => {
    const name = bare(agent);
    const prev = out.find((r) => r.agent === name);
    if (prev) {
      // 同名两行（agent- 前缀写法不一）并成一行
      prev.pm ||= pm;
      prev.work.push(...work);
      prev.offGraph.push(...offGraph);
      return;
    }
    seen.add(name);
    const a = byName.get(name);
    out.push({ agent: name, pm, member: members.has(name), state: a ? workState(a) : "unknown", work: [...work], offGraph: [...offGraph] });
  };
  for (const r of rows) if (r.pm) add(r.agent, true, r.work, r.offGraph);
  for (const r of rows) if (!r.pm) add(r.agent, false, r.work, r.offGraph);
  for (const m of [...members].sort()) if (!seen.has(m)) add(m, false, [], []);
  // PM 永远在前：上面先放了 PM，同名合并可能把后来的行升成 PM，最后再稳定排一次
  return out.map((r, i) => ({ r, i })).sort((a, b) => Number(b.r.pm) - Number(a.r.pm) || a.i - b.i).map((x) => x.r);
}

/** 节点的负责人：认进度行（work 里有这个节点的那一行），找不到退回 handler.agent；没人 = null */
export function ownerOf(rows: readonly ProgressRow[], featureId: string, node: BoardNode): { agent: string; role: string } | null {
  for (const r of rows) {
    const w = r.work.find((x) => x.featureId === featureId && x.nodeKey === node.key);
    if (w) return { agent: r.agent, role: w.role };
  }
  return node.handler?.agent ? { agent: bare(node.handler.agent), role: node.handler.role } : null;
}

/** 进度 → DAG：要展开哪些 feature（守 MAX_OPEN）、要不要展开「✓N」、居中到哪个节点；节点不在快照里 = null */
export function jumpToNode(features: readonly FeatureCard[], open: readonly string[], featureId: string, key: string):
  { open: string[]; evicted: string | null; expandDone: boolean; id: string } | null {
  const f = features.find((x) => x.id === featureId);
  const n = f?.currentVersion ? f.nodes.find((x) => x.key === key) : undefined;
  if (!f || !n) return null;
  const o = openWith(open, featureId, features);
  return { ...o, expandDone: n.phase === "done", id: nodeId(featureId, key) };
}

/** DAG → 进度：负责人那一行在不在（不在 = 没法跳，比如别的实例的执行者被过滤掉了） */
export function rowOf(rows: readonly ProgressRow[], agent: string): ProgressRow | null {
  return rows.find((r) => r.agent === bare(agent)) ?? null;
}

