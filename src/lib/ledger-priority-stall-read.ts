import { activeProjectPm } from "./pm-role.js";
import { schedulerV2SkipFeature, schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
/** Facts are read again by the leased CLI immediately before claiming an episode action. */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews, derivedState, isSatisfied, type DepState, type LedgerDep } from "./ledger-deps.js";
import { effectiveNodes, getDagVersion, getFeature, type DagNode, type Feature } from "./ledger-feature.js";
import { getTask, getMeta, listDeps, listEvents, toTask } from "./ledger-store.js";
import { listAsks, hasAsksTable } from "./ledger-asks.js";
import { priorityRecord, readPriority } from "./ledger-priority-read.js";
import type { PriorityTarget } from "./ledger-priority-types.js";
import { featureLanes, type Lanes } from "./dag-tools-lanes.js";
import { featurePm } from "./scheduler-autostart.js";
import { isPriorityStallProgress, PRIORITY_STALL_MS, type StallBasis, type StallBlock } from "./ledger-priority-stall.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";

interface Graph {
  f: Feature; nodes: DagNode[]; lanes: Lanes | null;
  versions?: { at: number; nodes: DagNode[]; bound: Map<string, { taskId: string; boundAt: number }> }[];
}
interface Facts {
  tasks: Map<string, LedgerTask | null>;
  graphs: Map<string, Graph | null>;
  deps: ReturnType<typeof listDeps>;
  events: Map<string, LedgerEvent[]>;
  /** dep add / set / rm events by `from>to` */
  edges: Map<string, LedgerEvent[]>;
  priority: LedgerEvent[];
  waits: Map<string, LedgerEvent>;
  asks: ReturnType<typeof listAsks>;
  pms: Set<string>;
  frozen: boolean;
  now: number;
  threshold: number;
  lend: boolean;
}
/**
 * An unmet upstream: another object to chase, or a graph configuration problem that nobody can progress.
 * at = when this dependency edge took effect, so a chased upstream's window never predates the reference that put it on a now chain.
 */
type Upstream = ({ task: string } | { node: DagNode; g: Graph } | { config: string }) & { at: number };
/** own = the object itself is a non-terminal now target */
interface Built { b: StallBasis; ups: Upstream[]; own: boolean; terminal: boolean }

type Band = "now" | "next" | "later" | null;

export function priorityStallThreshold(db: Database, project: string): number {
  const row = db.query("SELECT value FROM meta WHERE project=? AND key='priorityStallMs'").get(project) as { value: string } | null;
  return row ? Number(JSON.parse(row.value)) : PRIORITY_STALL_MS;
}

/** Replay only priority decisions, so a lower-and-raise between two scheduler ticks still starts a new episode. */
function nowEpoch(events: LedgerEvent[], recordId: string | null, featureId: string | null, fallback: number): number {
  let own: Band = null, parent: Band = null, since = fallback;
  for (const e of events) {
    if (e.data.namespace !== "priority" || !["set", "clear"].includes(String(e.data.op))) continue;
    const loc = e.data.location as { id?: string; kind?: string; featureId?: string } | undefined;
    const work = e.data.recordId === recordId, feature = loc?.kind === "feature" && loc.featureId === featureId;
    if (!work && !feature) continue;
    const before = own ?? parent ?? "next";
    const after = e.data.after as { explicit?: Band };
    if (work) own = after.explicit ?? null;
    else parent = after.explicit ?? null;
    if ((own ?? parent ?? "next") === "now" && before !== "now") since = e.ts;
  }
  return since;
}

function task(db: Database, facts: Facts, id: string): LedgerTask | null {
  if (!facts.tasks.has(id)) facts.tasks.set(id, getTask(db, id));
  return facts.tasks.get(id)!;
}

function graph(db: Database, facts: Facts, id: string): Graph | null {
  if (facts.graphs.has(id)) return facts.graphs.get(id)!;
  const f = getFeature(db, id), v = f?.currentVersion ? getDagVersion(db, id, f.currentVersion) : null;
  const g = f && v ? { f, nodes: effectiveNodes(db, v), lanes: featureLanes(db, f) } : null;
  facts.graphs.set(id, g);
  return g;
}

