/**
 * 子 DAG「进行中优先」的展示模型（team-project-SUBDAG1，单测 tests/web-collab-subdag-focus.test.ts）：把一个 feature 的节点和 /work 看板行
 * 合成进行中（分 owner / 在等 / 超常规 / 在干活四态并排序）、接下来（可开工 / 下一批 / 更远）、已完成三块和顶栏数。
 * 纯函数：不发请求、不读时钟（用入参 now）、不 import .tsx / react；格名和轮次的拼法交给界面（SUBDAG4）。
 * 分态口径照规格第 3 条手写（UXWHO1 / UXNUM1 的分类函数还没合，后合的一张负责收成一份）。
 */
import type { BoardNode, FeatureCard } from "./dag-types";
import { nodeSteps, slotOfStep } from "./dag-steps";
import type { TeamWorkBoard, TeamWorkRow, WorkBoard, WorkRow } from "../work/work-types";

export type FocusWork = { kind: "local"; board: WorkBoard } | { kind: "team"; board: TeamWorkBoard };
export type FocusState = "owner" | "waiting" | "over" | "working";

export interface FocusCard {
  nodeKey: string; taskId: string | null; oneLine: string; missing: boolean;
  state: FocusState; reason: string | null;
  /** label = 六格的格名，或「部署」「交付中」 */
  step: { label: string; round: number | null } | null;
  rounds: { review: number; fix: number } | null;
  who: string | null; family: "claude" | "codex" | null; machine: string | null;
  since: number | null; normalMinutes: number | null; overMinutes: number | null;
  lastEvent: { at: number; kind: string; text: string } | null;
  up: { nodeKey: string; done: boolean }[]; down: string[]; unlock: number;
}

export interface IdleRow { nodeKey: string; oneLine: string; estimate: string; reason: string | null; waitsOn: string[]; hops: number; unlock: number }

export interface FocusModel {
  head: { total: number; done: number; active: number; waiting: number; idle: number; done24h: number | null; machines: Record<string, number> };
  /** 已排序 */
  active: FocusCard[];
  next: { ready: IdleRow[]; oneHop: IdleRow[]; far: IdleRow[] };
  done: { nodeKey: string; oneLine: string; at: number | null; round: number; cancelled: boolean }[];
  autoOpenDone: boolean;
}

const DAY = 24 * 60 * 60_000;
const STATE_RANK: Record<FocusState, number> = { owner: 0, waiting: 1, over: 2, working: 3 };
const WAIT_CODES: ReadonlySet<string> = new Set(["merge_queue", "ci"]);
const WAIT_STEPS: ReadonlySet<string> = new Set(["merge", "deploy", "publishing"]);
const STEP_WORD: Record<string, string> = { deploy: "部署", publishing: "交付中" };

/** 看板上本 feature 的行，按 nodeKey 找；本机行带上它在哪一栏 */
type Found = { kind: "local"; row: WorkRow; lane: "working" | "waiting" | "todo" } | { kind: "team"; row: TeamWorkRow; lane: "working" | "waiting" | "todo" };

function rowIndex(featureId: string, work: FocusWork | null): Map<string, Found> {
  const out = new Map<string, Found>();
  if (!work) return out;
  const b = work.board;
  const lanes = [["working", b.working], ["waiting", b.waiting], ["todo", [...b.todo.ready, ...b.todo.blocked]]] as const;
  for (const [lane, rows] of lanes) for (const row of rows as (WorkRow | TeamWorkRow)[]) {
    if (row.featureId !== featureId || !row.nodeKey || out.has(row.nodeKey)) continue;
    out.set(row.nodeKey, (work.kind === "local" ? { kind: "local", row: row as WorkRow, lane } : { kind: "team", row: row as TeamWorkRow, lane }));
  }
  return out;
}

/** 只认两处：本机 peer 行末尾的「· claude / · codex」；团队成员代号里直接出现的家族词 */
function familyOf(found: Found | undefined): "claude" | "codex" | null {
  const who = found?.row.who ?? "";
  const m = found?.kind === "local" ? /·\s*(claude|codex)\s*$/.exec(who) : /\b(claude|codex)\b/i.exec(who);
  return m ? (m[1]!.toLowerCase() as "claude" | "codex") : null;
}

