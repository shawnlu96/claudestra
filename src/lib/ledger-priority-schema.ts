import type { Database } from "bun:sqlite";

export const PRIORITY_TABLES = ["priority_records", "priority_orders", "priority_modes"] as const;
export const PRIORITY_COLUMNS = {
  priority_records: ["id", "project", "kind", "featureId", "nodeKey", "taskId", "band", "rev", "archived", "mergedInto"],
  priority_orders: ["project", "queue", "band", "members", "rev"],
  priority_modes: ["project", "mechanism", "mode", "rev"],
};
export const PRIORITY_INDEXES = { priority_records: ["priority_feature", "priority_node", "priority_task"] };

const SQL = [
  `CREATE TABLE IF NOT EXISTS priority_records (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('feature','work')),
    featureId TEXT REFERENCES features(id), nodeKey TEXT, taskId TEXT REFERENCES tasks(id),
    band TEXT CHECK(band IN ('now','next','later')), rev INTEGER NOT NULL DEFAULT 0 CHECK(rev >= 0),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)), mergedInto TEXT REFERENCES priority_records(id),
    CHECK(kind <> 'feature' OR (featureId IS NOT NULL AND nodeKey IS NULL AND taskId IS NULL)))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS priority_feature ON priority_records(featureId) WHERE kind='feature' AND archived=0",
  "CREATE UNIQUE INDEX IF NOT EXISTS priority_node ON priority_records(featureId,nodeKey) WHERE kind='work' AND nodeKey IS NOT NULL AND archived=0",
  "CREATE UNIQUE INDEX IF NOT EXISTS priority_task ON priority_records(taskId) WHERE taskId IS NOT NULL AND archived=0",
  `CREATE TABLE IF NOT EXISTS priority_orders (
    project TEXT NOT NULL, queue TEXT NOT NULL, band TEXT NOT NULL CHECK(band IN ('now','next','later')),
    members TEXT NOT NULL CHECK(json_valid(members)), rev INTEGER NOT NULL CHECK(rev > 0), PRIMARY KEY(project,queue,band))`,
  `CREATE TABLE IF NOT EXISTS priority_modes (
    project TEXT NOT NULL, mechanism TEXT NOT NULL CHECK(mechanism IN ('prioritySort','priorityNowStart','priorityStall','priorityPanel')),
    mode TEXT NOT NULL CHECK(mode IN ('off','observe','on')), rev INTEGER NOT NULL CHECK(rev > 0), PRIMARY KEY(project,mechanism))`,
];

/** Old text priority remains untouched. Backfill only identities for the currently live DAG. */
export function migratePriority(db: Database): void {
  for (const sql of SQL) db.prepare(sql).run();
  db.prepare(`INSERT OR IGNORE INTO priority_records(id,project,kind,featureId,nodeKey,taskId)
    SELECT lower(hex(randomblob(16))), f.project, 'work', f.id, json_extract(n.value,'$.key'),
      COALESCE(json_extract(n.value,'$.taskId'), b.taskId)
    FROM features f JOIN dag_versions v ON v.featureId=f.id AND v.version=f.currentVersion,
      json_each(v.nodes) n LEFT JOIN dag_bindings b ON b.featureId=f.id AND b.version=v.version AND b.nodeKey=json_extract(n.value,'$.key')
    WHERE NOT EXISTS (SELECT 1 FROM priority_records r WHERE r.featureId=f.id AND r.nodeKey=json_extract(n.value,'$.key') AND r.archived=0)`)
    .run();
}