function askFor(facts: Facts, taskId: string | null, pm: string | null) {
  const ask = facts.asks.find((a) => a.taskId === taskId && !!a.assignee && (facts.pms.has(a.assignee) || a.assignee === pm));
  return ask ? { id: ask.id, question: ask.body || ask.title } : undefined;
}

function dependencyReleased(db: Database, facts: Facts, e: LedgerEvent, upstream: string): boolean {
  if (e.target !== upstream || e.kind !== "stage" || typeof e.data.to !== "string" || typeof e.data.from !== "string") return false;
  const t = task(db, facts, upstream);
  return !!t && isSatisfied({ ...t, stage: e.data.to as Stage, stageBefore: null })
    && !isSatisfied({ ...t, stage: e.data.from as Stage, stageBefore: null });
}

/** A build/fix card whose claimed lend order holds an unexpired lease and beat within one window is being worked on. */
function liveBeat(db: Database, facts: Facts, t: LedgerTask): { orderId: string; beatAt: number } | null {
  if (!facts.lend || !["build", "fix"].includes(t.stage)) return null;
  const o = db.query(`SELECT orderId, leaseUntil, beatAt FROM lend_orders WHERE taskId=? AND status='claimed' AND step IN ('write','fix')
    ORDER BY updatedAt DESC LIMIT 1`).get(t.id) as { orderId: string; leaseUntil: number | null; beatAt: number | null } | null;
  if (!o || (o.leaseUntil ?? 0) <= facts.now || o.beatAt === null || facts.now - o.beatAt >= facts.threshold) return null;
  return { orderId: o.orderId, beatAt: o.beatAt };
}

/**
 * A hop references its upstream only while it stays unmet. Replay the upstream's stage moves (and the edge's own state overrides) and
 * return the start of the current unmet run, never before `start` (when the edge or binding took effect): re-opening a done edge or an
 * upstream sliding back from live puts it on the now chain afresh.
 */
function unmetSince(facts: Facts, t: LedgerTask, start: number, dep?: LedgerDep): number {
  const moves = [...(facts.events.get(t.id) ?? []).filter((e) => e.kind === "stage"), ...(dep ? facts.edges.get(`${dep.from}>${dep.to}`) ?? [] : [])]
    .sort((a, b) => a.seq - b.seq);
  const first = moves.find((e) => e.kind === "stage");
  let stage = (typeof first?.data.from === "string" ? first.data.from : t.stage) as Stage, stageBefore: Stage | null = null;
  let state: DepState | null = null, since = start;
  const unmet = () => {
    const from = { kind: t.kind, stage, stageBefore };
    return dep ? (state ?? derivedState(dep.kind, from)) !== "done" : !isSatisfied(from);
  };
  for (const e of moves) {
    const was = unmet();
    if (e.kind === "dep") state = (e.data.state as DepState | null | undefined) ?? null;
    else if (typeof e.data.to === "string") { stageBefore = e.data.to === "blocked" ? e.data.from as Stage : null; stage = e.data.to as Stage; }
    if (!was && unmet()) since = Math.max(start, e.ts);
  }
  return since;
}

/** Upstreams that can still move are chased; missing, cancelled or released-but-unselected ones are graph configuration. */
function taskUpstream(db: Database, facts: Facts, id: string, why: string, at: number, dep?: LedgerDep): Upstream {
  const t = task(db, facts, id);
  if (!t) return { config: `前置卡 ${id} 不存在`, at };
  if (t.stage === "cancelled") return { config: `前置卡 ${id} 已取消`, at };
  if (isSatisfied(t) || t.stage === "done") return { config: `前置卡 ${id} 已满足但${why}`, at };
  return { task: id, at: unmetSince(facts, t, at, dep) };
}

/**
 * The node edge points at its current upstream (node, or the card bound to it) since the oldest version of the unbroken run, back from
 * the current one, that carries both the edge and that binding; a card bound later via dag_bindings is referenced from its boundAt.
 */
