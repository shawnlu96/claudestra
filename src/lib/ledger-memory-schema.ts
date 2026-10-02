/**
 * 项目记忆的两张表（设计稿 docs/design/project-memory.md §1）。迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，
 * 每步可重跑（IF NOT EXISTS），因为版本号撞过时要从第 2 步起整体重跑补齐。
 * memories 内容冻结、memory_marks 只追加：都用 trigger 拦 UPDATE / DELETE，并拦同键 INSERT——REPLACE 的隐式删除默认不触发
 * DELETE trigger，不拦就能用 INSERT OR REPLACE 换掉旧行（同 dag_versions）。写错了不改行，追加 retract / supersede mark。
 * 不挂外键：同步来的记忆可能锚在本机没有的卡 / feature 上（M8），锚点存不存在由写入函数在本机写时核。
 */
import type { Database } from "bun:sqlite";

export const MEMORY_KINDS = ["summary", "pitfall", "decision"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_MARKS = ["confirm", "link_fix", "unlink_fix", "fixed", "reopen", "dispute", "retract", "supersede"] as const;
export type MemoryMarkKind = (typeof MEMORY_MARKS)[number];
export const MEMORY_VIAS = ["verify_summary", "p1_family", "tool", "decision_index", "import"] as const;
export type MemoryVia = (typeof MEMORY_VIAS)[number];
export const MEMORY_AUTHOR_ROLES = ["executor", "reviewer", "pm", "owner", "system"] as const;
export type MemoryAuthorRole = (typeof MEMORY_AUTHOR_ROLES)[number];
export const MEMORY_VISIBILITIES = ["team", "home"] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const FROZEN = "BEGIN SELECT RAISE(ABORT, 'ledger memories are append-only'); END";

/**
 * 合并键：普通记忆 (origin, originSeq) 唯一，id = `<origin>-m<originSeq>`；decision 索引行的 id 由来源事件定（`<事件 origin>-d<事件 originSeq>`），
 * 序号是事件的、不占本机记忆序号，所以两类各一个部分唯一索引，不然本机第 7 条记忆会和 originSeq=7 的决定事件撞键。
 * fixable 只有坑有（CHECK 两向）；by 是 SQL 关键字，列名用 byId，行映射成 by。
 */
const MEMORY_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, originSeq INTEGER NOT NULL CHECK (originSeq >= 1), project TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${inList(MEMORY_KINDS)})),
    featureId TEXT, nodeKey TEXT, taskId TEXT,
    files TEXT NOT NULL DEFAULT '[]', family TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
    fixable INTEGER CHECK (fixable IN (0, 1)),
    sources TEXT NOT NULL DEFAULT '[]', sourceNote TEXT,
    via TEXT NOT NULL CHECK (via IN (${inList(MEMORY_VIAS)})),
    author TEXT NOT NULL, authorRole TEXT NOT NULL CHECK (authorRole IN (${inList(MEMORY_AUTHOR_ROLES)})),
    head TEXT, specRev INTEGER,
    visibility TEXT NOT NULL CHECK (visibility IN (${inList(MEMORY_VISIBILITIES)})),
    redactionVersion INTEGER NOT NULL, digest TEXT NOT NULL, createdAt INTEGER NOT NULL,
    CHECK ((kind = 'pitfall') = (fixable IS NOT NULL)),
    CHECK ((via = 'decision_index') = (kind = 'decision' AND id = origin || '-d' || originSeq)),
    CHECK (via = 'decision_index' OR id = origin || '-m' || originSeq))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS memories_origin_seq ON memories(origin, originSeq) WHERE via <> 'decision_index'",
  "CREATE UNIQUE INDEX IF NOT EXISTS memories_decision_source ON memories(origin, originSeq) WHERE via = 'decision_index'",
  "CREATE INDEX IF NOT EXISTS memories_project_kind ON memories(project, kind)",
  "CREATE INDEX IF NOT EXISTS memories_task ON memories(taskId)",
  "CREATE INDEX IF NOT EXISTS memories_family ON memories(project, family)",
  "CREATE TRIGGER IF NOT EXISTS memories_no_update BEFORE UPDATE ON memories " + FROZEN,
  "CREATE TRIGGER IF NOT EXISTS memories_no_delete BEFORE DELETE ON memories " + FROZEN,
  `CREATE TRIGGER IF NOT EXISTS memories_no_replace BEFORE INSERT ON memories
    WHEN EXISTS (SELECT 1 FROM memories WHERE id = NEW.id
      OR (origin = NEW.origin AND originSeq = NEW.originSeq AND (via = 'decision_index') = (NEW.via = 'decision_index'))) ${FROZEN}`,
  `CREATE TABLE IF NOT EXISTS memory_marks (
    origin TEXT NOT NULL, originSeq INTEGER NOT NULL CHECK (originSeq >= 1), memoryId TEXT NOT NULL,
    ts INTEGER NOT NULL, actor TEXT NOT NULL,
    mark TEXT NOT NULL CHECK (mark IN (${inList(MEMORY_MARKS)})),
    taskId TEXT, byId TEXT, reason TEXT, source TEXT, dedupKey TEXT UNIQUE,
    PRIMARY KEY (origin, originSeq),
    CHECK (mark NOT IN ('link_fix','fixed','reopen') OR taskId IS NOT NULL),
    CHECK ((mark = 'supersede') = (byId IS NOT NULL)),
    CHECK (mark NOT IN ('dispute','retract') OR COALESCE(length(reason), 0) > 0),
    CHECK (dedupKey IS NULL OR source IS NOT NULL))`,
  "CREATE INDEX IF NOT EXISTS memory_marks_memory ON memory_marks(memoryId)",
  "CREATE TRIGGER IF NOT EXISTS memory_marks_no_update BEFORE UPDATE ON memory_marks " + FROZEN,
  "CREATE TRIGGER IF NOT EXISTS memory_marks_no_delete BEFORE DELETE ON memory_marks " + FROZEN,
  `CREATE TRIGGER IF NOT EXISTS memory_marks_no_replace BEFORE INSERT ON memory_marks
    WHEN EXISTS (SELECT 1 FROM memory_marks WHERE (origin = NEW.origin AND originSeq = NEW.originSeq)
      OR (NEW.dedupKey IS NOT NULL AND dedupKey = NEW.dedupKey)) ${FROZEN}`,
];

export function MEMORY_SCHEMA(db: Database): void {
  for (const sql of MEMORY_SQL) db.prepare(sql).run();
}

export const MEMORY_TABLES = ["memories", "memory_marks"] as const;
export const MEMORY_COLUMNS: Record<string, readonly string[]> = {
  memories: ["id", "origin", "originSeq", "project", "kind", "featureId", "nodeKey", "taskId", "files", "family", "title", "body", "fixable",
    "sources", "sourceNote", "via", "author", "authorRole", "head", "specRev", "visibility", "redactionVersion", "digest", "createdAt"],
  memory_marks: ["origin", "originSeq", "memoryId", "ts", "actor", "mark", "taskId", "byId", "reason", "source", "dedupKey"],
};
export const MEMORY_INDEXES: Record<string, readonly string[]> = {
  memories: ["memories_origin_seq", "memories_decision_source", "memories_project_kind", "memories_task", "memories_family"],
  memory_marks: ["memory_marks_memory"],
};
