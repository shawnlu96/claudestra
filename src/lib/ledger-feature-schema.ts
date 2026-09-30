/**
 * feature + 子 DAG 版本的表（T84，设计稿 docs/design/feature-dag.md）。迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，
 * 每步可重跑（IF NOT EXISTS、加列先查列），因为版本号撞过时要从第 2 步起整体重跑补齐。
 * dag_versions 只追加：库里用 trigger 拦 UPDATE / DELETE——改 DAG 只能写一个新版本（只重写，不修改）。
 */
import type { Database } from "bun:sqlite";

export const FEATURE_STATUSES = ["active", "paused", "done", "dropped"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
/** 版本的原因类型：初版 / 发现新问题 / 需求变了 / P1 退路。初版只能是 v1，v1 也只能是初版（表上的 CHECK） */
export const DAG_REASON_KINDS = ["initial", "new_issue", "requirement_change", "p1_fallback"] as const;
export type DagReasonKind = (typeof DAG_REASON_KINDS)[number];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

const FEATURE_SQL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS ledger_instance (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, ownerWords TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN (${inList(FEATURE_STATUSES)})),
    currentVersion INTEGER NOT NULL DEFAULT 0 CHECK (currentVersion >= 0),
    rev INTEGER NOT NULL DEFAULT 1, createdBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS features_project_title ON features(project, title)",
  `CREATE TABLE IF NOT EXISTS dag_versions (
    featureId TEXT NOT NULL REFERENCES features(id), version INTEGER NOT NULL CHECK (version >= 1),
    reasonKind TEXT NOT NULL CHECK (reasonKind IN (${inList(DAG_REASON_KINDS)})),
    reasonText TEXT NOT NULL DEFAULT '', proposedBy TEXT NOT NULL, approvedBy TEXT,
    createdAt INTEGER NOT NULL, nodes TEXT NOT NULL,
    PRIMARY KEY (featureId, version), CHECK ((version = 1) = (reasonKind = 'initial')))`,
  "CREATE TRIGGER IF NOT EXISTS dag_versions_no_update BEFORE UPDATE ON dag_versions BEGIN SELECT RAISE(ABORT, 'dag versions are rewrite-only'); END",
  "CREATE TRIGGER IF NOT EXISTS dag_versions_no_delete BEFORE DELETE ON dag_versions BEGIN SELECT RAISE(ABORT, 'dag versions are rewrite-only'); END",
];

function columns(db: Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

export function FEATURE_SCHEMA(db: Database): void {
  for (const sql of FEATURE_SQL) db.prepare(sql).run();
  const run = (sql: string) => db.prepare(sql).run();
  if (!columns(db, "tasks").has("featureId")) run("ALTER TABLE tasks ADD COLUMN featureId TEXT REFERENCES features(id)");
  run("CREATE INDEX IF NOT EXISTS tasks_feature ON tasks(featureId)");
  const ev = columns(db, "events");
  if (!ev.has("origin")) run("ALTER TABLE events ADD COLUMN origin TEXT");
  if (!ev.has("originSeq")) run("ALTER TABLE events ADD COLUMN originSeq INTEGER");
  run("CREATE UNIQUE INDEX IF NOT EXISTS events_origin_seq ON events(origin, originSeq)");
}

export const FEATURE_TABLES = ["ledger_instance", "features", "dag_versions"] as const;
export const FEATURE_COLUMNS: Record<string, readonly string[]> = {
  features: ["id", "project", "title", "ownerWords", "status", "currentVersion", "rev"],
  dag_versions: ["featureId", "version", "reasonKind", "reasonText", "proposedBy", "approvedBy", "nodes"],
  events: ["origin", "originSeq"],
};
export const FEATURE_INDEXES: Record<string, readonly string[]> = {
  features: ["features_project_title"],
  tasks: ["tasks_feature"],
  events: ["events_origin_seq"],
};
