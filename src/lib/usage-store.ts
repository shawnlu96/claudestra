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
const CLAUDE = "claude-code";

/** 加列迁移要可重跑：已经有的列跳过 */
function addColumns(db: Database, table: string, cols: [string, string][]): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [col, decl] of cols) if (!have.has(col)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`).run();
}

/**
 * daily 换主键 (day, agent, runtime, model)：SQLite 改不了主键，建新表搬过去。老行的 runtime 是 v3 时的 MAX(runtime)，混过的分不开；
 * 还有明细的日子全部标脏，导完按明细重算成分开的行，明细已清掉的日子只能保持原样。可重跑：新表已在就只补标脏。
 */
function migrateDailyRuntime(db: Database): void {
  const pk = (db.prepare("PRAGMA table_info(daily)").all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name);
  if (!pk.includes("runtime")) {
    db.prepare(`CREATE TABLE daily_v4 (day TEXT NOT NULL, agent TEXT NOT NULL, runtime TEXT NOT NULL DEFAULT '${CLAUDE}', model TEXT NOT NULL,
      calls INTEGER NOT NULL, input INTEGER NOT NULL, cache_creation INTEGER NOT NULL, cache_read INTEGER NOT NULL, output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, agent, runtime, model))`).run();
    db.prepare(`INSERT INTO daily_v4 (day, agent, runtime, model, calls, input, cache_creation, cache_read, output, reasoning)
      SELECT day, agent, runtime, model, calls, input, cache_creation, cache_read, output, reasoning FROM daily`).run();
    db.prepare("DROP TABLE daily").run();
    db.prepare("ALTER TABLE daily_v4 RENAME TO daily").run();
  }
  db.prepare("INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT day FROM calls").run();
}

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
    // v2：files 记文件身份指纹（换了文件 / 截断重写就从头读）和当前轮那条输入的身份（队列附件与 user 记录认成同一轮）
    (db) => addColumns(db, "files", [["fp", "TEXT"], ["turn_input", "TEXT"]]),
    // v3（T92 Codex 计入）：运行时、reasoning 单列（Codex 的 output 里含 reasoning，拆出来）、文件的当前模型与父线程
    (db) => {
      addColumns(db, "files", [["runtime", "TEXT"], ["model", "TEXT"], ["parent", "TEXT"]]);
      addColumns(db, "calls", [["reasoning", "INTEGER NOT NULL DEFAULT 0"]]);
      addColumns(db, "turns", [["runtime", `TEXT NOT NULL DEFAULT '${CLAUDE}'`]]);
      addColumns(db, "daily", [["reasoning", "INTEGER NOT NULL DEFAULT 0"], ["runtime", `TEXT NOT NULL DEFAULT '${CLAUDE}'`]]);
    },
    // v4（T92 r1）：Codex record 与 token_count 的配对状态和认过的回声（usage-codex.ts countCall）；daily 主键加上 runtime（同 agent 同模型名的 Claude / Codex 不再并成一行）
    (db) => {
      addColumns(db, "files", [["cx_pair", "TEXT"]]);
      db.prepare("CREATE TABLE IF NOT EXISTS echoes (key TEXT PRIMARY KEY, ts INTEGER NOT NULL)").run();
      migrateDailyRuntime(db);
    },
  ],
  tables: ["files", "turns", "calls", "tools", "daily", "dirty_days", "echoes"],
  columns: { files: ["fp", "turn_input", "runtime", "model", "parent", "cx_pair"], calls: ["reasoning"], turns: ["runtime"], daily: ["reasoning", "runtime"] },
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
  /** 文件身份：dev:ino + 已读部分头尾各 4KB 的哈希（usage-ingest.ts 的 fingerprint） */
  fp: string | null;
  /** 当前轮那条外来输入的身份（usage-classify.ts 的 inboundIdentity），只有 channel 消息有 */
  turn_input: string | null;
  /** "codex" = Codex rollout（usage-codex.ts 解析）；null = Claude Code */
  runtime: string | null;
  /** Codex：最近一条 turn_context 的模型（请求模型） */
  model: string | null;
  /** Codex 子线程的父线程 id：主人跟父线程走 */
  parent: string | null;
  /** Codex：待配对的 token_usage_record / 刚配过的回声（usage-codex.ts countCall）；跨读块、跨增量导入要接得上 */
  cx_pair: string | null;
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
  runtime: string;
}

/** 导入要用的写语句（prepare 一次，逐行复用） */
export function usageWriter(db: Database) {
  const getFile = db.prepare("SELECT * FROM files WHERE path = ?");
  const cols = ["path", "offset", "size", "session_id", "agent", "sidechain", "turn_id", "turn_start", "turn_kind", "turn_trigger", "fp", "turn_input",
    "runtime", "model", "parent", "cx_pair"];
  const putFile = db.prepare(`INSERT INTO files (${cols.join(", ")}, updated_at) VALUES (${cols.map((c) => `$${c}`).join(", ")}, $now)
    ON CONFLICT(path) DO UPDATE SET ${[...cols.slice(1), "updated_at"].map((c) => `${c} = excluded.${c}`).join(", ")}`);
  const ensureTurn = db.prepare(`INSERT OR IGNORE INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // 同一响应的几行 usage 不一定相同（流式先写的行 output 偏小）：各项取最大 = 最后写完整的那行，与 cost 的 keepLatest 同一口径。
  // 时间也跟最后那行走（ts 取最大、day 随之改）：跨午夜的响应 cost --today 按最后一行算进今天，这里必须一样（tests/usage-ingest.test.ts「跨午夜」）
  const dayOfCall = db.prepare("SELECT day FROM calls WHERE key = ?");
  const upsertCall = db.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET input = max(input, excluded.input), cache_creation = max(cache_creation, excluded.cache_creation),
      cache_read = max(cache_read, excluded.cache_read), output = max(output, excluded.output), reasoning = max(reasoning, excluded.reasoning),
      day = CASE WHEN excluded.ts > ts THEN excluded.day ELSE day END, ts = max(ts, excluded.ts) RETURNING day`);
  const addTool = db.prepare("INSERT OR IGNORE INTO tools (tool_id, turn_id, name) VALUES (?, ?, ?)");
  const getEcho = db.prepare("SELECT 1 FROM echoes WHERE key = ?");
  const addEcho = db.prepare("INSERT OR IGNORE INTO echoes (key, ts) VALUES (?, ?)");
  const markDirty = db.prepare("INSERT OR IGNORE INTO dirty_days (day) VALUES (?)");
  const claim = db.prepare(`INSERT OR IGNORE INTO dirty_days (day) SELECT DISTINCT c.day FROM calls c JOIN turns t ON t.turn_id = c.turn_id
    WHERE t.session_id = ? AND t.agent = '${UNOWNED}'`);
  const claimTurns = db.prepare(`UPDATE turns SET agent = ? WHERE session_id = ? AND agent = '${UNOWNED}'`);
  const ownerOf = db.prepare(`SELECT agent FROM files WHERE session_id = ? AND agent != '${UNOWNED}' LIMIT 1`);
  return {
    file: (path: string) => getFile.get(path) as FileState | null,
    saveFile: (f: FileState) => putFile.run({ ...prefixed(f), $now: Date.now() }),
    turn: (t: TurnHead) => ensureTurn.run(t.turnId, t.agent, t.sessionId, t.sidechain ? 1 : 0, t.startedAt, t.kind, t.trigger, t.runtime),
    tool: (id: string, turnId: string, name: string) => addTool.run(id, turnId, name),
    isEcho: (key: string) => !!getEcho.get(key),
    noteEcho: (key: string, ts: number) => addEcho.run(key, Number.isFinite(ts) ? ts : Date.now()),
    /** 库里已经认出主人的会话（Codex 子线程按父线程找主人用）；没有 = null */
    knownOwner: (sessionId: string) => (ownerOf.get(sessionId) as { agent: string } | null)?.agent ?? null,
    /** 调用进库，并把它所在的那天标脏（日期因后到的行改了的话，原来那天也标），daily 之后按明细重算 */
    call(c: CallUsage, turnId: string): void {
      const before = dayOfCall.get(c.key) as { day: string } | null;
      const row = [c.key, turnId, c.ts, dayOf(c.ts), c.model, c.input, c.cacheCreation, c.cacheRead, c.output, c.reasoning ?? 0] as const;
      const { day } = upsertCall.get(...row) as { day: string };
      markDirty.run(day);
      if (before && before.day !== day) markDirty.run(before.day);
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
 * 按明细重算脏日子的 daily（每趟导入都跑，清理不清理都要）。保留期内的日子明细是全的，一律照明细重算（调用挪去别的日子后这天可能变空）；
 * 保留期之前的日子明细已清掉就不动：daily 是它唯一的记录，重算会把它抹成 0。
 */
export function rebuildDirtyDays(db: Database, cutoffMs = retentionCutoff()): number {
  const keepFrom = dayOf(cutoffMs);
  const days = (db.prepare("SELECT day FROM dirty_days").all() as { day: string }[]).map((r) => r.day);
  const has = db.prepare("SELECT 1 FROM calls WHERE day = ? LIMIT 1");
  const del = db.prepare("DELETE FROM daily WHERE day = ?");
  const ins = db.prepare(`INSERT INTO daily (day, agent, model, calls, input, cache_creation, cache_read, output, reasoning, runtime)
    SELECT c.day, t.agent, c.model, COUNT(*), SUM(c.input), SUM(c.cache_creation), SUM(c.cache_read), SUM(c.output), SUM(c.reasoning), t.runtime
    FROM calls c JOIN turns t ON t.turn_id = c.turn_id WHERE c.day = ? GROUP BY c.day, t.agent, t.runtime, c.model`);
  const clear = db.prepare("DELETE FROM dirty_days WHERE day = ?");
  db.transaction(() => {
    for (const d of days) {
      if (d >= keepFrom || has.get(d)) {
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
  rebuildDirtyDays(db, cutoffMs);
  const cutoffDay = dayOf(cutoffMs);
  let removed = 0;
  db.transaction(() => {
    removed = db.prepare("DELETE FROM calls WHERE day < ?").run(cutoffDay).changes;
    db.prepare("DELETE FROM turns WHERE started_at < ? AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.turn_id = turns.turn_id)").run(cutoffMs);
    db.prepare("DELETE FROM tools WHERE NOT EXISTS (SELECT 1 FROM turns t WHERE t.turn_id = tools.turn_id)").run();
    db.prepare("DELETE FROM echoes WHERE ts < ?").run(cutoffMs); // 保留期之前的 token_count 导入时本来就跳过，不用再认
  })();
  return removed;
}
