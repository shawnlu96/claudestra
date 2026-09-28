/**
 * 内置台账的库（docs 10-ledger §2 §3）：打开、建表迁移、行映射、只读查询。写入在 ledger-write.ts（每次写一个 BEGIN IMMEDIATE 事务）。
 * bun:sqlite + WAL + busy_timeout：CLI、bridge 等多个进程同时开同一个文件；按路径只开一次，测试传 ":memory:" 或临时路径（先例 web-state.ts）。
 * events 表只追加：没有改 / 删事件的导出函数，库里再用 trigger 拦 UPDATE / DELETE。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventKind, LedgerEvent, LedgerItem, LedgerTask } from "./ledger-stages.js";
import { statePath } from "./paths.js";

export const LEDGER_PATH = statePath("ledger.sqlite");
export const LEDGER_TABLES = ["items", "tasks", "events", "meta"] as const;
/** PRAGMA user_version；升级时在 MIGRATIONS 末尾追加一步，旧库按顺序补齐 */
export const LEDGER_SCHEMA_VERSION = 1;
/** 另一个进程持有写锁时最多等这么久，再报 SQLITE_BUSY */
const BUSY_TIMEOUT_MS = 5000;
/** 切 WAL 时每次尝试只等这么久，总时长由 ensureWal 的退避循环控制在 BUSY_TIMEOUT_MS 内 */
const WAL_TRY_TIMEOUT_MS = 100;

const cache = new Map<string, Database>();

/** busy = 等写锁超过 BUSY_TIMEOUT_MS（别的进程长时间占着库），可以重试 */
export type LedgerErrorCode = "conflict" | "not_found" | "forbidden" | "invalid" | "dedup_mismatch" | "busy";

/** 写入被拒的统一错误；current 带上冲突时库里的实际值（当前阶段 / rev），CLI 原样打印 */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly current?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

const SCHEMA_V1 = `
CREATE TABLE items (
  project TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
  ownerWords TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('todo','decide','design','doing','done','dropped')),
  oneLine TEXT NOT NULL DEFAULT '', next TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1, extra TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  PRIMARY KEY (project, id));
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, itemId TEXT, title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code','investigate','ops')),
  stage TEXT NOT NULL CHECK (stage IN ('spec','restate','build','review','fix','merge','live','verified','done','blocked','cancelled')),
  stageBefore TEXT, round INTEGER NOT NULL DEFAULT 0,
  agent TEXT, pm TEXT, branch TEXT, pr TEXT, headSHA TEXT, spec TEXT,
  specRev INTEGER NOT NULL DEFAULT 1, model TEXT,
  rev INTEGER NOT NULL DEFAULT 1, extra TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  FOREIGN KEY (project, itemId) REFERENCES items(project, id));
CREATE INDEX tasks_project ON tasks(project);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  actor TEXT NOT NULL, project TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
  dedupKey TEXT UNIQUE);
CREATE INDEX events_project_target ON events(project, target, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'ledger events are append-only'); END;
CREATE TABLE meta (
  project TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, PRIMARY KEY (project, key));
`;

/** 下标 i 把库从版本 i 升到 i+1 */
const MIGRATIONS: string[] = [SCHEMA_V1];

function isBusy(e: unknown): boolean {
  return String((e as { code?: unknown })?.code ?? "").startsWith("SQLITE_BUSY");
}

/** 把等锁超时的 SQLITE_BUSY 换成 LedgerError("busy")，CLI 能给出清楚的报错；其它错误原样抛 */
export function busyAsLedgerError<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (isBusy(e)) throw new LedgerError("busy", `台账库忙（${what}等锁超过 ${BUSY_TIMEOUT_MS / 1000}s），稍后重试`);
    throw e;
  }
}

/**
 * 多个进程同时首次打开新库时，切 WAL 会直接 SQLITE_BUSY（审查实测 8 路并发约 1/10）。
 * 所以先读当前模式，已是 WAL 就不再切；遇到 BUSY 就退避重试，到期限还不行再抛。
 * 调用方要先把 busy_timeout 调成 WAL_TRY_TIMEOUT_MS，否则第一次尝试就会先卡满 5s，总等待变成约 10s，和报错文案对不上。
 */
function ensureWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
      if (mode !== "wal" && mode !== "memory") db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      if (!isBusy(e) || Date.now() > deadline) throw e;
      Bun.sleepSync(10 + Math.random() * 40);
    }
  }
}

export function openLedger(path: string = LEDGER_PATH): Database {
  const hit = cache.get(path);
  if (hit) return hit;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    busyAsLedgerError("打开时", () => {
      db.exec(`PRAGMA busy_timeout = ${WAL_TRY_TIMEOUT_MS}`);
      ensureWal(db);
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
    });
  } catch (e) {
    db.close();
    throw e;
  }
  cache.set(path, db);
  return db;
}