function nodeEdgeSince(db: Database, g: Graph, key: string, dep: string, taskId: string | null): number {
  g.versions ??= (db.query("SELECT version FROM dag_versions WHERE featureId=? AND version<=? ORDER BY version DESC").all(g.f.id, g.f.currentVersion) as { version: number }[])
    .flatMap(({ version }) => {
      const v = getDagVersion(db, g.f.id, version);
      if (!v) return [];
      const rows = db.query("SELECT nodeKey, taskId, boundAt FROM dag_bindings WHERE featureId=? AND version=?").all(g.f.id, version) as { nodeKey: string; taskId: string; boundAt: number }[];
      return [{ at: v.createdAt, nodes: v.nodes, bound: new Map(rows.map((r) => [r.nodeKey, r])) }];
    });
  let at = g.versions[0]?.at ?? g.f.createdAt;
  for (const v of g.versions) {
    const snap = v.nodes.find((n) => n.key === dep)?.taskId, row = snap ? undefined : v.bound.get(dep);
    if (!v.nodes.some((n) => n.key === key && n.deps.includes(dep)) || (snap || row?.taskId || null) !== taskId) break;
    at = Math.max(v.at, row?.boundAt ?? 0);
  }
  return at;
}

function taskBasis(db: Database, project: string, taskId: string, facts: Facts): Built {
  const t = task(db, facts, taskId)!;
  const target: PriorityTarget = { kind: "task", id: taskId }, record = priorityRecord(db, project, target);
  const effective = readPriority(db, project, target), f = t.featureId ? getFeature(db, t.featureId) : null;
  const incoming = facts.deps.filter((d) => d.to === taskId && d.state === null);
  const candidates = [...(facts.events.get(taskId) ?? []).filter(isPriorityStallProgress),
    ...incoming.flatMap((d) => (facts.events.get(d.from) ?? []).filter((e) => dependencyReleased(db, facts, e, d.from)))];
  const progress = candidates.sort((a, b) => a.seq - b.seq).at(-1), beat = liveBeat(db, facts, t);
  const edges = facts.deps.filter((d) => d.to === taskId);
  const deps = blockedBy(taskId, depViews(edges, edges.flatMap((d) => task(db, facts, d.from) ?? [])));
  const pm = t.pm ?? (f ? featurePm(db, f.id) : activeProjectPm(db, project));
  const ask = askFor(facts, taskId, pm), frozen = facts.frozen;
  const block: StallBlock = ask ? { kind: "ask", on: [] } : frozen ? { kind: "frozen", on: [] }
    : f?.status !== undefined && f.status !== "active" ? { kind: "feature", on: [] }
    : deps.length ? { kind: "deps", on: deps.map((d) => d.from) } : { kind: "progress", on: [] };
  const why = ask ? `等 PM 答 ask ${ask.id}` : frozen ? "项目合并队列冻结" : block.kind === "feature"
    ? `feature 是 ${f!.status}` : deps.length ? `依赖没满足：${deps.map((d) => d.from).join(", ")}` : `阶段 ${t.stage} 无有效推进`;
  const ups = block.kind !== "deps" ? [] : deps.map((d) => d.kind === "branch" && d.derived === "active"
    ? { config: `分叉 ${d.from} → ${taskId} 没选定`, at: d.createdAt } : taskUpstream(db, facts, d.from, "边未放行", d.createdAt, d));
  const terminal = ["done", "cancelled", "verified"].includes(t.stage), own = effective.effective === "now" && !terminal;
  const event = progress?.ts ?? t.createdAt;
  return { own, terminal, ups, b: { project, key: record?.id ?? `task:${taskId}`, label: taskId, taskId, featureId: t.featureId ?? null, nodeKey: null,
    stage: t.stage, why, pm, ask, frozen, block, impact: [], eligible: own,
    // A live executor counts as progress for this round only; ledger events stay the durable clock.
    since: beat ? Math.max(event, beat.beatAt) : event, progress: `event:${progress?.seq ?? 0}${beat ? `|beat:${beat.orderId}:${beat.beatAt}` : ""}`,
    nowSince: nowEpoch(facts.priority, record?.id ?? null, t.featureId ?? null, t.createdAt) } };
}