function stateOf(n: BoardNode, found: Found | undefined): FocusState {
  if (n.missing) return "waiting";
  if (!found) return "working";
  if (found.kind === "team") return found.lane === "waiting" || found.row.stage === "merge" ? "waiting" : "working";
  const r = found.row;
  if (r.code === "owner" || (r.code === "ask" && r.reason === "等 owner")) return "owner";
  if (found.lane === "waiting" || (r.step && WAIT_STEPS.has(r.step)) || (r.code && WAIT_CODES.has(r.code))) return "waiting";
  return found.lane === "working" && r.overMinutes > 0 ? "over" : "working";
}

function stepOf(n: BoardNode, found: Found | undefined): FocusCard["step"] {
  const rowStep = found?.kind === "local" ? found.row.step : null;
  if (rowStep && STEP_WORD[rowStep]) return { label: STEP_WORD[rowStep]!, round: null };
  const cur = nodeSteps(n.stepLine).current;
  if (!cur) return null;
  return { label: cur.label, round: n.stepLine?.active?.roundUnknown ? null : cur.round };
}

/** 「审」「修」两格各自出现过几个不同的轮次 */
function roundsOf(n: BoardNode): FocusCard["rounds"] {
  if (!n.stepLine) return null;
  const seen = { review: new Set<number>(), fix: new Set<number>() };
  for (const s of Array.isArray(n.stepLine.steps) ? n.stepLine.steps : []) {
    const slot = slotOfStep(s?.step ?? null)?.key;
    if (slot === "review" || slot === "fix") seen[slot].add(Number(s.round) || 0);
  }
  return { review: seen.review.size, fix: seen.fix.size };
}

interface Graph { byKey: Map<string, BoardNode>; down: Map<string, string[]> }

function graphOf(nodes: BoardNode[]): Graph {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const down = new Map<string, string[]>(nodes.map((n) => [n.key, []]));
  for (const n of nodes) for (const d of new Set(n.deps)) down.get(d)?.push(n.key);
  return { byKey, down };
}

/** 传递下游里没完成的节点数；已访问集合去重（菱形不重复计，环不死循环） */
function unlockOf(key: string, g: Graph): number {
  const seen = new Set([key]);
  const queue = [key];
  let count = 0;
  while (queue.length) for (const k of g.down.get(queue.shift()!) ?? []) {
    if (seen.has(k)) continue;
    seen.add(k); queue.push(k);
    if (g.byKey.get(k)?.phase !== "done") count++;
  }
  return count;
}

/** 没满足的依赖：依赖节点 satisfied 为 false，或不在图里 */
const unmetOf = (n: BoardNode, g: Graph) => [...new Set(n.deps)].filter((d) => !g.byKey.get(d)?.satisfied);

function cardOf(n: BoardNode, found: Found | undefined, g: Graph): FocusCard {
  const local = found?.kind === "local" ? found.row : null;
  const team = found?.kind === "team" ? found.row : null;
  const ev = n.lastEvent;
  return {
    nodeKey: n.key, taskId: n.taskId, oneLine: n.oneLine, missing: n.missing,
    state: stateOf(n, found), reason: n.missing ? "卡不在本项目" : found?.row.reason ?? null,
    step: stepOf(n, found), rounds: roundsOf(n),
    who: found ? found.row.who : n.handler?.agent ?? null, family: familyOf(found), machine: found ? found.row.machine : null,
    since: local ? local.since : team ? null : n.since,
    normalMinutes: local ? local.normalMinutes : null, overMinutes: local ? local.overMinutes : null,
    lastEvent: ev ? { at: ev.at, kind: ev.kind, text: ev.text } : null,
    up: n.deps.map((d) => ({ nodeKey: d, done: g.byKey.get(d)?.phase === "done" })),
    down: g.down.get(n.key) ?? [], unlock: unlockOf(n.key, g),
  };
}

const byKey = (a: { nodeKey: string }, b: { nodeKey: string }) => (a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0);

