/**
 * 只读等待关系图与死锁环（DLK1）：台账事实进、带来源的有向等待图出。纯函数：不写库、不派单、不解锁、不改授权。
 * 边 = 「等待者 → 被等的」，只认三类正式事实：task_deps 上没放行的进边、各 feature 当前版子 DAG 里没满足的依赖节点、
 * auto 卡要的 fileGlobs 与别卡在 scheduler_resources 里真实持有的文件锁按 resourcesOverlap 相交。标题 / 备注 / 范围声明都不当事实。
 * 取数坏了进 unknown（不当无环）；容量槽与 task: / reviewer: 这类命名资源不构造文件等待。读侧在 ledger-deadlock-read.ts。
 */
import { blockedBy, depViews, isSatisfied, workStage, type LedgerDep } from "./ledger-deps.js";
import { resourceKey, resourcesOverlap, type WorkflowMode } from "./ledger-scheduler.js";
import { TERMINAL_STAGES, type LedgerTask, type Stage } from "./ledger-stages.js";

export type WaitCard = Pick<LedgerTask, "id" | "kind" | "stage" | "stageBefore" | "extra"> & { workflow: { mode: WorkflowMode; rev: number } | null };
interface WaitDagNode { key: string; taskId: string | null; deps: readonly string[] }
export interface WaitFeature { id: string; version: number; createdAt: number; nodes: readonly WaitDagNode[] }
export interface WaitHeld { resource: string; taskId: string; intentId: string; acquiredAt: number; scope: string }
export interface WaitFacts {
  project: string;
  /** 取数那一刻的 events 最大 seq：同一份报告里的事实都不晚于它 */
  asOfSeq: number;
  tasks: readonly WaitCard[];
  deps: readonly LedgerDep[];
  features: readonly WaitFeature[];
  held: readonly WaitHeld[];
  /** 读侧整段取不到的原因（表坏、JSON 坏） */
  unknown: readonly string[];
}

type WaitEdge =
  | { kind: "dep"; from: string; to: string; depKind: LedgerDep["kind"]; rev: number; at: number }
  | { kind: "dag"; from: string; to: string; feature: string; version: number; node: string; dep: string; at: number }
  | { kind: "resource"; from: string; to: string; wanted: string; held: string; intentId: string; at: number; workflowRev: number };

interface WaitCycle { key: string; nodes: string[]; edges: WaitEdge[]; since: number | null }
/** 活卡顺着等待边走到一个依赖都满足了、却还没建卡的 DAG 节点：chain 从 origin 到它 */
interface WaitMissing { key: string; origin: string; node: string; feature: string; nodeKey: string; chain: string[]; edges: WaitEdge[]; since: number | null }
export interface WaitGraph {
  project: string;
  asOfSeq: number;
  nodes: number;
  edges: WaitEdge[];
  cycles: WaitCycle[];
  missing: WaitMissing[];
  /** 非空 = 这张图不完整：已看到的环照报，但「这一轮没环」不能当已解开 */
  unknown: string[];
  /** 环或缺卡链太多被截断（只留前 MAX_REPORTS 条） */
  truncated: boolean;
  limits: readonly string[];
}

export const WAIT_RULES = ["wait_cycle", "wait_missing_node"] as const;
type WaitRule = (typeof WAIT_RULES)[number];
const MAX_REPORTS = 20;
/** 一个强连通分量里最多从这么多个点出发找环：大分量下 O(点 × 边) 有上限 */
const MAX_STARTS = 64;
const WAIT_LIMITS: readonly string[] = [
  "文件等待只认 auto 卡的 extra.fileGlobs 与 scheduler_resources 实际持有行；规格例外、备注里的「已审批」不当作锁已释放",
  "feature_deps 是 feature 级关系，不当等待边；跨 feature 只认 task_deps 与各 feature 当前版子 DAG",
  "容量槽（slot:）与 task: / reviewer: 命名资源只是容量，不构造文件死锁",
];
const WRITE_WAIT: readonly Stage[] = ["spec", "restate", "build", "fix"];
const isFile = (r: string): boolean => !r.includes(":") && !r.startsWith("/");
const plannedId = (feature: string, key: string): string => `${feature}#${key}`;

interface Node { id: string; card: WaitCard | null; feature?: string; nodeKey?: string; ready?: boolean }

/** 卡还在等东西：没终态、也没满足（code 上线即满足，满足后的依赖与资源都不再算等待） */
const waiting = (c: WaitCard): boolean => !TERMINAL_STAGES.includes(c.stage) && !isSatisfied(c);

