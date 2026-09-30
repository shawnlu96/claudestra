/**
 * 子 DAG 的并行车道（MCP 工具 plan_feature / rewrite_dag / show_dag 的返回，docs/architecture/dag-tools.md）：纯函数。
 * 文件重叠的判定只用调度器那一套（lib/ledger-scheduler.ts resourceKey + resourcesOverlap）——车道说能并行的，调度器派单时也不会因为
 * 文件范围互相卡住；两边口径一旦分叉，PM 按车道同时开两张卡，调度器却让其中一张一直等 resource_busy。
 * 没写 fileGlobs 的节点（旧版本）判不了重叠：一律算排队（no_globs），不猜它能并行。
 */
import type { Database } from "bun:sqlite";
import { nodePhase, type NodePhase } from "./ledger-dag-rules.js";
import { isSatisfied } from "./ledger-deps.js";
import { effectiveNodes, getDagVersion, projectNodes, type Feature, type NodeView } from "./ledger-feature.js";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import { TERMINAL_STAGES, type LedgerTask } from "./ledger-stages.js";
import { listTasks } from "./ledger-store.js";

export interface LaneNode {
  key: string;
  deps: readonly string[];
  fileGlobs: readonly string[] | undefined;
  taskId: string | null;
  phase: NodePhase;
  /** 依赖节点都已满足（NodeView.satisfied 的口径） */
  depsMet: boolean;
  /** 自己已满足（code 上线即算），不再占文件 */
  satisfied: boolean;
}

/** 不在这张图里、但正占着文件的卡（同项目、没到终态、没满足、写了 extra.fileGlobs） */
export interface BusyCard {
  taskId: string;
  fileGlobs: readonly string[];
}

export interface Waiting {
  key: string;
  why: "deps" | "files" | "no_globs";
  /** deps：没满足的依赖节点；files：和它重叠的节点 key 或卡号 */
  on: string[];
}

export interface Lanes {
  /** 现在就能同时开工的计划节点：依赖都满足、文件两两不重叠、也不和正在做的卡重叠 */
  startNow: string[];
  waiting: Waiting[];
  /** 没做完的节点按文件重叠连成的组：同一组只能一个接一个做，不同组之间可以并行（依赖另算） */
  lanes: string[][];
}

const keysOf = (globs: readonly string[] | undefined): string[] | null => {
  if (!globs?.length) return null;
  const keys = globs.map(resourceKey);
  return keys.includes(null) ? null : (keys as string[]);
};

export function globsOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const ka = keysOf(a), kb = keysOf(b);
  if (!ka || !kb) return false;
  return ka.some((x) => kb.some((y) => resourcesOverlap(x, y)));
}

/** 占着文件的：已绑卡（含刚开工还在 spec 的）、没做完也没满足的节点，加上图外的忙卡 */
function occupants(nodes: readonly LaneNode[], busy: readonly BusyCard[]): { id: string; globs: readonly string[] }[] {
  const live = nodes.filter((n) => n.taskId && n.phase !== "done" && !n.satisfied && n.fileGlobs?.length).map((n) => ({ id: n.key, globs: n.fileGlobs as string[] }));
  return [...live, ...busy.map((b) => ({ id: b.taskId, globs: b.fileGlobs }))];
}

function groups(nodes: readonly LaneNode[]): string[][] {
  const open = nodes.filter((n) => n.phase !== "done" && !n.satisfied);
  const parent = new Map(open.map((n) => [n.key, n.key]));
  const find = (k: string): string => (parent.get(k) === k ? k : find(parent.get(k) as string));
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      if (globsOverlap(open[i].fileGlobs, open[j].fileGlobs)) parent.set(find(open[j].key), find(open[i].key));
    }
  }
  const out = new Map<string, string[]>();
  for (const n of open) out.set(find(n.key), [...(out.get(find(n.key)) ?? []), n.key]);
  return [...out.values()];
}

/** 按节点在图里的顺序贪心挑：先到先占，后面和已挑的重叠的排到它后面 */
export function computeLanes(nodes: readonly LaneNode[], busy: readonly BusyCard[] = []): Lanes {
  const held = occupants(nodes, busy);
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const startNow: string[] = [];
  const waiting: Waiting[] = [];
  for (const n of nodes) {
    if (n.phase !== "idle" || n.taskId) continue;
    if (!n.depsMet) {
      waiting.push({ key: n.key, why: "deps", on: n.deps.filter((d) => !byKey.get(d)?.satisfied) });
      continue;
    }
    if (!keysOf(n.fileGlobs)) {
      waiting.push({ key: n.key, why: "no_globs", on: [] });
      continue;
    }
    const clash = [...held, ...startNow.map((k) => ({ id: k, globs: byKey.get(k)?.fileGlobs ?? [] }))].filter((o) => globsOverlap(n.fileGlobs, o.globs)).map((o) => o.id);
    if (clash.length) waiting.push({ key: n.key, why: "files", on: clash });
    else startNow.push(n.key);
  }
  return { startNow, waiting, lanes: groups(nodes) };
}

/** 投影节点 → 车道输入：阶段按绑的卡现读（NodeView.status），依赖按 satisfied */
export function laneNodes(views: readonly NodeView[]): LaneNode[] {
  const ok = new Map(views.map((v) => [v.key, v.satisfied]));
  return views.map((v) => ({
    key: v.key, deps: v.deps, fileGlobs: v.fileGlobs, taskId: v.taskId, satisfied: v.satisfied, depsMet: v.deps.every((d) => ok.get(d) === true),
    phase: nodePhase(v.taskId, v.taskId ? (v.missing ? null : (v.status as LedgerTask["stage"])) : null),
  }));
}

/** 图外正占着文件的卡：同项目、不在这张图的节点上、没到终态、没满足、写了 extra.fileGlobs */
export function busyCards(tasks: readonly LedgerTask[], inGraph: ReadonlySet<string>, satisfied: (t: LedgerTask) => boolean): BusyCard[] {
  const out: BusyCard[] = [];
  for (const t of tasks) {
    if (inGraph.has(t.id) || TERMINAL_STAGES.includes(t.stage) || satisfied(t)) continue;
    const globs = Array.isArray(t.extra.fileGlobs) ? t.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
    if (globs.length) out.push({ taskId: t.id, fileGlobs: globs });
  }
  return out;
}

/** feature 当前版的车道（卡状态现读）；还没建 DAG 为 null */
export function featureLanes(db: Database, f: Feature): Lanes | null {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!v) return null;
  const views = projectNodes(db, effectiveNodes(db, v));
  const inGraph = new Set(views.map((n) => n.taskId).filter((t): t is string => !!t));
  return computeLanes(laneNodes(views), busyCards(listTasks(db, f.project), inGraph, isSatisfied));
}
