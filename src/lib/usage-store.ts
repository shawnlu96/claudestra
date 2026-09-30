/**
 * token 账（T83）的独立库 ~/.claude-orchestrator/usage/usage.sqlite：不碰台账 ledger.sqlite。
 * 数字只存一份（calls 按去重键做主键），轮的合计、看到的上下文都是查询时从 calls 聚合，所以重复导入 / 同一会话的归档副本不会翻倍。
 * 明细（calls / turns / tools）保留 30 天；daily（agent×日×模型）永久，只在那天的明细还在时重算。说明见 docs/architecture/token-usage.md。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { statePath } from "./paths.js";
import { runMigrations, type SchemaSpec } from "./sqlite-migrate.js";
import type { CallUsage } from "./usage-classify.js";

export const USAGE_DB_PATH = statePath("usage", "usage.sqlite");
const RETENTION_DAYS = 30;
export const UNOWNED = "unowned";

const SCHEMA: SchemaSpec = {
  label: "token 账库",
  migrations: [
    [
      `CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, size INTEGER NOT NULL, session_id TEXT NOT NULL,
        agent TEXT NOT NULL, sidechain INTEGER NOT NULL, turn_id TEXT, turn_start INTEGER, turn_kind TEXT, turn_trigger TEXT, updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, sidechain INTEGER NOT NULL,
        started_at INTEGER NOT NULL, kind TEXT NOT NULL, trigger TEXT NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS turns_agent ON turns(agent, started_at)",
      "CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id)",
      `CREATE TABLE IF NOT EXISTS calls (key TEXT PRIMARY KEY, turn_id TEXT NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL,
        input INTEGER NOT NULL, cache_creation INTEGER NOT NULL, cache_read INTEGER NOT NULL, output INTEGER NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS calls_turn ON calls(turn_id)",
      "CREATE INDEX IF NOT EXISTS calls_day ON calls(day)",
      "CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts)",
      "CREATE TABLE IF NOT EXISTS tools (tool_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, name TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS tools_turn ON tools(turn_id)",
      `CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL, input INTEGER NOT NULL,
        cache_creation INTEGER NOT NULL, cache_read INTEGER NOT NULL, output INTEGER NOT NULL, PRIMARY KEY (day, agent, model))`,
      "CREATE TABLE IF NOT EXISTS dirty_days (day TEXT PRIMARY KEY)",
    ],
  ],
  tables: ["files", "turns", "calls", "tools", "daily", "dirty_days"],
  indexes: { turns: ["turns_agent", "turns_session"], calls: ["calls_turn", "calls_day", "calls_ts"], tools: ["tools_turn"] },
};

/** 打开（没有就建）token 账库；多个进程可同时开（WAL + busy_timeout） */
export function openUsageDb(path = USAGE_DB_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 10000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, SCHEMA);
  return db;
}

/** 本地日期 YYYY-MM-DD（与 cost --today 的「本地 00:00 起」同一口径） */
function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 明细保留下界：本地 00:00 往前数 RETENTION_DAYS 天。早于它的记录导入时直接跳过，清理也按它 */
export function retentionCutoff(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - RETENTION_DAYS);
  return d.getTime();
}

export interface FileState {
  path: string;
  offset: number;
  size: number;
  session_id: string;
  agent: string;
  sidechain: number;
  turn_id: string | null;
  turn_start: number | null;
  turn_kind: string | null;
  turn_trigger: string | null;
}

export interface TurnHead {
  turnId: string;
  agent: string;
  sessionId: string;
  sidechain: boolean;
  startedAt: number;
  /** 来源类型（usage-classify.ts 的 InboundKind）；存进 files 表再读回来就是普通字符串 */
  kind: string;
  trigger: string;
}

