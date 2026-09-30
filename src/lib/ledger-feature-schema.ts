/**
 * feature + 子 DAG 版本的表（T84，设计稿 docs/design/feature-dag.md）。迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，
 * 每步可重跑（IF NOT EXISTS、加列先查列），因为版本号撞过时要从第 2 步起整体重跑补齐。
 * dag_versions 只追加：库里用 trigger 拦 UPDATE / DELETE，并拦同键 INSERT——REPLACE 的隐式删除默认不触发 DELETE trigger，
 * 不拦就能用 INSERT OR REPLACE 换掉旧版本（tests/ledger-feature.test.ts「REPLACE / UPSERT」）。改 DAG 只能写一个新版本。
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
  `CREATE TRIGGER IF NOT EXISTS dag_versions_no_replace BEFORE INSERT ON dag_versions
    WHEN EXISTS (SELECT 1 FROM dag_versions WHERE featureId = NEW.featureId AND version = NEW.version)
    BEGIN SELECT RAISE(ABORT, 'dag versions are rewrite-only'); END`,
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

const REWRITE_ONLY = "BEGIN SELECT RAISE(ABORT, 'dag versions are rewrite-only'); END";
/** 提案里 dag-approve / 作废能改的只有这几列，其余写入后冻结 */
const STATUS_KEYS = ["state", "decidedAt", "decidedBy", "decisionNote"];
const PROPOSAL_COLS = ["seq", "featureId", "version", "baseVersion", "reasonKind", "reasonText", "proposedBy", "nodes", "cancels", "scopeChange", "sha", "askId", "createdAt"];

/**
 * 第 11 步（T89 = L2 重写与审批）。dag_proposals：要 owner 批的重写先落在这里（pending），批了才写进 dag_versions；
 * 内容列写入后不可改（trigger），只有 pending 能改状态——审批绑定的快照哈希照着这些列算，改了就对不上。一个 feature 同时只有一个 pending。
 * dag_bindings：计划节点开工绑卡，不产生新版本；只追加。dag_versions 补上取消记录、是否改范围、批准它的 ask。
 */
const DAG_REWRITE_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dag_proposals (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, featureId TEXT NOT NULL REFERENCES features(id),
    version INTEGER NOT NULL CHECK (version >= 2), baseVersion INTEGER NOT NULL CHECK (baseVersion = version - 1),
    reasonKind TEXT NOT NULL CHECK (reasonKind IN (${inList(DAG_REASON_KINDS.slice(1))})), reasonText TEXT NOT NULL,
    proposedBy TEXT NOT NULL, nodes TEXT NOT NULL, cancels TEXT NOT NULL, scopeChange INTEGER NOT NULL CHECK (scopeChange IN (0, 1)),
    sha TEXT NOT NULL, askId TEXT NOT NULL, createdAt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','void')), decidedAt INTEGER, decidedBy TEXT, decisionNote TEXT)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS dag_proposals_pending ON dag_proposals(featureId) WHERE state = 'pending'",
  `CREATE TRIGGER IF NOT EXISTS dag_proposals_frozen BEFORE UPDATE ON dag_proposals
    WHEN OLD.state <> 'pending' OR ${PROPOSAL_COLS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ")} ${REWRITE_ONLY}`,
  "CREATE TRIGGER IF NOT EXISTS dag_proposals_no_delete BEFORE DELETE ON dag_proposals " + REWRITE_ONLY,
  `CREATE TRIGGER IF NOT EXISTS dag_proposals_no_replace BEFORE INSERT ON dag_proposals
    WHEN EXISTS (SELECT 1 FROM dag_proposals WHERE seq = NEW.seq OR (featureId = NEW.featureId AND state = 'pending')) ${REWRITE_ONLY}`,
  `CREATE TABLE IF NOT EXISTS dag_bindings (
    featureId TEXT NOT NULL REFERENCES features(id), version INTEGER NOT NULL, nodeKey TEXT NOT NULL, taskId TEXT NOT NULL,
    boundBy TEXT NOT NULL, boundAt INTEGER NOT NULL, PRIMARY KEY (featureId, version, nodeKey), UNIQUE (featureId, version, taskId))`,
  "CREATE TRIGGER IF NOT EXISTS dag_bindings_no_update BEFORE UPDATE ON dag_bindings " + REWRITE_ONLY,
  "CREATE TRIGGER IF NOT EXISTS dag_bindings_no_delete BEFORE DELETE ON dag_bindings " + REWRITE_ONLY,
  `CREATE TRIGGER IF NOT EXISTS dag_bindings_no_replace BEFORE INSERT ON dag_bindings
    WHEN EXISTS (SELECT 1 FROM dag_bindings WHERE featureId = NEW.featureId AND version = NEW.version AND (nodeKey = NEW.nodeKey OR taskId = NEW.taskId))
    ${REWRITE_ONLY}`,
];

export function DAG_REWRITE_SCHEMA(db: Database): void {
  for (const sql of DAG_REWRITE_SQL) db.prepare(sql).run();
  const have = columns(db, "dag_versions");
  if (!have.has("cancels")) db.prepare("ALTER TABLE dag_versions ADD COLUMN cancels TEXT NOT NULL DEFAULT '[]'").run();
  if (!have.has("scopeChange")) db.prepare("ALTER TABLE dag_versions ADD COLUMN scopeChange INTEGER NOT NULL DEFAULT 0").run();
  if (!have.has("askId")) db.prepare("ALTER TABLE dag_versions ADD COLUMN askId TEXT").run();
}

export const FEATURE_TABLES = ["ledger_instance", "features", "dag_versions", "dag_proposals", "dag_bindings"] as const;
export const FEATURE_COLUMNS: Record<string, readonly string[]> = {
  features: ["id", "project", "title", "ownerWords", "status", "currentVersion", "rev"],
  dag_versions: ["featureId", "version", "reasonKind", "reasonText", "proposedBy", "approvedBy", "nodes", "cancels", "scopeChange", "askId"],
  dag_proposals: [...PROPOSAL_COLS, ...STATUS_KEYS],
  dag_bindings: ["featureId", "version", "nodeKey", "taskId", "boundBy", "boundAt"],
  events: ["origin", "originSeq"],
};
export const FEATURE_INDEXES: Record<string, readonly string[]> = {
  features: ["features_project_title"],
  tasks: ["tasks_feature"],
  events: ["events_origin_seq"],
  dag_proposals: ["dag_proposals_pending"],
};
