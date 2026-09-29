/**
 * 旧 Next BFF 的数据 → bridge（docs/design-hosted-frontend.md §10 ②）。`manager migrate-web-state` 与 install-cli 的自动迁移
 * （lib/legacy-web.ts）都走 migrateWebState：
 *   1. 先把 ~/.claude-orchestrator/web/ 整目录 tar 进 backups/web-<时间戳>.tgz（回滚 = 还原它）
 *   2. settings.db 的 7 张表（apns_devices 不搬）按列名 INSERT OR IGNORE 进 web-state.sqlite（可重复执行）；登录会话只搬 sha256（legacy_sessions）
 *   3. web/config.json 的 groqApiKey / lang 补进 bridge 的 config.json（已设过的不覆盖）
 *   4. 仓库 web/.env.local 的 APNS_* / PUSH_VAPID_SUBJECT 补进仓库根 .env（bridge/push/init.ts 只读根 .env）
 * 旧数据只作废不删（tests/migrate-web-state.test.ts）。
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { adoptWebSettings } from "./config-store.js";
import { mergeEnvContent, readDotenvFileSync } from "./env-file.js";
import { assertNoRepoEnvWriteInTest } from "./test-guard.js";
import { STATE_DIR } from "./paths.js";
import { closeWebState, openWebState, WEB_STATE_TABLES } from "./web-state.js";

export interface TableCopy {
  /** 源表行数；源库没有这张表时为 null */
  rows: number | null;
  /** 这次真正插入的行数（已存在的被 IGNORE） */
  inserted: number;
}

const columnsOf = (db: Database, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const tablesOf = (db: Database): Set<string> =>
  new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));

/**
 * 只复制两边都有的列（旧库缺列 = 那列没数据；新库缺列 = 登录体系那类不搬的表根本不在清单里）。
 * apns_devices 不搬：旧库的行没记登记凭据，搬进来推送端没法按凭据收窄；壳下次启动会自己重新登记
 */
export function copyWebStateTables(src: Database, dst: Database): Record<string, TableCopy> {
  const srcTables = tablesOf(src);
  const out: Record<string, TableCopy> = {};
  for (const table of WEB_STATE_TABLES.filter((t) => t !== "apns_devices")) {
    if (!srcTables.has(table)) {
      out[table] = { rows: null, inserted: 0 };
      continue;
    }
    const srcCols = new Set(columnsOf(src, table));
    const cols = columnsOf(dst, table).filter((c) => srcCols.has(c));
    const rows = src.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Record<string, unknown>[];
    const insert = dst.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    let inserted = 0;
    dst.transaction(() => {
      for (const r of rows) inserted += insert.run(...cols.map((c) => r[c] as string | number | null)).changes;
    })();
    out[table] = { rows: rows.length, inserted };
  }
  return out;
}

export const sessionIdHash = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex");

/** 旧 sessions 表里没过期的会话 → legacy_sessions（只存 sha256，原文不落 bridge 的库）；返回搬了几条 */
export function importLegacySessions(src: Database, dst: Database, now: Date = new Date()): number {
  if (!tablesOf(src).has("sessions")) return 0;
  const rows = src.prepare("SELECT id, username, expires_at FROM sessions WHERE expires_at > ?").all(now.toISOString()) as
    { id: string; username: string; expires_at: string }[];
  const insert = dst.prepare("INSERT OR IGNORE INTO legacy_sessions (id_hash, username, expires_at) VALUES (?, ?, ?)");
  let n = 0;
  dst.transaction(() => {
    for (const r of rows) n += insert.run(sessionIdHash(r.id), r.username ?? "", r.expires_at).changes;
  })();
  return n;
}

export interface MigrateOpts {
  webDir?: string;
  backupDir?: string;
  /** 目标库路径（缺省 = 生产的 web-state.sqlite） */
  targetDb?: string;
  /** 单测换成不碰生产 config.json 的实现 */
  adopt?: typeof adoptWebSettings;
  /** 推送配置的搬运：调用方传仓库真实路径；不传 = 不搬（单测不会碰到真 .env） */
  env?: { webEnvLocal: string; envFile: string };
  now?: Date;
}

