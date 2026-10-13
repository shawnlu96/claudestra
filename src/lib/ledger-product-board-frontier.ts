/**
 * 产品板按 feature 的派生状态、前沿节点、全完成标记（team-project-PDSTATE1）：纯函数，数据由 productBoard 一次读好传进来。
 * 节点类别只认 nodeClasses（与计数同一口径），所以卡上的数字和状态不会各说各话。规则与样例见 tests/ledger-product-board-frontier.test.ts。
 */
import type { EtaNode } from "./ledger-product-board-eta.js";
import { currentStageMark } from "./ledger-metrics.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { stepPeer } from "./ledger-steps.js";
import { PAGE_CHECK_KEY } from "./ui-acceptance.js";
import { deferredLine, nodeClasses, type CountNode, type NodeClass } from "./product-node-counts.js";

/** 进行中的卡超过这么久没有动静就算「久未动」（门槛待 owner 定，设计稿 §8） */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** 本机执行者统一显示的名字；peer 显示 peer 名，任何时候都不写具体人名 / 机器名 */
export const LOCAL_MEMBER = "本机";
const FRONTIER_MAX = 6;
/** 升序比较，null 排最后（sort 稳定，同值保持 DAG 顺序） */
const nullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);
const neg = (v: number | null) => (v === null ? null : -v);

export type FeatureState = "done" | "run" | "blocked" | "stale" | "ready" | "gate" | "wait";
export interface FrontierItem {
  key: string; taskId: string | null; title: string; stage: string | null; round: number; member: string | null; sinceMs: number | null;
}
type Events = ReadonlyMap<string, readonly LedgerEvent[]>;
interface Row { count: CountNode; cls: NodeClass; task: LedgerTask | null; title: string; activity: number | null }

/** EtaNode → 计数行：凭项目验收源完成的 PAGEOK 没有卡，按完成卡的样子喂计数 */
export function countRows(nodes: readonly EtaNode[]): CountNode[] {
  return nodes.map((n) => ({ key: n.key, deferred: deferredLine(n.oneLine), deps: n.deps,
    ...(n.accepted ? { taskId: n.key, stage: "done" } : { taskId: n.taskId, stage: n.task?.stage ?? null }) }));
}

/** 动静 = 该卡最新一条事件的 ts，没有事件用卡的 updatedAt；没卡没有动静 */
function activityOf(task: LedgerTask | null, own: readonly LedgerEvent[]): number | null {
  if (own.length) return Math.max(...own.map((e) => e.ts));
  return task ? task.updatedAt : null;
}

function memberOf(task: LedgerTask | null, own: readonly LedgerEvent[]): string | null {
  const assign = own.findLast((e) => e.kind === "step" && e.data.op === "assign");
  if (assign) {
    const executorKind = String(assign.data.executorKind);
    if (executorKind === "peer") return stepPeer({ executor: String(assign.data.executor ?? ""), executorKind: "peer" });
    return executorKind === "agent" || executorKind === "human" ? LOCAL_MEMBER : null;
  }
  return task?.assigneeKind === "agent" ? LOCAL_MEMBER : null;
}

function rowsOf(nodes: readonly EtaNode[] | null, cards: readonly LedgerTask[], events: Events): Row[] {
  const counts = nodes ? countRows(nodes) : cards.map((t): CountNode => ({ key: t.id, deferred: false, taskId: t.id, stage: t.stage, deps: [] }));
  const classes = nodeClasses(counts);
  return counts.map((count, i) => {
    const task = nodes ? nodes[i]!.task : cards[i]!;
    const own = count.taskId && !nodes?.[i]?.accepted ? events.get(count.taskId) ?? [] : [];
    return { count, cls: classes[i]!, task, title: task?.title ?? nodes![i]!.oneLine, activity: activityOf(task, own) };
  });
}

function stateOf(status: string, rows: readonly Row[], complete: boolean, now: number): FeatureState {
  const has = (cls: NodeClass) => rows.some((r) => r.cls === cls);
  const open = rows.filter((r) => r.cls !== "completed" && r.cls !== "deferred");
  if (status === "done" || complete) return "done";
  if (rows.some((r) => r.cls === "active" && r.activity !== null && now - r.activity < STALE_MS)) return "run";
  if (has("blocked")) return "blocked";
  if (has("active")) return "stale";
  if (rows.some((r) => r.cls === "ready" && r.count.key !== PAGE_CHECK_KEY)) return "ready";
  if (open.length && open.every((r) => r.count.key === PAGE_CHECK_KEY)) return "gate";
  return "wait";
}

function itemOf(r: Row, events: Events): FrontierItem {
  const id = r.count.taskId, own = id ? events.get(id) ?? [] : [];
  return { key: r.count.key, taskId: id, title: r.title, stage: r.task ? r.task.stage : id ? null : "planned", round: r.task?.round ?? 0,
    member: id ? memberOf(r.task, own) : null, sinceMs: id ? currentStageMark(own)?.ts ?? r.task?.updatedAt ?? null : null };
}

/** nodes = null：没 DAG，按 feature 的卡算（每张卡一行，没有依赖） */
export function productFrontier(input: { status: string; nodes: readonly EtaNode[] | null; cards: readonly LedgerTask[]; events: Events; now: number }) {
  const rows = rowsOf(input.nodes, input.cards, input.events);
  const completed = rows.filter((r) => r.cls === "completed").length, deferred = rows.filter((r) => r.cls === "deferred").length;
  const complete = completed > 0 && completed + deferred === rows.length;
  const state = stateOf(input.status, rows, complete, input.now);
  if (state === "done") return { state, complete, frontier: [] as FrontierItem[] };
  const items = rows.map((r) => ({ r, item: itemOf(r, input.events) }));
  const group = (cls: NodeClass) => items.filter((x) => x.r.cls === cls);
  const active = group("active").sort((a, b) => nullsLast(neg(a.r.activity), neg(b.r.activity)));
  const blocked = group("blocked").sort((a, b) => nullsLast(a.item.sinceMs, b.item.sinceMs));
  const ready = group("ready");
  const ordered = state === "blocked" ? [...blocked, ...active, ...ready] : [...active, ...blocked, ...ready];
  return { state, complete, frontier: ordered.slice(0, FRONTIER_MAX).map((x) => x.item) };
}
