import { activeProjectPm } from "./pm-role.js";
import { schedulerV2SkipFeature, schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
/** Facts are read again by the leased CLI immediately before claiming an episode action. */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews, isSatisfied } from "./ledger-deps.js";
import { effectiveNodes, getDagVersion, getFeature, type Feature } from "./ledger-feature.js";
import { getTask, getMeta, listDeps, listEvents, toTask, toEvent } from "./ledger-store.js";
import { listAsks, hasAsksTable } from "./ledger-asks.js";
import { priorityRecord, readPriority, priorityHistory } from "./ledger-priority-read.js";
import type { PriorityTarget } from "./ledger-priority-types.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { featurePm } from "./scheduler-autostart.js";
import { isPriorityStallProgress, type StallBasis } from "./ledger-priority-stall.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";

interface Facts {
  tasks: Map<string, LedgerTask>;
  deps: ReturnType<typeof listDeps>;
  events: Map<string, LedgerEvent[]>;
  priority: LedgerEvent[];
  waits: Map<string, LedgerEvent>;
  asks: ReturnType<typeof listAsks>;
  pms: Set<string>;
}

type Band = "now" | "next" | "later" | null;

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

function askFor(facts: Facts, taskId: string | null, pm: string | null) {
  const ask = facts.asks.find((a) => a.taskId === taskId && !!a.assignee && (facts.pms.has(a.assignee) || a.assignee === pm));
  return ask ? { id: ask.id, question: ask.body || ask.title } : undefined;
}

function dependencyReleased(facts: Facts, e: LedgerEvent, upstream: string): boolean {
  if (e.target !== upstream || e.kind !== "stage" || typeof e.data.to !== "string" || typeof e.data.from !== "string") return false;
  const t = facts.tasks.get(upstream);
  return !!t && isSatisfied({ ...t, stage: e.data.to as Stage, stageBefore: null })
    && !isSatisfied({ ...t, stage: e.data.from as Stage, stageBefore: null });
}

function taskBasis(db: Database, project: string, taskId: string, facts: Facts): StallBasis {
  const t = getTask(db, taskId)!;
  const target: PriorityTarget = { kind: "task", id: taskId }, record = priorityRecord(db, project, target);
  const effective = readPriority(db, project, target), f = t.featureId ? getFeature(db, t.featureId) : null;
  const incoming = facts.deps.filter((d) => d.to === taskId && d.state === null);
  const candidates = [...(facts.events.get(taskId) ?? []).filter(isPriorityStallProgress),
    ...incoming.flatMap((d) => (facts.events.get(d.from) ?? []).filter((e) => dependencyReleased(facts, e, d.from)))];
  const progress = candidates.sort((a, b) => a.seq - b.seq).at(-1);
  const edges = facts.deps.filter((d) => d.to === taskId);
  const deps = blockedBy(taskId, depViews(edges, edges.flatMap((d) => facts.tasks.get(d.from) ?? [])));
  const pm = t.pm ?? (f ? featurePm(db, f.id) : activeProjectPm(db, project));
  const ask = askFor(facts, taskId, pm), frozen = getMeta(db, project).queueFrozen.frozen;
  const why = ask ? `等 PM 答 ask ${ask.id}` : frozen ? "项目合并队列冻结" : f?.status !== undefined && f.status !== "active"
    ? `feature 是 ${f.status}` : deps.length ? `依赖没满足：${deps.map((d) => d.from).join(", ")}` : `阶段 ${t.stage} 无有效推进`;
  return { project, key: record?.id ?? `task:${taskId}`, label: taskId, taskId, featureId: t.featureId ?? null, stage: t.stage, why, pm, ask, frozen,
    eligible: effective.effective === "now" && !["done", "cancelled", "verified"].includes(t.stage),
    since: progress?.ts ?? t.createdAt, progress: `event:${progress?.seq ?? 0}`,
    nowSince: nowEpoch(facts.priority, record?.id ?? null, t.featureId ?? null, t.createdAt) };
}

