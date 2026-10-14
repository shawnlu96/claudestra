import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { effectiveNodes, getDagVersion, type DagNode, type Feature } from "./ledger-feature.js";
import type { SplitPlan } from "./ledger-feature-split-plan.js";
import type { PriorityRecord } from "./ledger-priority-types.js";
import { LedgerError } from "./ledger-store.js";
import { ensurePriorityRecord, priorityAudit } from "./ledger-priority-write.js";

function nodeRecord(db: Database, featureId: string, key: string): PriorityRecord | null {
  return db.query("SELECT * FROM priority_records WHERE featureId=? AND nodeKey=? AND kind='work' AND archived=0")
    .get(featureId, key) as PriorityRecord | null;
}

function createNodeRecord(db: Database, feature: Pick<Feature, "id" | "project">, key: string): PriorityRecord {
  // Leave taskId empty until attach reconciles a standalone card's existing grant in the same transaction.
  db.query("INSERT INTO priority_records(id,project,kind,featureId,nodeKey) VALUES (?,?,'work',?,?)")
    .run(crypto.randomUUID(), feature.project, feature.id, key);
  return nodeRecord(db, feature.id, key)!;
}

function trace(db: Database, ctx: WriteCtx, before: PriorityRecord, after: PriorityRecord, op: string, orders: unknown[] = []): void {
  // No grant means no additional event: observe's untouched legacy writes keep their old result and event count.
  if (!before.rev && !after.rev && !db.query(`SELECT 1 FROM priority_orders o,json_each(o.members) m
    WHERE o.project=? AND m.value IN (?,?)`).get(before.project, before.id, after.id)) return;
  priorityAudit(db, ctx, before.project, { op, recordId: after.id, oldLocation: before, location: after,
    before, after, orders, sourceRef: `dag:${before.featureId ?? ""}/${before.nodeKey ?? ""}` });
}

function replaceOrderedId(db: Database, project: string, oldId: string, id: string) {
  const rows = db.query("SELECT queue,band,members,rev FROM priority_orders WHERE project=?").all(project) as {
    queue: string; band: string; members: string; rev: number;
  }[];
  const changes = [];
  for (const row of rows) {
    const members = JSON.parse(row.members) as string[];
    if (!members.includes(oldId)) continue;
    const next = [...new Set(members.map((member) => member === oldId ? id : member))];
    db.query("UPDATE priority_orders SET members=?,rev=rev+1 WHERE project=? AND queue=? AND band=?")
      .run(JSON.stringify(next), project, row.queue, row.band);
    changes.push({ queue: row.queue, band: row.band, before: { members, rev: row.rev }, after: { members: next, rev: row.rev + 1 } });
  }
  return changes;
}

/** Link the task alias to the node identity. Two live grants require explicit reconciliation instead of guessing. */
function attach(db: Database, ctx: WriteCtx, record: PriorityRecord, taskId: string): PriorityRecord {
  if (record.taskId === taskId) return record;
  if (record.taskId) throw new LedgerError("conflict", "优先级记录已绑另一张卡，换卡必须产生新节点身份");
  const other = db.query("SELECT * FROM priority_records WHERE taskId=? AND archived=0").get(taskId) as PriorityRecord | null;
  if (other && (other.project !== record.project || other.nodeKey)) throw new LedgerError("conflict", "任务优先级记录已有其他节点归属");
  if (other?.band && record.band) throw new LedgerError("conflict", "节点与卡都有显式优先级：请按 owner 原话先 clear 一处再绑定");
  let orders: unknown[] = [];
  if (other) {
    db.query("UPDATE priority_records SET archived=1,mergedInto=? WHERE id=?").run(record.id, other.id);
    orders = replaceOrderedId(db, record.project, other.id, record.id);
  }
  const rev = Math.max(record.rev, other?.rev ?? 0);
  db.query("UPDATE priority_records SET taskId=?,band=?,rev=? WHERE id=?")
    .run(taskId, record.band ?? other?.band ?? null, rev ? rev + 1 : 0, record.id);
  const after = { ...record, taskId, band: record.band ?? other?.band ?? null, rev: rev ? rev + 1 : 0 };
  trace(db, ctx, other ?? record, after, "bind", orders);
  return after;
}

