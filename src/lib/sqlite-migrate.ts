/**
 * bun:sqlite 库的 schema 迁移：PRAGMA user_version + 只往末尾追加的步骤表，下标 i 把库从 v i 升到 v i+1。
 * 规矩与台账同一套：一条语句一次 prepare().run()（bun 的多语句 exec 会吞运行期错误，版本号却照样往前推）；
 * 第 1 步之后的每一步都必须可重跑（IF NOT EXISTS、加列先查列），因为版本号到了而表 / 列 / 索引缺时要从第 2 步起重跑补齐。
 */
import type { Database } from "bun:sqlite";

/** 一步迁移：一组单条 SQL，或要先查现状的函数（如加列）。别写成一段多语句字符串 */
type Migration = readonly string[] | ((db: Database) => void);

export interface SchemaSpec {
  /** 报错里的库名，如「talk 库」 */
  label: string;
  migrations: readonly Migration[];
  /** 迁移后必须在的表 / 列 / 索引：新加的迁移把自己的关键表、列、索引补进来 */
  tables: readonly string[];
  columns?: Record<string, readonly string[]>;
  indexes?: Record<string, readonly string[]>;
}

export function schemaVersion(db: Database): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** 缺的表 / 列 / 索引（`表`、`表.列`、`index 表.索引`）；空数组 = 完整 */
export function missingSchema(db: Database, spec: SchemaSpec): string[] {
  const rows = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { type: string; name: string; tbl_name: string }[];
  const tables = new Set(rows.filter((r) => r.type === "table").map((r) => r.name));
  const indexes = new Set(rows.filter((r) => r.type === "index").map((r) => `${r.tbl_name}.${r.name}`));
  const missing: string[] = spec.tables.filter((t) => !tables.has(t));
  for (const [table, names] of Object.entries(spec.indexes ?? {})) missing.push(...names.filter((n) => !indexes.has(`${table}.${n}`)).map((n) => `index ${table}.${n}`));
  for (const [table, cols] of Object.entries(spec.columns ?? {})) {
    if (!tables.has(table)) continue;
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    missing.push(...cols.filter((c) => !have.has(c)).map((c) => `${table}.${c}`));
  }
  return missing;
}

function runStep(db: Database, step: Migration): void {
  if (typeof step === "function") step(db);
  else for (const sql of step) db.prepare(sql).run();
}

const isBusy = (e: unknown): boolean => String((e as { code?: unknown })?.code ?? "").startsWith("SQLITE_BUSY");

/**
 * IMMEDIATE 事务里先重读版本：两个进程同时首次打开时，后到的看到已迁移就什么都不做。
 * 库的版本比代码新不报错：worktree 里的分支代码会打开同一个库（CLI 从分支跑），main 的代码照样要能用，只核对自己要的表和列。
 * 失败整体回滚；SQLITE_BUSY 原样抛给调用方（它知道怎么说「稍后重试」）。
 */
export function runMigrations(db: Database, spec: SchemaSpec): void {
  const steps = spec.migrations;
  if (schemaVersion(db) >= steps.length && missingSchema(db, spec).length === 0) return;
  // 报错里的版本号要是回滚后的：事务里的 user_version 已被推过，库文件里还是进事务时读到的那个
  let from = schemaVersion(db);
  try {
    db.transaction(() => {
      from = schemaVersion(db);
      for (let v = from; v < steps.length; v++) {
        runStep(db, steps[v]);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      if (from > 0 && missingSchema(db, spec).length) for (const step of steps.slice(1)) runStep(db, step);
      const still = missingSchema(db, spec);
      if (still.length) throw new Error(`迁移后仍缺：${still.join(", ")}`);
    }).immediate();
  } catch (e) {
    if (isBusy(e)) throw e;
    throw new Error(`${spec.label}迁移失败（${(e as Error).message}），已回滚，库仍是 v${from}`, { cause: e });
  }
}
