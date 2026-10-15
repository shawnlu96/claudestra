import { activeProjectPm } from "./pm-role.js";
import { schedulerV2SkipFeature, schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
/** Facts are read again by the leased CLI immediately before claiming an episode action. */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews, isSatisfied } from "./ledger-deps.js";
import { effectiveNodes, getDagVersion, getFeature, type Feature } from "./ledger-feature.js";
import { getTask, getMeta, listDeps, listEvents, listTasks } from "./ledger-store.js";
import { listAsks, hasAsksTable } from "./ledger-asks.js";
import { priorityRecord, readPriority } from "./ledger-priority-read.js";
import type { PriorityTarget } from "./ledger-priority-types.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { featurePm } from "./scheduler-autostart.js";
import { isPriorityStallProgress, type StallBasis } from "./ledger-priority-stall.js";
import type { LedgerEvent, Stage } from "./ledger-stages.js";

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

function askFor(db: Database, taskId: string | null, pm: string | null) {
  if (!taskId || !pm || !hasAsksTable(db)) return undefined;
  const ask = listAsks(db, { project: getTask(db, taskId)!.project, states: ["open"] }).find((a) => a.taskId === taskId && a.assignee === pm);
  return ask ? { id: ask.id, question: ask.body || ask.title } : undefined;
}

function dependencyReleased(db: Database, e: LedgerEvent, upstream: string): boolean {
  if (e.target !== upstream || e.kind !== "stage" || typeof e.data.to !== "string" || typeof e.data.from !== "string") return false;
  const t = getTask(db, upstream);
  return !!t && isSatisfied({ ...t, stage: e.data.to as Stage, stageBefore: null })
    && !isSatisfied({ ...t, stage: e.data.from as Stage, stageBefore: null });
}

function taskBasis(db: Database, project: string, taskId: string, events: LedgerEvent[]): StallBasis {
  const t = getTask(db, taskId)!;
  const target: PriorityTarget = { kind: "task", id: taskId }, record = priorityRecord(db, project, target);
  const effective = readPriority(db, project, target), f = t.featureId ? getFeature(db, t.featureId) : null;
  const incoming = listDeps(db, project).filter((d) => d.to === taskId && d.state === null);
  const progress = events.findLast((e) => (e.target === taskId && isPriorityStallProgress(e))
    || incoming.some((d) => dependencyReleased(db, e, d.from)));
  const deps = blockedBy(taskId, depViews(listDeps(db, project), listTasks(db, project)));
  const pm = t.pm ?? (f ? featurePm(db, f.id) : activeProjectPm(db, project));
  const ask = askFor(db, taskId, pm), frozen = getMeta(db, project).queueFrozen.frozen;
  const why = ask ? `等 PM 答 ask ${ask.id}` : frozen ? "项目合并队列冻结" : f?.status !== undefined && f.status !== "active"
    ? `feature 是 ${f.status}` : deps.length ? `依赖没满足：${deps.map((d) => d.from).join(", ")}` : `阶段 ${t.stage} 无有效推进`;
  return { project, key: record?.id ?? `task:${taskId}`, label: taskId, taskId, featureId: t.featureId ?? null, stage: t.stage, why, pm, ask, frozen,
    eligible: effective.effective === "now" && !["done", "cancelled"].includes(t.stage),
    since: progress?.ts ?? t.createdAt, progress: `event:${progress?.seq ?? 0}`,
    nowSince: nowEpoch(events, record?.id ?? null, t.featureId ?? null, t.createdAt) };
}

function plannedBases(db: Database, f: Feature, events: LedgerEvent[]): StallBasis[] {
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!v) return [];
  const lanes = featureLanes(db, f), frozen = getMeta(db, f.project).queueFrozen.frozen;
  return effectiveNodes(db, v).filter((n) => !n.taskId).map((n) => {
    const target: PriorityTarget = { kind: "node", id: f.id, nodeKey: n.key }, r = priorityRecord(db, f.project, target);
    const waiting = lanes?.waiting.find((w) => w.key === n.key);
    // Only actual upstream results count, never a feature's title edit, observation or another node's progress.
    const deps = effectiveNodes(db, v).filter((d) => n.deps.includes(d.key));
    const progress = events.findLast((e) => deps.some((d) => d.taskId && dependencyReleased(db, e, d.taskId)));
    const recorded = events.findLast((e) => e.data.namespace === "priority-now" && e.data.featureId === f.id && e.data.key === n.key);
    const why = frozen ? "项目合并队列冻结" : f.status !== "active" ? `feature 是 ${f.status}` : waiting
      ? `${waiting.why === "deps" ? "依赖没满足" : waiting.why === "files" ? "文件锁阻塞" : "没有文件范围"}：${waiting.on.join(", ")}`
      : typeof recorded?.data.why === "string" ? recorded.data.why : "已满足依赖，等自动开工资格复核";
    return { project: f.project, key: r?.id ?? `node:${f.id}:${n.key}`, label: `${f.id}/${n.key}`, taskId: null, featureId: f.id, stage: "planned", why, pm: featurePm(db, f.id), frozen,
      eligible: !["done", "dropped"].includes(f.status) && readPriority(db, f.project, target).effective === "now",
      since: progress?.ts ?? f.createdAt, progress: `event:${progress?.seq ?? 0}`,
      nowSince: nowEpoch(events, r?.id ?? null, f.id, f.createdAt) };
  });
}

export function priorityStallBases(db: Database, project: string): StallBasis[] {
  const events = listEvents(db, { project });
  const tasks = listTasks(db, project).filter((t) => !schedulerV2SkipTask(db, t.id)).map((t) => taskBasis(db, project, t.id, events));
  const features = db.query("SELECT id FROM features WHERE project=?").all(project) as { id: string }[];
  return [...tasks, ...features.filter(({ id }) => !schedulerV2SkipFeature(db, id)).flatMap(({ id }) => plannedBases(db, getFeature(db, id)!, events))];
}
