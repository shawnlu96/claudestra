/**
 * talk.sqlite：人与人的 chat（代码名 talk，界面叫 Chat），和台账分库。只有 bridge 写，网页经 local-api 的 talk family 读写。
 * 列按两期一起定：远端的人、origin 这些二期才有意义的列一期就建好（本机的行 origin / fp 填本机指纹），二期只加 outbox。
 * 房间键 = (creatorFp, id)：dm 的 creatorFp 固定为空串、id 由两个成员键算出（talk-rooms.ts），thread 的 creatorFp 是建房实例。
 * 成员键 = `<fp>/<principal>`，和从哪个实例看无关；people.id 是本机界面与台账用的 `local:<principal>` / `remote:<fp>/<principal>`。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./paths.js";
import { runMigrations, type SchemaSpec } from "./sqlite-migrate.js";

/** 消息 id：`tm_` + uuid（小写）。二期入站帧同样按这个校验，不合格整条拒收 */
export const TALK_MSG_ID_RE = /^tm_[0-9a-f-]{36}$/;
/** thread 房间 id：`tr_` + uuid；dm 房间 id 是 64 位 hex */
export const THREAD_ID_RE = /^tr_[0-9a-f-]{36}$/;
export const DM_ID_RE = /^[0-9a-f]{64}$/;
/** 丢进工作台的幂等键，由前端生成：`td_` + uuid */
export const DROP_ID_RE = /^td_[0-9a-f-]{36}$/;
/** 从 Chat 建任务的幂等键（台账 dedup 用），由前端生成：`tt_` + uuid */
export const TASK_REQ_RE = /^tt_[0-9a-f-]{36}$/;

/** SQLite 没有正则：CHECK 用 GLOB 拼出同一个形状（前缀 + 36 位 [0-9a-f-]），和上面的正则一起守 */
const uuidCheck = (col: string, prefix: string): string => `length(${col}) = 39 AND substr(${col}, 1, 3) = '${prefix}' AND substr(${col}, 4) NOT GLOB '*[^0-9a-f-]*'`;

const V1: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('local','remote')),
    principalId TEXT, fp TEXT, remotePrincipal TEXT,
    displayName TEXT NOT NULL DEFAULT '', claimedName TEXT,
    mergedInto TEXT REFERENCES people(id),
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
    CHECK ((kind = 'local' AND principalId IS NOT NULL) OR (kind = 'remote' AND fp IS NOT NULL AND remotePrincipal IS NOT NULL)),
    CHECK (mergedInto IS NULL OR (kind = 'local' AND mergedInto <> id)))`,
  "CREATE INDEX IF NOT EXISTS people_fp ON people(fp)",
  `CREATE TABLE IF NOT EXISTS rooms (
    creatorFp TEXT NOT NULL, id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('dm','thread')),
    title TEXT, createdBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL, lastAt INTEGER NOT NULL,
    PRIMARY KEY (creatorFp, id),
    CHECK ((kind = 'dm' AND creatorFp = '' AND length(id) = 64) OR (kind = 'thread' AND creatorFp <> '' AND ${uuidCheck("id", "tr_")})))`,
  `CREATE TABLE IF NOT EXISTS members (
    roomFp TEXT NOT NULL, roomId TEXT NOT NULL, memberKey TEXT NOT NULL,
    PRIMARY KEY (roomFp, roomId, memberKey),
    FOREIGN KEY (roomFp, roomId) REFERENCES rooms(creatorFp, id))`,
  "CREATE INDEX IF NOT EXISTS members_key ON members(memberKey)",
  `CREATE TABLE IF NOT EXISTS messages (
    origin TEXT NOT NULL, id TEXT NOT NULL CHECK (${uuidCheck("id", "tm_")}),
    roomFp TEXT NOT NULL, roomId TEXT NOT NULL, authorKey TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '', atts TEXT NOT NULL DEFAULT '[]', refs TEXT NOT NULL DEFAULT '[]', mentions TEXT NOT NULL DEFAULT '[]',
    createdAt INTEGER NOT NULL, deletedAt INTEGER,
    PRIMARY KEY (origin, id),
    FOREIGN KEY (roomFp, roomId) REFERENCES rooms(creatorFp, id))`,
  "CREATE INDEX IF NOT EXISTS messages_room ON messages(roomFp, roomId, createdAt)",
  // 附件文件按内容寻址（STATE_DIR/talk/att/<sha256>）；谁能取由引用它的消息 / ask 决定，没人引用的只有上传者能取
  `CREATE TABLE IF NOT EXISTS atts (
    sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
    mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
    bytes INTEGER NOT NULL, createdAt INTEGER NOT NULL)`,
  // 同一张图可能被几个人各自传过：每个上传者在发出前都要能预览自己选的图
  `CREATE TABLE IF NOT EXISTS att_uploads (
    sha256 TEXT NOT NULL REFERENCES atts(sha256), uploader TEXT NOT NULL, createdAt INTEGER NOT NULL,
    PRIMARY KEY (sha256, uploader))`,
  `CREATE TABLE IF NOT EXISTS att_refs (
    sha256 TEXT NOT NULL REFERENCES atts(sha256), refKind TEXT NOT NULL CHECK (refKind IN ('msg','ask')), refId TEXT NOT NULL,
    PRIMARY KEY (sha256, refKind, refId))`,
  "CREATE INDEX IF NOT EXISTS att_refs_ref ON att_refs(refKind, refId)",
  `CREATE TABLE IF NOT EXISTS drops (
    dropId TEXT PRIMARY KEY CHECK (${uuidCheck("dropId", "td_")}),
    state TEXT NOT NULL CHECK (state IN ('sent','held','failed')),
    principal TEXT NOT NULL, personId TEXT NOT NULL, agent TEXT NOT NULL,
    roomFp TEXT NOT NULL, roomId TEXT NOT NULL, msgIds TEXT NOT NULL,
    contentSha TEXT NOT NULL, messageId TEXT NOT NULL, error TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS drops_message ON drops(messageId)",
];

const TALK_TABLES = ["people", "rooms", "members", "messages", "atts", "att_uploads", "att_refs", "drops"] as const;

const TALK_SCHEMA: SchemaSpec = {
  label: "talk 库",
  migrations: [V1],
  tables: TALK_TABLES,
  columns: { messages: ["origin", "id", "roomFp", "roomId", "authorKey", "mentions", "deletedAt"], drops: ["dropId", "state", "contentSha", "messageId"] },
  indexes: { members: ["members_key"], messages: ["messages_room"], att_refs: ["att_refs_ref"], drops: ["drops_message"] },
};

const DEFAULT_PATH = statePath("talk.sqlite");
const cache = new Map<string, Database>();

/** 打开（首次则建）talk 库：WAL + busy_timeout + 外键；同一路径复用一条连接（bridge 进程内唯一写者） */
export function openTalk(path: string = DEFAULT_PATH): Database {
  const hit = cache.get(path);
  if (hit) return hit;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, TALK_SCHEMA);
  } catch (e) {
    db.close();
    throw e;
  }
  cache.set(path, db);
  return db;
}


/** 附件目录：和 owner ↔ agent 共用的 inbox 分开，按房间鉴权（talk-atts.ts） */
export const TALK_ATT_DIR = statePath("talk", "att");
