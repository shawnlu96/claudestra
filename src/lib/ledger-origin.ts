/**
 * 台账的本机前缀（docs/design/feature-dag.md §全局编号）：新对象（feature）的 id 和新事件的 origin 都带它，给以后同步到中心服务留位。
 * 取 STATE_DIR/instance-id 的前 4 位：它是专门的本机稳定 id（peer 握手也认它），不碰私钥文件；registry 没有实例名字段。
 * 第一次用到时写进库里的 ledger_instance 表固定下来：之后 instance-id 文件被换，已发出的 id / 事件序号也不漂。
 * 每次现查库、不做进程内缓存：事务里读到的可能是本事务刚插、随后回滚的值，缓存会把它留下（tests/ledger-feature.test.ts「事务回滚」）。
 * 读不到 instance-id（读写失败）就返回 null：事件照写只是不带 origin，建 feature 会拒绝——绝不拿没落盘的随机值当前缀。
 */
import type { Database } from "bun:sqlite";
import { instanceIdSync } from "./instance-id.js";

const ORIGIN_KEY = "origin";
const PREFIX_LEN = 4;

function hasTable(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_instance'").get();
}

/** 只读：库里已固定的前缀，还没固定就是 null（读命令用它，不顺手写库） */
export function storedOrigin(db: Database): string | null {
  if (!hasTable(db)) return null;
  return (db.query("SELECT value FROM ledger_instance WHERE key = ?").get(ORIGIN_KEY) as { value: string } | null)?.value ?? null;
}

/** 本库的前缀；首次调用时从 instance-id 取并落库（INSERT OR IGNORE：并发首用时以先写进去的为准） */
export function ledgerOrigin(db: Database, source: () => string = () => instanceIdSync().slice(0, PREFIX_LEN)): string | null {
  const stored = storedOrigin(db);
  if (stored || !hasTable(db)) return stored;
  const fresh = source();
  if (!/^[0-9a-z]{4}$/.test(fresh)) return null;
  db.prepare("INSERT OR IGNORE INTO ledger_instance (key, value) VALUES (?, ?)").run(ORIGIN_KEY, fresh);
  return storedOrigin(db);
}

/**
 * events 的 origin / originSeq 两列的 VALUES 片段与参数：序号在同一条 INSERT 里用子查询算（单条语句原子，不依赖调用方有没有开事务）。
 * origin 为 null 时序号也是 null（老代码 / 取不到前缀写的事件都这样，读侧按「无来源」处理）。
 */
export const ORIGIN_VALUES = "?, CASE WHEN ? IS NULL THEN NULL ELSE (SELECT COALESCE(MAX(originSeq), 0) + 1 FROM events WHERE origin = ?) END";

export function originArgs(db: Database): [string | null, string | null, string | null] {
  const o = ledgerOrigin(db);
  return [o, o, o];
}