function nodeBasis(db: Database, g: Graph, n: DagNode, facts: Facts): Built {
  const { f, lanes } = g, frozen = facts.frozen;
  const target: PriorityTarget = { kind: "node", id: f.id, nodeKey: n.key }, r = priorityRecord(db, f.project, target);
  const waiting = lanes?.waiting.find((w) => w.key === n.key);
  // Only actual upstream results count, never a feature's title edit, observation or another node's progress.
  const deps = g.nodes.filter((d) => n.deps.includes(d.key));
  const progress = deps.flatMap((d) => d.taskId ? (facts.events.get(d.taskId) ?? []).filter((e) => dependencyReleased(db, facts, e, d.taskId!)) : [])
    .sort((a, b) => a.seq - b.seq).at(-1);
  const recorded = facts.waits.get(`${f.id}/${n.key}`);
  const block: StallBlock = frozen ? { kind: "frozen", on: [] } : f.status !== "active" ? { kind: "feature", on: [] }
    : waiting ? { kind: waiting.why, on: waiting.on } : { kind: "progress", on: [] };
  const why = frozen ? "项目合并队列冻结" : f.status !== "active" ? `feature 是 ${f.status}` : waiting
    ? `${waiting.why === "deps" ? "依赖没满足" : waiting.why === "files" ? "文件锁阻塞" : "没有文件范围"}：${waiting.on.join(", ")}`
    : typeof recorded?.data.why === "string" ? recorded.data.why : "已满足依赖，等自动开工资格复核";
  const ups: Upstream[] = block.kind !== "deps" ? [] : block.on.map((k) => {
    const d = g.nodes.find((x) => x.key === k), at = nodeEdgeSince(db, g, n.key, k, d?.taskId ?? null);
    if (!d) return { config: `前置节点 ${f.id}/${k} 不在图里`, at };
    return d.taskId ? taskUpstream(db, facts, d.taskId, "节点未放行", at) : { node: d, g, at };
  });
  const terminal = ["done", "dropped"].includes(f.status), own = !terminal && readPriority(db, f.project, target).effective === "now";
  return { own, terminal, ups, b: { project: f.project, key: r?.id ?? `node:${f.id}:${n.key}`, label: `${f.id}/${n.key}`, taskId: null, featureId: f.id,
    nodeKey: n.key, stage: "planned", why, pm: featurePm(db, f.id), frozen, block, impact: [], eligible: own,
    since: progress?.ts ?? f.createdAt, progress: `event:${progress?.seq ?? 0}`,
    nowSince: nowEpoch(facts.priority, r?.id ?? null, f.id, f.createdAt) } };
}

/**
 * One rule for the tick and the keyed CLI: an object blocked only by unmet dependencies is not itself stalled; its chain is followed
 * to the first upstream that is not just waiting, which gains monitoring (not a priority) however many now objects reference it.
 */