export interface MigrateResult {
  ok: true;
  backup: string;
  settingsDb: string | null;
  tables: Record<string, TableCopy> | null;
  /** 搬进 legacy_sessions 的旧登录会话数 */
  sessions: number;
  config: { groqApiKey: boolean; lang: boolean };
  /** 补进根 .env 的键 */
  env: string[];
}

const PUSH_ENV_RE = /^(APNS_[A-Z_]+|PUSH_VAPID_SUBJECT)$/;

/** 旧 .env.local 里的推送配置补进根 .env：只补缺、不改已有的值；返回补了哪些键 */
function carryPushEnv(webEnvLocal: string, envFile: string): string[] {
  const src = readDotenvFileSync(webEnvLocal);
  if (!src) return [];
  const have = readDotenvFileSync(envFile) ?? {};
  const updates = Object.fromEntries(Object.entries(src).filter(([k, v]) => PUSH_ENV_RE.test(k) && v && !(k in have)));
  const keys = Object.keys(updates);
  if (!keys.length) return [];
  assertNoRepoEnvWriteInTest(envFile);
  writeFileSync(envFile, mergeEnvContent(existsSync(envFile) ? readFileSync(envFile, "utf8") : null, updates, "# Claudestra"));
  return keys;
}

async function tarBackup(webDir: string, backupDir: string, now: Date): Promise<string> {
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `web-${now.toISOString().replace(/[:.]/g, "-")}.tgz`);
  const tar = Bun.spawn(["tar", "-czf", backup, "-C", dirname(webDir), basename(webDir)], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(tar.stderr).text();
  if ((await tar.exited) !== 0) throw new Error(`备份失败（未迁移任何数据）: ${err.trim()}`);
  return backup;
}

/** 只读打开：Next 还在跑时它持有 WAL；读不动（没有 -shm 且目录不可写）就退回可写打开——反正已经备份过 */
function openSource(path: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch (e) {
    console.warn(`⚠️ 只读打开 ${path} 失败，改为可写打开: ${(e as Error).message}`);
    return new Database(path);
  }
}

function readWebConfig(path: string): { groqApiKey?: unknown; lang?: unknown } {
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    console.warn(`⚠️ ${path} 不是合法 JSON，跳过设置迁移: ${(e as Error).message}`);
    return {};
  }
}

export async function migrateWebState(o: MigrateOpts = {}): Promise<MigrateResult | { ok: true; skipped: string }> {
  const webDir = o.webDir ?? join(STATE_DIR, "web");
  if (!existsSync(webDir)) return { ok: true, skipped: `没有旧 web 数据目录 ${webDir}，无需迁移` };
  const now = o.now ?? new Date();
  const backup = await tarBackup(webDir, o.backupDir ?? join(STATE_DIR, "backups"), now);
  const settingsDb = join(webDir, "db", "settings.db");
  let tables: Record<string, TableCopy> | null = null;
  let sessions = 0;
  // 旧 web 分两个库：设置在 settings.db，登录会话在 auth.db（web/lib/db/migrations/auth.ts）——会话两个都找，有表才搬
  for (const file of [settingsDb, join(webDir, "db", "auth.db")]) {
    if (!existsSync(file)) continue;
    const src = openSource(file);
    try {
      const dst = openWebState(o.targetDb);
      if (file === settingsDb) tables = copyWebStateTables(src, dst);
      sessions += importLegacySessions(src, dst, now);
    } finally {
      src.close();
      if (o.targetDb) closeWebState(o.targetDb);
    }
  }
  const config = await (o.adopt ?? adoptWebSettings)(readWebConfig(join(webDir, "config.json")));
  const env = o.env ? carryPushEnv(o.env.webEnvLocal, o.env.envFile) : [];
  return { ok: true, backup, settingsDb: tables ? settingsDb : null, tables, sessions, config, env };
}
