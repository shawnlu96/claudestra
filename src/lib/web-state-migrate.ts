/**
 * 旧 Next BFF 的 settings.db → bridge 的 web-state.sqlite：8 张表按列名复制，INSERT OR IGNORE（主键已有的行不动 = 可重复执行）。
 * 只复制两边都有的列（旧库缺列 = 那列没数据；新库缺列 = 登录体系那类不搬的表根本不在清单里）。
 * 纯函数：两个 Database 由调用方给（manager/migrate-web-state.ts 用真文件，tests/migrate-web-state.test.ts 用临时库）。
 */
import type { Database } from "bun:sqlite";
import { WEB_STATE_TABLES } from "./web-state.js";

export interface TableCopy {
  /** 源表行数；源库没有这张表时为 null */
  rows: number | null;
  /** 这次真正插入的行数（已存在的被 IGNORE） */
  inserted: number;
}

const columnsOf = (db: Database, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

export function copyWebStateTables(src: Database, dst: Database): Record<string, TableCopy> {
  const srcTables = new Set((src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  const out: Record<string, TableCopy> = {};
  for (const table of WEB_STATE_TABLES) {
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