function depEdges(f: WaitFacts, cards: ReadonlyMap<string, WaitCard>, unknown: string[]): WaitEdge[] {
  const views = depViews(f.deps, f.tasks);
  const out: WaitEdge[] = [];
  for (const c of f.tasks) {
    if (!waiting(c)) continue;
    for (const d of blockedBy(c.id, views)) {
      if (!cards.has(d.from)) { unknown.push(`依赖 ${d.from} → ${c.id} 的前置卡不在本项目台账`); continue; }
      out.push({ kind: "dep", from: c.id, to: d.from, depKind: d.kind, rev: d.rev, at: d.updatedAt });
    }
  }
  return out;
}

/** 当前版子 DAG：绑了卡的节点就是那张卡，没绑的是 planned 节点（feature#key）；依赖节点没满足就是一条等待边 */
function dagEdges(f: WaitFacts, cards: ReadonlyMap<string, WaitCard>, nodes: Map<string, Node>, unknown: string[]): WaitEdge[] {
  const out: WaitEdge[] = [];
  for (const feat of f.features) {
    const byKey = new Map(feat.nodes.map((n) => [n.key, n]));
    const idOf = (n: WaitDagNode) => n.taskId ?? plannedId(feat.id, n.key);
    const satisfied = (n: WaitDagNode) => !!n.taskId && !!cards.get(n.taskId) && isSatisfied(cards.get(n.taskId) as WaitCard);
    for (const n of feat.nodes) {
      if (n.taskId && !cards.has(n.taskId)) { unknown.push(`${feat.id} v${feat.version} 节点 ${n.key} 绑的卡 ${n.taskId} 不在本项目台账`); continue; }
      const deps = n.deps.map((k) => byKey.get(k));
      if (deps.some((d) => !d)) { unknown.push(`${feat.id} v${feat.version} 节点 ${n.key} 的依赖指向不存在的节点`); continue; }
      if (!n.taskId) nodes.set(idOf(n), { id: idOf(n), card: null, feature: feat.id, nodeKey: n.key, ready: deps.every((d) => satisfied(d as WaitDagNode)) });
      const card = n.taskId ? cards.get(n.taskId) as WaitCard : null;
      if (card && !waiting(card)) continue;
      for (const d of deps as WaitDagNode[]) {
        if (satisfied(d)) continue;
        out.push({ kind: "dag", from: idOf(n), to: idOf(d), feature: feat.id, version: feat.version, node: n.key, dep: d.key, at: feat.createdAt });
      }
    }
  }
  return out;
}

/** auto 卡还要拿文件锁（没开写或退回 fix）且自己没持有这份文件：与别卡真实持有的文件锁相交就是在等那张卡 */
function resourceEdges(f: WaitFacts, cards: ReadonlyMap<string, WaitCard>, unknown: string[]): WaitEdge[] {
  const held: (WaitHeld & { key: string })[] = [];
  for (const h of f.held) {
    if (!isFile(h.resource)) continue;
    const key = resourceKey(h.resource);
    if (key === null || !cards.has(h.taskId)) { unknown.push(`文件锁 ${h.resource}（${h.taskId}）名字不合法或持有卡不在本项目台账`); continue; }
    held.push({ ...h, key });
  }
  const out: WaitEdge[] = [];
  for (const c of f.tasks) {
    if (c.workflow?.mode !== "auto" || !waiting(c) || !WRITE_WAIT.includes(workStage(c))) continue;
    const raw = c.extra.fileGlobs;
    if (raw === undefined) continue; // 没登记范围：调度器自己 escalate file_scope，不是在等别人的锁
    const wanted = Array.isArray(raw) ? raw.map((g) => (typeof g === "string" ? resourceKey(g) : null)) : [null];
    if (wanted.includes(null)) { unknown.push(`${c.id} 的 extra.fileGlobs 不是合法资源名列表`); continue; }
    for (const w of new Set(wanted as string[])) {
      if (held.some((h) => h.taskId === c.id && h.key === w)) continue;
      for (const h of held) {
        if (h.taskId === c.id || !resourcesOverlap(w, h.key)) continue;
        out.push({ kind: "resource", from: c.id, to: h.taskId, wanted: w, held: h.key, intentId: h.intentId, at: h.acquiredAt, workflowRev: c.workflow.rev });
      }
    }
  }
  return out;
}

const edgeOrder = (e: WaitEdge): string => [e.from, e.to, e.kind, e.kind === "resource" ? `${e.wanted}|${e.held}` : e.kind === "dag" ? `${e.feature}|${e.node}|${e.dep}` : e.depKind].join("\u0000");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Tarjan 强连通分量（迭代版，大图不爆栈）；只留成环的分量（两个点以上，或有自环） */
function cyclicComponents(ids: readonly string[], adj: ReadonlyMap<string, string[]>): string[][] {
  const index = new Map<string, number>(), low = new Map<string, number>(), onStack = new Set<string>();
  const stack: string[] = [], out: string[][] = [];
  let next = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: [string, number][] = [[root, 0]];
    index.set(root, next); low.set(root, next++); stack.push(root); onStack.add(root);
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      const succ = adj.get(v) ?? [];
      if (i < succ.length) {
        top[1]++;
        const w = succ[i];
        if (!index.has(w)) { index.set(w, next); low.set(w, next++); stack.push(w); onStack.add(w); work.push([w, 0]); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
        continue;
      }
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u) as number, low.get(v) as number)); }
      if (low.get(v) !== index.get(v)) continue;
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop() as string; onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || succ.includes(v)) out.push(comp.sort(cmp));
    }
  }
  return out.sort((a, b) => cmp(a[0], b[0]));
}