export function priorityStallBases(db: Database, project: string, key?: string, now = Date.now()): StallBasis[] {
  const lookup = db.query("SELECT taskId,featureId FROM priority_records WHERE project=? AND id=?");
  const record = (key ? lookup.get(project, key) : null) as { taskId: string | null; featureId: string | null } | null;
  const keyedTask = record?.taskId ?? (key?.startsWith("task:") ? key.slice(5) : null);
  const rows = (db.query("SELECT * FROM tasks WHERE project=? AND stage NOT IN ('done','cancelled')").all(project) as Record<string, unknown>[]).map(toTask);
  if (keyedTask && !rows.some((t) => t.id === keyedTask)) rows.push(...(db.query("SELECT * FROM tasks WHERE project=? AND id=?").all(project, keyedTask) as Record<string, unknown>[]).map(toTask));
  const lendCols = db.query("PRAGMA table_info(lend_orders)").all() as { name: string }[];
  const facts: Facts = { tasks: new Map(rows.map((t) => [t.id, t])), graphs: new Map(), deps: listDeps(db, project), events: new Map(), edges: new Map(), priority: [], waits: new Map(),
    asks: hasAsksTable(db) ? listAsks(db, { project, states: ["open"] }) : [], pms: new Set(getMeta(db, project).pms),
    frozen: getMeta(db, project).queueFrozen.frozen, now, threshold: priorityStallThreshold(db, project), lend: lendCols.some((c) => c.name === "beatAt") };
  for (const e of listEvents(db, { project })) {
    if (e.data.namespace === "priority") facts.priority.push(e);
    if (e.data.namespace === "priority-now") facts.waits.set(`${e.data.featureId}/${e.data.key}`, e);
    if (e.kind === "dep") {
      const k = `${e.data.from}>${e.target}`, edges = facts.edges.get(k) ?? [];
      edges.push(e); facts.edges.set(k, edges);
    }
    if (isPriorityStallProgress(e) || e.kind === "stage") {
      const events = facts.events.get(e.target) ?? [];
      events.push(e); facts.events.set(e.target, events);
    }
  }
  const memo = new Map<string, Built>(), roots: Built[] = [];
  const build = (id: string, make: () => Built) => { if (!memo.has(id)) memo.set(id, make()); return memo.get(id)!; };
  const ofTask = (id: string) => schedulerV2SkipTask(db, id) || !task(db, facts, id) ? null : build(`t:${id}`, () => taskBasis(db, project, id, facts));
  const ofNode = (g: Graph, n: DagNode) => build(`n:${g.f.id}/${n.key}`, () => nodeBasis(db, g, n, facts));
  for (const t of rows) {
    if (t.id !== keyedTask && readPriority(db, project, { kind: "task", id: t.id }).effective !== "now") continue;
    const built = ofTask(t.id);
    if (built) roots.push(built);
  }
  const features = (db.query("SELECT id FROM features WHERE project=? AND status NOT IN ('done','dropped')").all(project) as { id: string }[])
    .filter(({ id }) => !schedulerV2SkipFeature(db, id));
  for (const { id } of features) {
    const g = graph(db, facts, id);
    for (const n of g?.nodes.filter((n) => !n.taskId) ?? []) {
      const nodeKey = priorityRecord(db, project, { kind: "node", id, nodeKey: n.key })?.id ?? `node:${id}:${n.key}`;
      if (nodeKey !== key && readPriority(db, project, { kind: "node", id, nodeKey: n.key }).effective !== "now") continue;
      roots.push(ofNode(g!, n));
    }
  }
  const watched: Built[] = [], earliest = new Map<Built, number>();
  for (const root of roots) {
    if (!root.own || root.b.block.kind !== "deps") continue;
    root.b.eligible = false;
    // A path is referenced by the now chain only since its latest edge took effect (and the root became now), so the reference epoch
    // is the max along the path and the min over paths; a node reached again through an earlier-referenced path is relaxed again.
    const config: string[] = [], best = new Map<Built, number>([[root, root.b.nowSince]]);
    const queue = root.ups.map((up) => ({ up, since: Math.max(root.b.nowSince, up.at) }));
    for (let i = 0; i < queue.length; i++) {
      const { up, since } = queue[i]!;
      if ("config" in up) { config.push(up.config); continue; }
      const u = "task" in up ? ofTask(up.task) : ofNode(up.g, up.node);
      if (!u || u.terminal || (best.get(u) ?? Infinity) <= since) continue;
      best.set(u, since);
      if (u.b.block.kind === "deps") { queue.push(...u.ups.map((x) => ({ up: x, since: Math.max(since, x.at) }))); continue; }
      if (!u.b.impact.includes(root.b.label)) u.b.impact.push(root.b.label);
      if (!u.own) earliest.set(u, Math.min(earliest.get(u) ?? Infinity, since));
      if (!watched.includes(u)) watched.push(u);
    }
    // A broken graph has nobody to chase: the waiting object itself carries a note-only episode.
    if (config.length) { root.b.eligible = true; root.b.config = [...new Set(config)].join("；"); }
  }
  for (const [u, since] of earliest) { u.b.eligible = true; u.b.nowSince = since; }
  const out = [...new Set([...roots, ...watched])].map((x) => x.b);
  return key ? out.filter((b) => b.key === key) : out;
}