function compareCards(now: number) {
  const waited = (c: FocusCard) => (c.since === null ? -Infinity : now - c.since);
  return (a: FocusCard, b: FocusCard): number => {
    const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
    if (rank) return rank;
    let d = 0;
    if (a.state === "waiting") d = waited(b) - waited(a);
    else if (a.state === "over") d = (b.overMinutes ?? 0) - (a.overMinutes ?? 0);
    else if (a.state === "working") d = b.unlock - a.unlock || waited(b) - waited(a);
    return (Number.isNaN(d) ? 0 : d) || byKey(a, b);
  };
}

/**
 * 沿没满足的依赖往上走，到最近一个进行中或 ready 节点的层数；far 至少 2。
 * 走不到（依赖不在图里、全在环上）的给能确定的下界 2——「更远」只保证 ≥ 2。
 */
function hopsOf(start: BoardNode, g: Graph, isReady: (n: BoardNode) => boolean): number {
  const seen = new Set([start.key]);
  let layer = unmetOf(start, g);
  for (let depth = 1; layer.length; depth++) {
    const next: string[] = [];
    for (const k of layer) {
      if (seen.has(k)) continue;
      seen.add(k);
      const n = g.byKey.get(k);
      if (!n) continue;
      if (n.phase === "active" || (n.phase === "idle" && isReady(n))) return Math.max(2, depth);
      next.push(...unmetOf(n, g));
    }
    layer = next;
  }
  return 2;
}

function nextOf(nodes: BoardNode[], g: Graph, found: Map<string, Found>): FocusModel["next"] {
  const out: FocusModel["next"] = { ready: [], oneHop: [], far: [] };
  const isReady = (n: BoardNode) => unmetOf(n, g).length === 0;
  for (const n of nodes) {
    if (n.phase !== "idle") continue;
    const u = unmetOf(n, g);
    const base = { nodeKey: n.key, oneLine: n.oneLine, estimate: n.estimate, reason: null as string | null, waitsOn: u, unlock: unlockOf(n.key, g) };
    if (!u.length) {
      const f = found.get(n.key);
      out.ready.push({ ...base, reason: f?.kind === "local" && f.lane === "todo" ? f.row.reason : null, hops: 0 });
    } else if (u.every((k) => g.byKey.get(k)?.phase === "active")) out.oneHop.push({ ...base, hops: 1 });
    else out.far.push({ ...base, hops: hopsOf(n, g, isReady) });
  }
  const order = (a: IdleRow, b: IdleRow) => b.unlock - a.unlock || byKey(a, b);
  for (const list of Object.values(out)) list.sort(order);
  return out;
}

function doneOf(nodes: BoardNode[]): FocusModel["done"] {
  const done = nodes.filter((n) => n.phase === "done");
  const dated = done.filter((n) => typeof n.doneAt === "number").sort((a, b) => b.doneAt! - a.doneAt!);
  const undated = done.filter((n) => typeof n.doneAt !== "number");
  return [...dated, ...undated].map((n) => ({
    nodeKey: n.key, oneLine: n.oneLine, at: typeof n.doneAt === "number" ? n.doneAt : null, round: n.round ?? 0, cancelled: n.status === "cancelled",
  }));
}

export function subdagFocus(feature: FeatureCard, work: FocusWork | null, now: number): FocusModel {
  const nodes = Array.isArray(feature.nodes) ? feature.nodes : [];
  const g = graphOf(nodes);
  const found = rowIndex(feature.id, work);
  const active = nodes.filter((n) => n.phase === "active").map((n) => cardOf(n, found.get(n.key), g)).sort(compareCards(now));
  const done = doneOf(nodes);
  const machines: Record<string, number> = {};
  for (const c of active) if (c.machine !== null) machines[c.machine] = (machines[c.machine] ?? 0) + 1;
  const dated = done.filter((d) => d.at !== null);
  return {
    head: {
      total: nodes.length, done: done.length, idle: nodes.filter((n) => n.phase === "idle").length,
      active: active.filter((c) => c.state === "working" || c.state === "over").length,
      waiting: active.filter((c) => c.state === "owner" || c.state === "waiting").length,
      done24h: dated.length ? dated.filter((d) => d.at! >= now - DAY).length : null,
      machines,
    },
    active,
    next: nextOf(nodes, g, found),
    done,
    autoOpenDone: active.length === 0,
  };
}