/** 分量内从 start 出发回到 start 的最短环（BFS，邻接已排序 → 结果稳定） */
function shortestCycle(start: string, comp: ReadonlySet<string>, adj: ReadonlyMap<string, string[]>): string[] | null {
  const prev = new Map<string, string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i];
    for (const w of adj.get(v) ?? []) {
      if (!comp.has(w)) continue;
      if (w === start) {
        const path = [v];
        while (path[0] !== start) path.unshift(prev.get(path[0]) as string);
        return path;
      }
      if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
    }
  }
  return null;
}

/** 环按最小 id 旋转成规范形：同一个环不管从哪个点找到都是同一个 key（重复扫描去重） */
function canonical(path: readonly string[]): string[] {
  let at = 0;
  path.forEach((x, i) => { if (cmp(x, path[at]) < 0) at = i; });
  return [...path.slice(at), ...path.slice(0, at)];
}

const pairEdges = (edges: readonly WaitEdge[], path: readonly string[], closed: boolean): WaitEdge[] =>
  path.flatMap((v, i) => {
    const w = i + 1 < path.length ? path[i + 1] : closed ? path[0] : null;
    return w === null ? [] : edges.filter((e) => e.from === v && e.to === w);
  });
const sinceOf = (edges: readonly WaitEdge[]): number | null => (edges.length ? Math.max(...edges.map((e) => e.at)) : null);
/** 指纹只用点与边类型（加资源对）：rev / seq 漂移不换 key，换了等待方式才算新的一条 */
const signature = (edges: readonly WaitEdge[]): string =>
  encodeURIComponent(JSON.stringify(edges.map((e) => [e.from, e.kind, e.kind === "resource" ? e.held : null, e.to])));

function findCycles(ids: readonly string[], adj: ReadonlyMap<string, string[]>, edges: readonly WaitEdge[]): { cycles: WaitCycle[]; truncated: boolean } {
  const seen = new Map<string, WaitCycle>();
  let truncated = false;
  for (const comp of cyclicComponents(ids, adj)) {
    const members = new Set(comp);
    if (comp.length > MAX_STARTS) truncated = true;
    for (const start of comp.slice(0, MAX_STARTS)) {
      const path = shortestCycle(start, members, adj);
      if (!path) continue;
      const nodes = canonical(path);
      const id = nodes.join(">");
      if (seen.has(id)) continue;
      const es = pairEdges(edges, nodes, true);
      seen.set(id, { key: signature(es), nodes, edges: es, since: sinceOf(es) });
    }
  }
  const cycles = [...seen.values()].sort((a, b) => a.nodes.length - b.nodes.length || cmp(a.key, b.key));
  return { cycles: cycles.slice(0, MAX_REPORTS), truncated: truncated || cycles.length > MAX_REPORTS };
}

/** 活卡（开工后、没满足、含 blocked）顺边 BFS，停在第一个「依赖都满足却没建卡」的节点；没到开工条件的 planned 节点只是路过 */
function findMissing(f: WaitFacts, nodes: ReadonlyMap<string, Node>, adj: ReadonlyMap<string, string[]>, edges: readonly WaitEdge[]): WaitMissing[] {
  const best = new Map<string, WaitMissing>();
  for (const c of f.tasks) {
    if (c.stage === "spec" || !waiting(c)) continue;
    const prev = new Map<string, string>([[c.id, ""]]);
    const queue = [c.id];
    for (let i = 0; i < queue.length; i++) {
      for (const w of adj.get(queue[i]) ?? []) {
        if (prev.has(w)) continue;
        prev.set(w, queue[i]);
        const n = nodes.get(w);
        if (!n || n.card || !n.ready) { queue.push(w); continue; }
        const chain = [w];
        while (chain[0] !== c.id) chain.unshift(prev.get(chain[0]) as string);
        const old = best.get(w);
        if (old && old.chain.length <= chain.length) continue;
        const es = pairEdges(edges, chain, false);
        best.set(w, { key: `${w}<${c.id}`, origin: c.id, node: w, feature: n.feature as string, nodeKey: n.nodeKey as string, chain, edges: es, since: sinceOf(es) });
      }
    }
  }
  return [...best.values()].sort((a, b) => cmp(a.node, b.node));
}