function plannedBases(db: Database, f: Feature, facts: Facts, key?: string): StallBasis[] {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!v) return [];
  const lanes = featureLanes(db, f), frozen = getMeta(db, f.project).queueFrozen.frozen;
  return effectiveNodes(db, v).filter((n) => !n.taskId).flatMap((n) => {
    const target: PriorityTarget = { kind: "node", id: f.id, nodeKey: n.key }, r = priorityRecord(db, f.project, target);
    if (key && key !== (r?.id ?? `node:${f.id}:${n.key}`)) return [];
    if (!key && readPriority(db, f.project, target).effective !== "now") return [];
    const waiting = lanes?.waiting.find((w) => w.key === n.key);
    // Only actual upstream results count, never a feature's title edit, observation or another node's progress.
    const deps = effectiveNodes(db, v).filter((d) => n.deps.includes(d.key));
    const progress = deps.flatMap((d) => d.taskId ? (facts.events.get(d.taskId) ?? []).filter((e) => dependencyReleased(facts, e, d.taskId!)) : [])
      .sort((a, b) => a.seq - b.seq).at(-1);
    const recorded = facts.waits.get(`${f.id}/${n.key}`);
    const why = frozen ? "项目合并队列冻结" : f.status !== "active" ? `feature 是 ${f.status}` : waiting
      ? `${waiting.why === "deps" ? "依赖没满足" : waiting.why === "files" ? "文件锁阻塞" : "没有文件范围"}：${waiting.on.join(", ")}`
      : typeof recorded?.data.why === "string" ? recorded.data.why : "已满足依赖，等自动开工资格复核";
    return { project: f.project, key: r?.id ?? `node:${f.id}:${n.key}`, label: `${f.id}/${n.key}`, taskId: null, featureId: f.id, stage: "planned", why, pm: featurePm(db, f.id), frozen,
      eligible: !["done", "dropped"].includes(f.status) && readPriority(db, f.project, target).effective === "now",
      since: progress?.ts ?? f.createdAt, progress: `event:${progress?.seq ?? 0}`,
      nowSince: nowEpoch(facts.priority, r?.id ?? null, f.id, f.createdAt) };
  });
}

/** Index events once per project; keyed CLI rechecks read only that target's relevant events. */
export function priorityStallBases(db: Database, project: string, key?: string): StallBasis[] {
  const lookup = db.query("SELECT taskId,featureId FROM priority_records WHERE project=? AND id=?");
  const record = (key ? lookup.get(project, key) : null) as { taskId: string | null; featureId: string | null } | null;
  const taskId = record?.taskId ?? (key?.startsWith("task:") ? key.slice(5) : null);
  const rows = key ? db.query("SELECT * FROM tasks WHERE project=? AND id=?").all(project, taskId ?? "")
    : db.query("SELECT * FROM tasks WHERE project=? AND stage NOT IN ('done','cancelled')").all(project);
  const selected = (rows as Record<string, unknown>[]).map(toTask).filter((t) => key
    || readPriority(db, project, { kind: "task", id: t.id }).effective === "now");
  const deps = listDeps(db, project), selectedIds = new Set(selected.map((t) => t.id));
  const features = (db.query("SELECT id FROM features WHERE project=? AND status NOT IN ('done','dropped')").all(project) as { id: string }[])
    .filter(({ id }) => !taskId && (!key || !record?.featureId || record.featureId === id) && !schedulerV2SkipFeature(db, id));
  const relevant = new Set(selectedIds);
  for (const d of deps) if (selectedIds.has(d.to)) relevant.add(d.from);
  // Only dependencies in a current DAG can release a planned node's clock.
  for (const { id } of features) {
    const f = getFeature(db, id)!, v = f.currentVersion ? getDagVersion(db, id, f.currentVersion) : null;
    if (v) for (const n of effectiveNodes(db, v)) if (n.taskId) relevant.add(n.taskId);
  }
  const tasks = new Map(selected.map((t) => [t.id, t]));
  for (const id of relevant) if (!tasks.has(id)) { const t = getTask(db, id); if (t) tasks.set(id, t); }
  const facts: Facts = { tasks, deps, events: new Map(), priority: [], waits: new Map(),
    asks: hasAsksTable(db) ? listAsks(db, { project, states: ["open"] }) : [], pms: new Set(getMeta(db, project).pms) };
  const waits = key && !taskId ? (db.query(`SELECT * FROM events WHERE project=? AND json_extract(data,'$.namespace')='priority-now'
    AND json_extract(data,'$.featureId')=? ORDER BY seq`).all(project, record?.featureId ?? "") as Record<string, unknown>[]).map(toEvent) : [];
  const history = key ? [...priorityHistory(db, project), ...waits, ...[...relevant].flatMap((target) => listEvents(db, { project, target }))]
    .sort((a, b) => a.seq - b.seq) : listEvents(db, { project });
  for (const e of history) {
    if (e.data.namespace === "priority") facts.priority.push(e);
    if (e.data.namespace === "priority-now") facts.waits.set(`${e.data.featureId}/${e.data.key}`, e);
    if (relevant.has(e.target) && (isPriorityStallProgress(e) || e.kind === "stage")) {
      const events = facts.events.get(e.target) ?? [];
      events.push(e); facts.events.set(e.target, events);
    }
  }
  return [...selected.filter((t) => !schedulerV2SkipTask(db, t.id)).map((t) => taskBasis(db, project, t.id, facts)),
    ...features.flatMap(({ id }) => plannedBases(db, getFeature(db, id)!, facts, key))];
}
