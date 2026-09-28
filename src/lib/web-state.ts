/**
 * bridge 侧的 web 状态库（docs/design-hosted-frontend.md §9）：原 Next BFF 的 settings.db 里要保留的 8 张表，bun:sqlite、WAL、
 * 按路径只打开一次。表结构与列名照搬 web/lib/db/migrations/settings.ts（迁移脚本按列复制，不做转换）；登录体系那几张表不搬。
 * 推送（bridge/push/*）与本地 API（bridge/local-api/*）都从这里拿 db；测试传 ":memory:" 或临时路径。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths.js";

const WEB_STATE_PATH = join(STATE_DIR, "web-state.sqlite");
const cache = new Map<string, Database>();

/** 表名（迁移脚本与测试按这份清单核对） */
export const WEB_STATE_TABLES = ["agent_settings", "user_profile", "skill_prefs", "push_subscriptions", "push_read", "hidden_messages", "agent_unread", "apns_devices"] as const;

export function openWebState(path: string = WEB_STATE_PATH): Database {
  const hit = cache.get(path);
  if (hit) return hit;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  cache.set(path, db);
  return db;
}

export function closeWebState(path: string = WEB_STATE_PATH): void {
  cache.get(path)?.close();
  cache.delete(path);
}

function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_settings (
    agent TEXT PRIMARY KEY, init_message TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1), nickname TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
    claude_nickname TEXT NOT NULL DEFAULT '', claude_avatar TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE TABLE IF NOT EXISTS skill_prefs (
    name TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, used_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, ua TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`);
  // 订阅是用哪把 VAPID 公钥订的（中继的 / 本机的）：投递按它选路（bridge/push/sender.ts）。老库补列，老行 NULL，第一次投成功时记上
  if (!(db.prepare("PRAGMA table_info(push_subscriptions)").all() as { name: string }[]).some((c) => c.name === "vapid_key")) {
    db.exec("ALTER TABLE push_subscriptions ADD COLUMN vapid_key TEXT");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS push_read (agent TEXT PRIMARY KEY, ts INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS hidden_messages (
    agent TEXT NOT NULL, session_id TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, hidden_at INTEGER NOT NULL,
    PRIMARY KEY (agent, session_id, seq_from))`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_unread (
    agent TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_reply_ts INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS apns_devices (
    token TEXT PRIMARY KEY, device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_seen TEXT NOT NULL)`);
  // 旧 web 的登录会话（只存 sha256）：升级后浏览器带着旧 cstra_session 来，一次性换成设备凭据（lib/legacy-web.ts）
  // 协作视图「上次以来」（lib/last-seen.ts）：按 principal × 视图记上次看的时刻。不在 WEB_STATE_TABLES 里——旧 BFF 没有这张表，迁移不搬
  db.exec(`CREATE TABLE IF NOT EXISTS last_seen (principal TEXT NOT NULL, scope TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (principal, scope))`);
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_sessions (
    id_hash TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, used_at TEXT)`);
}
