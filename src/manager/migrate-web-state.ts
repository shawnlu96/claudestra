/**
 * `manager migrate-web-state`（docs/design-hosted-frontend.md §10 ②）：旧 Next BFF 的数据搬进 bridge。
 *   1. 先把 ~/.claude-orchestrator/web/ 整目录 tar 进 ~/.claude-orchestrator/backups/web-<时间戳>.tgz（回滚 = 还原它）
 *   2. web/db/settings.db 的 8 张表 INSERT OR IGNORE 进 web-state.sqlite（lib/web-state-migrate.ts；可重复执行）
 *   3. web/config.json 的 groqApiKey / lang 补进 bridge 的 config.json（已设过的不覆盖）
 * 旧数据只作废不删；旧 Next 可以继续跑（它只读自己那份）。
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { adoptWebSettings } from "../lib/config-store.js";
import { STATE_DIR } from "../lib/paths.js";
import { closeWebState, openWebState } from "../lib/web-state.js";
import { copyWebStateTables, type TableCopy } from "../lib/web-state-migrate.js";
import { output } from "./core.js";

export interface MigrateOpts {
  webDir?: string;
  backupDir?: string;
  /** 目标库路径（缺省 = 生产的 web-state.sqlite） */
  targetDb?: string;
  /** 单测换成不碰生产 config.json 的实现 */
  adopt?: typeof adoptWebSettings;
  now?: Date;
}

export interface MigrateResult {
  ok: true;
  backup: string;
  settingsDb: string | null;
  tables: Record<string, TableCopy> | null;
  config: { groqApiKey: boolean; lang: boolean };
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
  const backup = await tarBackup(webDir, o.backupDir ?? join(STATE_DIR, "backups"), o.now ?? new Date());
  const settingsDb = join(webDir, "db", "settings.db");
  let tables: Record<string, TableCopy> | null = null;
  if (existsSync(settingsDb)) {
    const src = openSource(settingsDb);
    try {
      tables = copyWebStateTables(src, openWebState(o.targetDb));
    } finally {
      src.close();
      if (o.targetDb) closeWebState(o.targetDb);
    }
  }
  const config = await (o.adopt ?? adoptWebSettings)(readWebConfig(join(webDir, "config.json")));
  return { ok: true, backup, settingsDb: tables ? settingsDb : null, tables, config };
}

export async function cmdMigrateWebState(): Promise<void> {
  output({ ...(await migrateWebState()) });
}