export function closeLedger(path: string = LEDGER_PATH): void {
  cache.get(path)?.close();
  cache.delete(path);
}

export function schemaVersion(db: Database): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** IMMEDIATE 事务里先重读版本：两个进程同时首次打开时，后到的看到已迁移就什么都不做 */
function migrate(db: Database): void {
  if (schemaVersion(db) >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  }).immediate();
}

// ── 行映射 ──

type Row = Record<string, unknown>;

function parseJson(s: unknown): Record<string, unknown> {
  if (typeof s !== "string" || !s) return {};
  const v = JSON.parse(s) as unknown;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function toItem(r: Row): LedgerItem {
  return { ...(r as unknown as LedgerItem), extra: parseJson(r.extra) };
}

export function toTask(r: Row): LedgerTask {
  return { ...(r as unknown as LedgerTask), extra: parseJson(r.extra) };
}

export function toEvent(r: Row): LedgerEvent {
  return { ...(r as unknown as LedgerEvent), kind: r.kind as EventKind, data: parseJson(r.data) };
}

// ── 读 ──

export function getItem(db: Database, project: string, id: string): LedgerItem | null {
  const r = db.prepare("SELECT * FROM items WHERE project = ? AND id = ?").get(project, id) as Row | null;
  return r ? toItem(r) : null;
}

export function listItems(db: Database, project: string): LedgerItem[] {
  return (db.prepare("SELECT * FROM items WHERE project = ? ORDER BY id").all(project) as Row[]).map(toItem);
}

export function getTask(db: Database, id: string): LedgerTask | null {
  const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null;
  return r ? toTask(r) : null;
}

export function listTasks(db: Database, project: string): LedgerTask[] {
  return (db.prepare("SELECT * FROM tasks WHERE project = ? ORDER BY id").all(project) as Row[]).map(toTask);
}

export interface EventQuery {
  project?: string;
  target?: string;
  /** 只要 seq 大于它的 */
  afterSeq?: number;
  limit?: number;
}

/** 按 seq 升序（即写入顺序）；ts 由写入时填，同一毫秒的多条以 seq 定先后 */
export function listEvents(db: Database, q: EventQuery = {}): LedgerEvent[] {
  const conds: [string, string | number | undefined][] = [
    ["project = ?", q.project],
    ["target = ?", q.target],
    ["seq > ?", q.afterSeq],
  ];
  const used = conds.filter((c): c is [string, string | number] => c[1] !== undefined);
  const where = used.map((c) => c[0]);
  const args = used.map((c) => c[1]);
  const sql = `SELECT * FROM events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY seq${q.limit ? " LIMIT ?" : ""}`;
  if (q.limit) args.push(q.limit);
  return (db.prepare(sql).all(...args) as Row[]).map(toEvent);
}

export function getEventByDedup(db: Database, dedupKey: string): LedgerEvent | null {
  const r = db.prepare("SELECT * FROM events WHERE dedupKey = ?").get(dedupKey) as Row | null;
  return r ? toEvent(r) : null;
}

export interface QueueFrozen {
  frozen: boolean;
  reason: string;
  since: number | null;
}

/** 编排班子（docs 10-ledger「附：编排班子」）：开了才有事件路由；dispatcher 为 null = 交付直接通知 PM。只有 owner 能设 */
export interface TeamConfig {
  dispatcher: string | null;
  /** 巡检开关，T29 读 */
  audit: boolean;
  /** 开班子那条 meta 事件的 seq：路由只管它之后的事件，开班子前的历史不补发 */
  sinceSeq: number;
}

export interface LedgerMeta {
  /** 项目 PM 名单；只有 owner 能设 */
  pms: string[];
  /** 规格卡 / 报告所在目录；只有 owner 能设 */
  docsDir: string | null;
  queueFrozen: QueueFrozen;
  team: TeamConfig | null;
}

function toTeam(v: unknown): TeamConfig | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  if (typeof t.sinceSeq !== "number") return null;
  return { dispatcher: typeof t.dispatcher === "string" && t.dispatcher ? t.dispatcher : null, audit: t.audit !== false, sinceSeq: t.sinceSeq };
}

export function getMeta(db: Database, project: string): LedgerMeta {
  const rows = db.prepare("SELECT key, value FROM meta WHERE project = ?").all(project) as { key: string; value: string }[];
  const kv = new Map(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]));
  const pms = kv.get("pms");
  const docsDir = kv.get("docsDir");
  const frozen = kv.get("queueFrozen") as QueueFrozen | undefined;
  return {
    pms: Array.isArray(pms) ? pms.filter((p): p is string => typeof p === "string") : [],
    docsDir: typeof docsDir === "string" ? docsDir : null,
    queueFrozen: frozen ?? { frozen: false, reason: "", since: null },
    team: toTeam(kv.get("team")),
  };
}
