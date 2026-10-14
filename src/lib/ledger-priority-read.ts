import type { Database } from "bun:sqlite";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { getItem, getTask, LedgerError, toEvent } from "./ledger-store.js";
import { PRIORITY_MECHANISMS, type PriorityBand, type PriorityRecord, type PriorityTarget, type PriorityView } from "./ledger-priority-types.js";
import type { LedgerEvent } from "./ledger-stages.js";

function priorityTablesExist(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='priority_records'").get();
}

/** Check the requested project even for reads: explicit --project cannot bypass scope by naming a global task id. */
export function priorityTarget(db: Database, project: string, target: PriorityTarget) {
  if (!["task", "feature", "node"].includes(target.kind) || typeof target.id !== "string" || !target.id.trim()) {
    throw new LedgerError("invalid", "优先级目标为 feature / task / node 和非空 id");
  }
  if (target.kind === "task") {
    const task = getTask(db, target.id);
    if (!task || task.project !== project) throw new LedgerError("not_found", "本项目没有该任务");
    return { featureId: task.featureId ?? null, taskId: task.id, nodeKey: null as string | null, legacyPriority:
      task.itemId ? getItem(db, project, task.itemId)?.priority ?? null : null };
  }
  const f = getFeature(db, target.id);
  if (!f || f.project !== project) throw new LedgerError("not_found", "本项目没有该 feature");
  if (target.kind === "feature") return { featureId: f.id, taskId: null, nodeKey: null, legacyPriority: null };
  const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const n = v ? effectiveNodes(db, v).find((x) => x.key === target.nodeKey) : null;
  if (!n) throw new LedgerError("not_found", "当前 DAG 没有该节点");
  return { featureId: f.id, taskId: n.taskId, nodeKey: n.key, legacyPriority: null };
}

export function priorityRecord(db: Database, project: string, target: PriorityTarget): PriorityRecord | null {
  const ref = priorityTarget(db, project, target);
  if (!priorityTablesExist(db)) return null;
  if (target.kind === "task") {
    return db.query("SELECT * FROM priority_records WHERE project=? AND taskId=? AND archived=0").get(project, ref.taskId) as PriorityRecord | null;
  }
  return db.query("SELECT * FROM priority_records WHERE project=? AND kind=? AND featureId=? AND nodeKey IS ? AND archived=0")
    .get(project, target.kind === "feature" ? "feature" : "work", ref.featureId, ref.nodeKey) as PriorityRecord | null;
}

export function readPriority(db: Database, project: string, target: PriorityTarget, queue = "project"): PriorityView {
  const ref = priorityTarget(db, project, target), record = priorityRecord(db, project, target);
  const parent = ref.featureId && target.kind !== "feature" ? priorityRecord(db, project, { kind: "feature", id: ref.featureId }) : null;
  const effective = record?.band ?? parent?.band ?? "next";
  const source = record?.band ? "explicit" : parent?.band ? "feature" : "system";
  const order = readPriorityOrder(db, project, queue, effective).members.indexOf(record?.id ?? "");
  return { recordId: record?.id ?? null, rev: record?.rev ?? 0, explicit: record?.band ?? null, effective, source,
    inheritedFrom: source === "feature" ? ref.featureId : null, ownerRegistered: source !== "system",
    note: source === "system" ? "系统缺省、owner 未登记" : null, queue, order: order < 0 ? null : order,
    legacyPriority: ref.legacyPriority };
}

export function readPriorityOrder(db: Database, project: string, queue: string, band: PriorityBand): { members: string[]; rev: number } {
  const row = priorityTablesExist(db) ? db.query("SELECT members,rev FROM priority_orders WHERE project=? AND queue=? AND band=?")
    .get(project, queue, band) as { members: string; rev: number } | null : null;
  return { members: row ? JSON.parse(row.members) as string[] : [], rev: row?.rev ?? 0 };
}

export function readPriorityModes(db: Database, project: string) {
  return Object.fromEntries(PRIORITY_MECHANISMS.map((mechanism) => {
    const row = priorityTablesExist(db) ? db.query("SELECT mode,rev FROM priority_modes WHERE project=? AND mechanism=?")
      .get(project, mechanism) as { mode: string; rev: number } | null : null;
    return [mechanism, row ?? { mode: "observe", rev: 0 }];
  }));
}

/** Include archived generations and merged identities, while retaining the location in each event's immutable snapshot. */
export function priorityHistory(db: Database, project: string, target?: PriorityTarget) {
  if (!priorityTablesExist(db)) return [];
  const events = (db.query("SELECT * FROM events WHERE project=? AND json_extract(data,'$.namespace')='priority' ORDER BY seq")
    .all(project) as Record<string, unknown>[]).map(toEvent);
  const ids = target ? historyIds(db, project, target, events) : null;
  return events.filter((e) => !ids || ids.has(String(e.data.recordId))
    || ((e.data.before as { members?: string[] })?.members ?? []).some((id) => ids.has(id))
    || ((e.data.after as { members?: string[] })?.members ?? []).some((id) => ids.has(id)));
}

function historyIds(db: Database, project: string, target: PriorityTarget, events: LedgerEvent[]): Set<string> {
  // A cancelled plan can be queried after it disappears; a current node is not required for history.
  if (target.kind !== "node") priorityTarget(db, project, target);
  else if (getFeature(db, target.id)?.project !== project) throw new LedgerError("not_found", "本项目没有该 feature");
  const records = db.query("SELECT * FROM priority_records WHERE project=?").all(project) as PriorityRecord[];
  const matches = (r: PriorityRecord) => target.kind === "task" ? r.taskId === target.id
    : r.featureId === target.id && (target.kind === "feature" ? r.kind === "feature" : r.nodeKey === target.nodeKey);
  const ids = new Set(records.filter(matches).map((r) => r.id));
  for (const event of events) {
    for (const location of [event.data.location, event.data.oldLocation]) {
      if (location && matches(location as PriorityRecord)) ids.add(String(event.data.recordId));
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records) if (r.mergedInto && (ids.has(r.id) || ids.has(r.mergedInto))) {
      if (!ids.has(r.id) || !ids.has(r.mergedInto)) changed = true;
      ids.add(r.id); ids.add(r.mergedInto);
    }
  }
  return ids;
}
