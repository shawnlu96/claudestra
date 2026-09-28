/**
 * asks 表的第二版（T11b，docs 13 §4.2 + T28 附录 B-1）：人 / 系统发起的 ask 没有发起 agent（fromAgent、fromChannelId 可空），
 * 多了指派对象、授权绑定、按 key 取代、去重键。SQLite 改不了 NOT NULL 和 CHECK，只能重建：建新表 → 拷数据 → 删旧表 → 改名 → 建索引。
 * 每条语句单独 prepare().run()：bun 的 prepare 碰到多条语句只跑第一条、db.exec 会吞运行期错误（ledger-store.ts 迁移段的说明）。
 * 整步在 migrate 的 IMMEDIATE 事务里，中途失败整体回滚；新表是旧表列的超集，旧版代码按版本号超前不迁移、照常读写。
 */
import type { Database } from "bun:sqlite";

/** 旧表的列：原样拷进新表 */
const V1_COLUMNS = [
  "id", "project", "itemId", "taskId", "fromAgent", "fromChannelId", "source", "kind", "blocking", "urgency", "title", "context", "body",
  "options", "allowText", "kindHint", "chatId", "threadId", "discordMessageIds", "expiresAt", "state", "answer", "outboxMessageId", "extra",
  "createdAt", "updatedAt",
].join(", ");

const CREATE_NEXT = `CREATE TABLE asks_next (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, itemId TEXT, taskId TEXT,
  fromAgent TEXT, fromChannelId TEXT,
  source TEXT NOT NULL CHECK (source IN ('reply','auq','permission','codex','human','system')),
  kind TEXT NOT NULL CHECK (kind IN ('decide','authorize','owner_action','accept','assigned')),
  blocking INTEGER, urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','urgent')),
  title TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]', allowText INTEGER NOT NULL DEFAULT 1, kindHint TEXT,
  chatId TEXT NOT NULL DEFAULT '', threadId TEXT, discordMessageIds TEXT NOT NULL DEFAULT '[]',
  expiresAt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered','expired','cancelled','superseded')),
  answer TEXT, outboxMessageId TEXT, extra TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  assignee TEXT, createdBy TEXT, askKey TEXT, bind TEXT, supersedes TEXT, dedupKey TEXT UNIQUE)`;

const REBUILD = [
  // 上次在这一步中途崩掉不会留下 asks_next（DDL 在事务里），这句只防手工折腾过的库
  "DROP TABLE IF EXISTS asks_next",
  CREATE_NEXT,
  `INSERT INTO asks_next (${V1_COLUMNS}) SELECT ${V1_COLUMNS} FROM asks`,
  "DROP TABLE asks",
  "ALTER TABLE asks_next RENAME TO asks",
  "CREATE INDEX asks_state_project ON asks(state, project)",
  "CREATE INDEX asks_from_state ON asks(fromAgent, state)",
  "CREATE INDEX asks_assignee_state ON asks(assignee, state)",
  "CREATE INDEX asks_key_state ON asks(fromAgent, askKey, state)",
];

/** 已经是第二版（分支上提前开过、再按合并后的顺序迁移）就不再重建：看 assignee 列在不在 */
export function migrateAsksV2(db: Database): void {
  const cols = (db.prepare("PRAGMA table_info(asks)").all() as { name: string }[]).map((c) => c.name);
  if (cols.includes("assignee")) return;
  for (const sql of REBUILD) db.prepare(sql).run();
}

/** 迁移后必须在的 asks 列（ledger-store.ts checkSchema） */
export const ASKS_REQUIRED_COLUMNS = ["id", "project", "fromAgent", "source", "kind", "state", "options", "answer", "expiresAt", "extra", "assignee", "askKey", "bind", "dedupKey"];