/** 导入要用的写语句（prepare 一次，逐行复用） */
export function usageWriter(db: Database) {
  const getFile = db.prepare("SELECT * FROM files WHERE path = ?");
  const putFile = db.prepare(`INSERT INTO files (path, offset, size, session_id, agent, sidechain, turn_id, turn_start, turn_kind, turn_trigger, updated_at)
    VALUES ($path, $offset, $size, $session_id, $agent, $sidechain, $turn_id, $turn_start, $turn_kind, $turn_trigger, $now)
    ON CONFLICT(path) DO UPDATE SET offset = excluded.offset, size = excluded.size, session_id = excluded.session_id, agent = excluded.agent,
      sidechain = excluded.sidechain, turn_id = excluded.turn_id, turn_start = excluded.turn_start, turn_kind = excluded.turn_kind,
      turn_trigger = excluded.turn_trigger, updated_at = excluded.updated_at`);
  const ensureTurn = db.prepare(`INSERT OR IGNORE INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // 同一响应的几行 usage 不一定相同（流式先写的行 output 偏小）：各项取最大 = 最后写完整的那行，与 cost 的 keepLatest 同一口径
  const upsertCall = db.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET input = max(input, excluded.input), cache_creation = max(cache_creation, excluded.cache_creation),
      cache_read = max(cache_read, excluded.cache_read), output = max(output, excluded.output) RETURNING day`);
  const addTool = db.prepare("INSERT OR IGNORE INTO tools (tool_id, turn_id, name) VALUES (?, ?, ?)");
  const markDirty = db.prepare("INSERT OR IGNORE INTO dirty_days (day) VALUES (?)");
  const claim = db.prepare(`INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT c.day FROM calls c JOIN turns t ON t.turn_id = c.turn_id
    WHERE t.session_id = ? AND t.agent = '${UNOWNED}'`);
  const claimTurns = db.prepare(`UPDATE turns SET agent = ? WHERE session_id = ? AND agent = '${UNOWNED}'`);
  return {
    file: (path: string) => getFile.get(path) as FileState | null,
    saveFile: (f: FileState) => putFile.run({ ...prefixed(f), $now: Date.now() }),
    turn: (t: TurnHead) => ensureTurn.run(t.turnId, t.agent, t.sessionId, t.sidechain ? 1 : 0, t.startedAt, t.kind, t.trigger),
    /** 调用进库，并把它所在的那天（已有的键沿用第一次记的日期）标脏，daily 之后按明细重算 */
    call(c: CallUsage, turnId: string): void {
      const { day } = upsertCall.get(c.key, turnId, c.ts, dayOf(c.ts), c.model, c.input, c.cacheCreation, c.cacheRead, c.output) as { day: string };
      markDirty.run(day);
      for (const t of c.tools) addTool.run(t.id, turnId, t.name);
    },
    /** 之前记成 unowned 的会话后来认出了主人（归档快照晚到）：改归属并把涉及的日子标脏 */
    claimSession(sessionId: string, agent: string): void {
      if (agent === UNOWNED) return;
      claim.run(sessionId);
      claimTurns.run(agent, sessionId);
    },
  };
}

function prefixed(f: FileState): Record<string, string | number | null> {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [`$${k}`, v]));
}

/**
 * 按明细重算脏日子的 daily（每趟导入都跑，清理不清理都要）。那天已经没有明细（超期清掉了）就不动：daily 是它唯一的记录，重算会把它抹成 0。
 */
export function rebuildDirtyDays(db: Database): number {
  const days = (db.prepare("SELECT day FROM dirty_days").all() as { day: string }[]).map((r) => r.day);
  const has = db.prepare("SELECT 1 FROM calls WHERE day = ? LIMIT 1");
  const del = db.prepare("DELETE FROM daily WHERE day = ?");
  const ins = db.prepare(`INSERT INTO daily (day, agent, model, calls, input, cache_creation, cache_read, output)
    SELECT c.day, t.agent, c.model, COUNT(*), SUM(c.input), SUM(c.cache_creation), SUM(c.cache_read), SUM(c.output)
    FROM calls c JOIN turns t ON t.turn_id = c.turn_id WHERE c.day = ? GROUP BY c.day, t.agent, c.model`);
  const clear = db.prepare("DELETE FROM dirty_days WHERE day = ?");
  db.transaction(() => {
    for (const d of days) {
      if (has.get(d)) {
        del.run(d);
        ins.run(d);
      }
      clear.run(d);
    }
  })();
  return days.length;
}

/** 清掉保留期之前的明细（先重算脏日子，daily 拿到的是清理前的完整数字）；返回删掉的调用数 */
export function pruneUsage(db: Database, cutoffMs = retentionCutoff()): number {
  rebuildDirtyDays(db);
  const cutoffDay = dayOf(cutoffMs);
  let removed = 0;
  db.transaction(() => {
    removed = db.prepare("DELETE FROM calls WHERE day < ?").run(cutoffDay).changes;
    db.prepare("DELETE FROM turns WHERE started_at < ? AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.turn_id = turns.turn_id)").run(cutoffMs);
    db.prepare("DELETE FROM tools WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.turn_id = tools.turn_id)").run();
  })();
  return removed;
}
