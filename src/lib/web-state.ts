/**
 * bridge 侧的 web 状态库（docs/design-hosted-frontend.md §9）：原 Next BFF 的 settings.db 里要保留的 8 张表，bun:sqlite、WAL、
 * 按路径只打开一次。表结构与列名照搬 web/lib/db/migrations/settings.ts（迁移脚本按列复制，不做转换）；登录体系那几张表不搬。
 * 推送（bridge/push/*）与本地 API（bridge/local-api/*）都从这里拿 db；测试传 ":memory:" 或临时路径。
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureInboundTable } from "./inbound-ledger.js";
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
  try {
    if (path !== ":memory:") chmodSync(path, 0o600); // 推送凭据、入站账：只给本 OS 用户读写（-wal / -shm 由 SQLite 按主库权限建）
  } catch (e) {
    console.error(`web 状态库没能收紧到 0600（推送 / 本地 API 照常）: ${(e as Error).message}`);
  }
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
  const subCols = (db.prepare("PRAGMA table_info(push_subscriptions)").all() as { name: string }[]).map((c) => c.name);
  if (!subCols.includes("vapid_key")) db.exec("ALTER TABLE push_subscriptions ADD COLUMN vapid_key TEXT");
  // 订阅是谁的（T11b）：owner 的收全部推送；guest 设备只收指派给自己的「待你处理」。老行都是 owner 的（此前只有 owner 能订阅）
  if (!subCols.includes("audience")) db.exec("ALTER TABLE push_subscriptions ADD COLUMN audience TEXT NOT NULL DEFAULT 'owner'");
  if (!subCols.includes("principal")) db.exec("ALTER TABLE push_subscriptions ADD COLUMN principal TEXT");
  if (!subCols.includes("credential")) db.exec("ALTER TABLE push_subscriptions ADD COLUMN credential TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS push_read (agent TEXT PRIMARY KEY, ts INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS hidden_messages (
    agent TEXT NOT NULL, session_id TEXT NOT NULL, seq_from INTEGER NOT NULL, seq_to INTEGER NOT NULL, hidden_at INTEGER NOT NULL,
    PRIMARY KEY (agent, session_id, seq_from))`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_unread (
    agent TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_reply_ts INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS apns_devices (
    token TEXT PRIMARY KEY, device TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_seen TEXT NOT NULL)`);
  // APNs 登记时的凭据（T11b）：「待你处理」按它过 ask-access，凭据撤了就不再推。加列时清掉老行：不知道是谁登记的，留着就按全权推、
  // 撤了凭据也照推（撤掉的设备登记不回来）；壳每次启动、已授权时都会重新登记，手机打开一次 App 就恢复推送（tests/web-state.test.ts）
  const apnsCols = (db.prepare("PRAGMA table_info(apns_devices)").all() as { name: string }[]).map((c) => c.name);
  if (!apnsCols.includes("principal")) {
    db.exec("ALTER TABLE apns_devices ADD COLUMN principal TEXT");
    db.exec("DELETE FROM apns_devices");
  }
  if (!apnsCols.includes("credential")) db.exec("ALTER TABLE apns_devices ADD COLUMN credential TEXT");
  // 协作视图「上次以来」（lib/last-seen.ts）：按 principal × 视图记上次看的时刻。不在 WEB_STATE_TABLES 里——旧 BFF 没有这张表，迁移不搬
  db.exec(`CREATE TABLE IF NOT EXISTS last_seen (principal TEXT NOT NULL, scope TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (principal, scope))`);
  // 旧 web 的登录会话（只存 sha256）：升级后浏览器带着旧 cstra_session 来，一次性换成设备凭据（lib/legacy-web.ts）
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_sessions (
    id_hash TEXT PRIMARY KEY, username TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL, used_at TEXT)`);
  ensureInboundTable(db); // 非 CC 会话的入站账（lib/inbound-ledger.ts）：旧 BFF 没有，同样不进 WEB_STATE_TABLES
}