export function waitGraph(f: WaitFacts): WaitGraph {
  const unknown = [...f.unknown];
  const cards = new Map(f.tasks.map((c) => [c.id, c]));
  const nodes = new Map<string, Node>(f.tasks.map((c) => [c.id, { id: c.id, card: c }]));
  const all = [...depEdges(f, cards, unknown), ...dagEdges(f, cards, nodes, unknown), ...resourceEdges(f, cards, unknown)];
  const edges = [...new Map(all.map((e) => [edgeOrder(e), e])).entries()].sort((a, b) => cmp(a[0], b[0])).map(([, e]) => e);
  const adj = new Map<string, string[]>();
  for (const e of edges) if (!adj.get(e.from)?.includes(e.to)) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  for (const list of adj.values()) list.sort(cmp);
  const ids = [...nodes.keys()].sort(cmp);
  const { cycles, truncated } = findCycles(ids, adj, edges);
  const missing = findMissing(f, nodes, adj, edges);
  return {
    project: f.project, asOfSeq: f.asOfSeq, nodes: nodes.size, edges, cycles, missing: missing.slice(0, MAX_REPORTS),
    unknown: [...new Set(unknown)].sort(cmp), truncated: truncated || missing.length > MAX_REPORTS, limits: WAIT_LIMITS,
  };
}

/** 一条边的人话：带类型与来源（rev / 版本 / 持锁 intent） */
function edgeText(e: WaitEdge): string {
  if (e.kind === "dep") return `-依赖(${e.depKind} rev${e.rev})->`;
  if (e.kind === "dag") return `-DAG(${e.feature} v${e.version} ${e.node}→${e.dep})->`;
  return `-文件(${e.wanted}⇄${e.held} intent ${e.intentId} wf rev${e.workflowRev})->`;
}

function chainText(path: readonly string[], edges: readonly WaitEdge[], closed: boolean): string {
  const parts = [path[0]];
  path.forEach((v, i) => {
    const w = i + 1 < path.length ? path[i + 1] : closed ? path[0] : null;
    if (w === null) return;
    parts.push(edges.filter((e) => e.from === v && e.to === w).map(edgeText).join("/"), w);
  });
  return parts.join(" ");
}

interface WaitFindingDraft { rule: WaitRule; taskId: string | null; since: number; keyParts: string[]; detail: string; suggestion: string }
export interface WaitAudit { findings: WaitFindingDraft[]; evaluated: WaitRule[]; skipped: { rule: WaitRule; reason: string }[] }

/**
 * 等待图 → 巡检发现（ledger-audit.ts 薄调用，落库 / 去重 / 通知准入照旧走 audit 那一套）。
 * 图里有 unknown 或截断：已看到的照报，但两条规则都不进 evaluated，免得取数坏了把上一轮的环误标成已解开。
 */
export function waitAudit(g: WaitGraph | undefined, now: number): WaitAudit {
  if (!g) return { findings: [], evaluated: [], skipped: [] };
  const tail = `（as of #${g.asOfSeq}；只读诊断，不解锁、不派单）`;
  const findings: WaitFindingDraft[] = g.cycles.map((c) => ({
    rule: "wait_cycle", taskId: c.nodes.find((n) => !n.includes("#")) ?? null, since: c.since ?? now, keyParts: [c.key],
    detail: `等待环 ${chainText(c.nodes, c.edges, true)}`.slice(0, 600) + tail,
    suggestion: "PM 核对环上哪条等待该先解开（改依赖 / 调范围 / 收回锁由人定），巡检不执行恢复",
  }));
  for (const m of g.missing) findings.push({
    rule: "wait_missing_node", taskId: m.origin, since: m.since ?? now, keyParts: [m.key],
    detail: `${m.origin} 在等还没建卡的 DAG 节点 ${m.feature} ${m.nodeKey}：${chainText(m.chain, m.edges, false)}`.slice(0, 600) + tail,
    suggestion: "给该节点建卡并 dag-bind，或改 DAG 去掉这条依赖",
  });
  if (!g.unknown.length && !g.truncated) return { findings, evaluated: [...WAIT_RULES], skipped: [] };
  const reason = `等待图取数不完整：${[...g.unknown, ...(g.truncated ? ["环或缺卡链查找/报告已截断"] : [])].join("；").slice(0, 300)}`;
  return { findings, evaluated: [], skipped: WAIT_RULES.map((rule) => ({ rule, reason })) };
}

/** CLI 同时投影完整图，通知摘要可缩短，但诊断必须保留每条来源与闭环。 */
export function waitDiagnostics(g: WaitGraph | undefined): { waitGraph?: WaitGraph } {
  return g ? { waitGraph: g } : {};
}