function retire(db: Database, ctx: WriteCtx, record: PriorityRecord): void {
  // A detached card remains the same card. Retire its node address, preserving its explicit grant as a standalone task.
  const after = { ...record, archived: record.taskId ? 0 : 1, featureId: record.taskId ? null : record.featureId,
    nodeKey: record.taskId ? null : record.nodeKey, rev: record.rev ? record.rev + 1 : 0 };
  db.query("UPDATE priority_records SET archived=?,featureId=?,nodeKey=?,rev=? WHERE id=?")
    .run(after.archived, after.featureId, after.nodeKey, after.rev, record.id);
  trace(db, ctx, record, after, "retire");
}

/** Call inside the DAG transaction, using its pre-write feature snapshot, so same-key replacement cannot reuse a grant. */
export function syncPriorityDag(db: Database, ctx: WriteCtx, feature: Feature, nodes: readonly DagNode[]): void {
  const v = feature.currentVersion ? getDagVersion(db, feature.id, feature.currentVersion) : null;
  const old = v ? effectiveNodes(db, v) : [];
  const moves: { before: PriorityRecord; key: string }[] = [];
  for (const n of old) {
    const next = nodes.find((x) => x.key === n.key), record = nodeRecord(db, feature.id, n.key);
    if (!record) continue;
    const moved = n.taskId ? nodes.find((x) => x.taskId === n.taskId && x.key !== n.key) : null;
    if (moved) { moves.push({ before: record, key: moved.key }); continue; }
    const replacedByMove = next?.taskId && old.some((x) => x.key !== n.key && x.taskId === next.taskId);
    if (!next || (n.taskId && n.taskId !== next.taskId) || replacedByMove) retire(db, ctx, record);
  }
  // Vacate every old key before filling destinations: swapping two card keys cannot collide halfway through.
  for (const { before } of moves) db.query("UPDATE priority_records SET nodeKey=NULL WHERE id=?").run(before.id);
  for (const { before, key } of moves) {
    const after = { ...before, nodeKey: key, rev: before.rev ? before.rev + 1 : 0 };
    db.query("UPDATE priority_records SET nodeKey=?,rev=? WHERE id=?").run(key, after.rev, before.id);
    trace(db, ctx, before, after, "move");
  }
  for (const n of nodes) {
    const record = nodeRecord(db, feature.id, n.key) ?? createNodeRecord(db, feature, n.key);
    if (n.taskId) attach(db, ctx, record, n.taskId);
  }
}

export function bindPriorityNode(db: Database, ctx: WriteCtx, feature: Feature, key: string, taskId: string): void {
  const record = ensurePriorityRecord(db, feature.project, { kind: "node", id: feature.id, nodeKey: key });
  attach(db, ctx, record, taskId);
}

/** Split only moves the work identity; inherited priority follows the destination feature dynamically. */
export function splitPriorityDag(db: Database, ctx: WriteCtx, plan: SplitPlan): void {
  for (const group of plan.groups.slice(1)) {
    for (const key of group.target?.nodes ?? []) {
      const record = nodeRecord(db, plan.source.id, key) ?? createNodeRecord(db, plan.source, key);
      if (nodeRecord(db, group.id, key)) throw new LedgerError("conflict", "拆分目标已有同名优先级身份");
      const after = { ...record, featureId: group.id, rev: record.rev ? record.rev + 1 : 0 };
      db.query("UPDATE priority_records SET featureId=?,rev=? WHERE id=?").run(group.id, after.rev, record.id);
      trace(db, ctx, record, after, "move");
    }
  }
  // All groups' versions are already written. Sync their live graph without retiring the identities just moved.
  for (const group of plan.groups) {
    const feature = db.query("SELECT * FROM features WHERE id=?").get(group.id) as Feature;
    syncPriorityDag(db, ctx, feature, group.nodes);
  }
}
