/**
 * 产品板按 feature 的派生状态、前沿节点、全完成标记（team-project-PDSTATE1）：纯函数，数据由 productBoard 一次读好传进来。
 * 节点类别只认 nodeClasses（与计数同一口径），所以卡上的数字和状态不会各说各话。规则与样例见 tests/ledger-product-board-frontier.test.ts。
 * 暂停与冻结（project-map-PDSTATE2）：status=paused 直接是 paused；冻结名单（project-map-config.ts）里的卡不参与判状态、计数照旧，
 * 前沿里排在全部非冻结行之后并带 frozen: true。
 */
import type { EtaNode } from "./ledger-product-board-eta.js";
import { currentStageMark } from "./ledger-metrics.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { stepPeer } from "./ledger-steps.js";
import { PAGE_CHECK_KEY } from "./ui-acceptance.js";
import { deferredLine, nodeClasses, type CountNode, type NodeClass } from "./product-node-counts.js";

/** 进行中的卡超过这么久没有动静就算「久未动」（设计稿 §8） */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** 本机执行者统一显示的名字；peer 显示 peer 名，任何时候都不写具体人名 / 机器名 */
export const LOCAL_MEMBER = "本机";
const FRONTIER_MAX = 6;
/** 升序比较，null 排最后（sort 稳定，同值保持 DAG 顺序） */
const nullsLast = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);
const neg = (v: number | null) => (v === null ? null : -v);

export type FeatureState = "done" | "paused" | "run" | "blocked" | "stale" | "ready" | "gate" | "frozen" | "wait";
export interface FrontierItem {
  key: string; taskId: string | null; title: string; stage: string | null; round: number; member: string | null; sinceMs: number | null;
  /** 冻结名单里的卡才有这个键 */
  frozen?: true;
}
type Events = ReadonlyMap<string, readonly LedgerEvent[]>;
interface Row { count: CountNode; cls: NodeClass; task: LedgerTask | null; title: string; activity: number | null; frozen: boolean }

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

function rowsOf(nodes: readonly EtaNode[] | null, cards: readonly LedgerTask[], events: Events, frozen: ReadonlySet<string>): Row[] {
  const counts = nodes ? countRows(nodes) : cards.map((t): CountNode => ({ key: t.id, deferred: false, taskId: t.id, stage: t.stage, deps: [] }));
  const classes = nodeClasses(counts);
  return counts.map((count, i) => {
    const task = nodes ? nodes[i]!.task : cards[i]!;
    const own = count.taskId && !nodes?.[i]?.accepted ? events.get(count.taskId) ?? [] : [];
    return { count, cls: classes[i]!, task, title: task?.title ?? nodes![i]!.oneLine, activity: activityOf(task, own),
      frozen: !!count.taskId && frozen.has(count.taskId) };
  });
}

const isOpen = (r: Row) => r.cls !== "completed" && r.cls !== "deferred";
/** 已开卡、停在 spec 的就绪行计数仍算 ready，但 24 小时没动静也算久未动（规格验收线 1：冻结 active + 旧 spec 行 → stale） */
const staleSpec = (r: Row, now: number) => r.cls === "ready" && r.task?.stage === "spec" && r.activity !== null && now - r.activity >= STALE_MS;

/** 冻结行先拿掉再照原规则判；拿掉后没剩下能动的行（没有或只剩在等前置的）且有没完成的冻结行 → frozen */
function stateOf(status: string, rows: readonly Row[], complete: boolean, now: number): FeatureState {
  if (status === "done" || complete) return "done";
  if (status === "paused") return "paused";
  const live = rows.filter((r) => !r.frozen);
  const has = (cls: NodeClass) => live.some((r) => r.cls === cls);
  const open = live.filter(isOpen);
  if (live.some((r) => r.cls === "active" && r.activity !== null && now - r.activity < STALE_MS)) return "run";
  if (has("blocked")) return "blocked";
  if (has("active") || live.some((r) => staleSpec(r, now))) return "stale";
  if (live.some((r) => r.cls === "ready" && r.count.key !== PAGE_CHECK_KEY)) return "ready";
  if (open.length && open.every((r) => r.count.key === PAGE_CHECK_KEY)) return "gate";
  if (open.every((r) => r.cls === "waiting") && rows.some((r) => r.frozen && isOpen(r))) return "frozen";
  return "wait";
}

function itemOf(r: Row, events: Events): FrontierItem {
  const id = r.count.taskId, own = id ? events.get(id) ?? [] : [];
  return { key: r.count.key, taskId: id, title: r.title, stage: r.task ? r.task.stage : id ? null : "planned", round: r.task?.round ?? 0,
    member: id ? memberOf(r.task, own) : null, sinceMs: id ? currentStageMark(own)?.ts ?? r.task?.updatedAt ?? null : null,
    ...(r.frozen ? { frozen: true as const } : {}) };
}

/** nodes = null：没 DAG，按 feature 的卡算（每张卡一行，没有依赖）。frozen = 冻结的卡号（按 taskId 认），不传等于没有 */
export function productFrontier(input: {
  status: string; nodes: readonly EtaNode[] | null; cards: readonly LedgerTask[]; events: Events; now: number; frozen?: ReadonlySet<string>;
}) {
  const rows = rowsOf(input.nodes, input.cards, input.events, input.frozen ?? new Set());
  const completed = rows.filter((r) => r.cls === "completed").length, deferred = rows.filter((r) => r.cls === "deferred").length;
  const complete = completed > 0 && completed + deferred === rows.length;
  const state = stateOf(input.status, rows, complete, input.now);
  if (state === "done") return { state, complete, frontier: [] as FrontierItem[] };
  const items = rows.map((r) => ({ r, item: itemOf(r, input.events) }));
  const group = (cls: NodeClass) => items.filter((x) => x.r.cls === cls);
  const active = group("active").sort((a, b) => nullsLast(neg(a.r.activity), neg(b.r.activity)));
  const blocked = group("blocked").sort((a, b) => nullsLast(a.item.sinceMs, b.item.sinceMs));
  const ready = group("ready");
  const byClass = state === "blocked" ? [...blocked, ...active, ...ready] : [...active, ...blocked, ...ready];
  const ordered = [...byClass.filter((x) => !x.r.frozen), ...byClass.filter((x) => x.r.frozen)];
  return { state, complete, frontier: ordered.slice(0, FRONTIER_MAX).map((x) => x.item) };
}
