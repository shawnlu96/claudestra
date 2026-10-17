/**
 * 自动升档（TIER3c）的持久化：状态目录下独立的 task-tier-escalation.sqlite（不动台账表结构、不进核心调度热点）。
 * 去重 = 项目 + 卡号 + 事实 id 的主键；每批事实在一个 immediate 事务里核对、计数、升档，跨进程 / 重启 / 重放同一事实只算一次。
 * 每张卡：fix = 未消费的真实退回次数，ci = 未消费的 CI 连红，steps = 已授予的升档级数。整批计完后任一计数到 2 就授予一级、两边计数一起清零、
 * 本批未消费证据记到这一级名下（两个条件同时满足也只升一次，与批内顺序无关，再有两次新失败才再升）。卡上最近用过的家族已在最高档时只记触顶，不加级。
 * peaks = 每家族用过的最高档（只升不降：配置变了也不回降）；plans = 某一级在某家族下发给启动覆盖的值，及后来核实的实际采用值；
 * 同一级下发值变了（如配置提了基础档）另起一个计划代次 gen，旧代次连同采用记录留作历史，当前计划始终是最新代次、与覆盖返回值一致；
 * notes = 触顶 / 基础档不可核实等原因（同键一条）。dryRun（observe）整批回滚，只返回本会授予什么。
 * tests/task-tier-escalation-store.test.ts。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./paths.js";
import type { EscalationFact } from "./task-tier-escalation-events.js";

const ESCALATION_DB_PATH = statePath("task-tier-escalation.sqlite");
/** 再有这么多次新失败（fix 或 CI 连红任一）才授予一级 */
const ESCALATE_AFTER = 2;

const PLANS_DDL = `CREATE TABLE IF NOT EXISTS esc_plans (project TEXT NOT NULL, card TEXT NOT NULL, family TEXT NOT NULL, step INTEGER NOT NULL, gen INTEGER NOT NULL,
  value TEXT NOT NULL, ts INTEGER NOT NULL, launchId TEXT, sessionId TEXT, actual TEXT, PRIMARY KEY (project, card, family, step, gen))`;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS esc_facts (project TEXT NOT NULL, card TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL,
  ts INTEGER NOT NULL, grantN INTEGER, PRIMARY KEY (project, card, id));
CREATE TABLE IF NOT EXISTS esc_cards (project TEXT NOT NULL, card TEXT NOT NULL, fix INTEGER NOT NULL DEFAULT 0, ci INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, PRIMARY KEY (project, card));
CREATE TABLE IF NOT EXISTS esc_grants (project TEXT NOT NULL, card TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, cause TEXT NOT NULL,
  evidence TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (project, card, n));
CREATE TABLE IF NOT EXISTS esc_peaks (project TEXT NOT NULL, card TEXT NOT NULL, family TEXT NOT NULL, value TEXT NOT NULL, rank INTEGER NOT NULL,
  top INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (project, card, family));
${PLANS_DDL};
CREATE TABLE IF NOT EXISTS esc_notes (project TEXT NOT NULL, card TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (project, card, key));`;

const cache = new Map<string, Database>();

export function openEscalationStore(path: string = ESCALATION_DB_PATH): Database {
  const hit = cache.get(path);
  if (hit) return hit;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  migratePlans(db);
  cache.set(path, db);
  return db;
}

/**
 * 上一版 esc_plans 没有 gen 列（主键 project, card, family, step）：CREATE TABLE IF NOT EXISTS 不改旧表，重开时在 immediate 事务里换成新表，
 * 旧记录连同采用记录原样搬过来记作 gen=0；事务内再核一次，已迁过（别的进程先迁了 / 反复重开）的不动。其他表结构没变，状态原样保留。
 */
function migratePlans(db: Database): void {
  const hasGen = () => db.query<{ name: string }, []>("PRAGMA table_info(esc_plans)").all().some((c) => c.name === "gen");
  if (hasGen()) return;
  db.transaction(() => {
    if (hasGen()) return;
    db.exec(`ALTER TABLE esc_plans RENAME TO esc_plans_v0; ${PLANS_DDL};
INSERT INTO esc_plans (project, card, family, step, gen, value, ts, launchId, sessionId, actual)
  SELECT project, card, family, step, 0, value, ts, launchId, sessionId, actual FROM esc_plans_v0;
DROP TABLE esc_plans_v0;`);
  }).immediate();
}

export function closeEscalationStore(path: string = ESCALATION_DB_PATH): void {
  cache.get(path)?.close();
  cache.delete(path);
}

export interface CardState { fix: number; ci: number; steps: number }
export interface Grant { project: string; card: string; n: number; kind: "up" | "topped"; cause: "fix" | "ci" | "fix+ci"; evidence: string[]; ts: number }
export interface Peak { family: string; value: string; rank: number; top: boolean; updatedAt: number }
export interface Plan { family: string; step: number; gen: number; value: string; ts: number; launchId: string | null; sessionId: string | null; actual: string | null }

class Rollback extends Error {}

export function cardState(db: Database, project: string, card: string): CardState | null {
  return db.query<CardState, [string, string]>("SELECT fix, ci, steps FROM esc_cards WHERE project = ? AND card = ?").get(project, card) ?? null;
}

export function listGrants(db: Database, project: string, card: string): Grant[] {
  return db.query<Omit<Grant, "evidence"> & { evidence: string }, [string, string]>(
    "SELECT project, card, n, kind, cause, evidence, ts FROM esc_grants WHERE project = ? AND card = ? ORDER BY n").all(project, card)
    .map((g) => ({ ...g, evidence: JSON.parse(g.evidence) as string[] }));
}

/** 一个事实进来：新的才计数（按给的顺序：CI 连红 / 清连红看先后）；返回是否新事实 */
function countFact(db: Database, f: EscalationFact, now: number): boolean {
  const ins = db.prepare("INSERT OR IGNORE INTO esc_facts (project, card, id, kind, outcome, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .run(f.project, f.card, f.id, f.kind, f.outcome, f.ts);
  if (!ins.changes) return false;
  db.prepare("INSERT OR IGNORE INTO esc_cards (project, card, updatedAt) VALUES (?, ?, ?)").run(f.project, f.card, now);
  const col = f.kind === "fix" ? "fix = fix + 1" : f.outcome === "failure" ? "ci = ci + 1" : "ci = 0";
  db.prepare(`UPDATE esc_cards SET ${col}, updatedAt = ? WHERE project = ? AND card = ?`).run(now, f.project, f.card);
  return true;
}

/**
 * 整批计完后每张卡核对一次：任一条件到 2 就授予一级（两个都满足也只一级，cause 记全），本卡未消费证据全记到这一级名下、两边计数清零。
 * 与批内 fix / CI 的交错顺序无关；一批最多授予一级，再有两次新失败才再升。
 */
function grantIfDue(db: Database, project: string, card: string, now: number): Grant | null {
  const s = cardState(db, project, card);
  if (!s || (s.fix < ESCALATE_AFTER && s.ci < ESCALATE_AFTER)) return null;
  const n = (db.query<{ n: number }, [string, string]>("SELECT COALESCE(MAX(n), 0) AS n FROM esc_grants WHERE project = ? AND card = ?").get(project, card)?.n ?? 0) + 1;
  const last = db.query<{ top: number }, [string, string]>("SELECT top FROM esc_peaks WHERE project = ? AND card = ? ORDER BY updatedAt DESC LIMIT 1").get(project, card);
  const kind = last?.top ? "topped" : "up";
  const evidence = db.query<{ id: string }, [string, string]>("SELECT id FROM esc_facts WHERE project = ? AND card = ? AND grantN IS NULL ORDER BY rowid")
    .all(project, card).map((r) => r.id);
  const cause = s.fix >= ESCALATE_AFTER && s.ci >= ESCALATE_AFTER ? "fix+ci" : s.fix >= ESCALATE_AFTER ? "fix" : "ci";
  const g: Grant = { project, card, n, kind, cause, evidence, ts: now };
  db.prepare("INSERT INTO esc_grants (project, card, n, kind, cause, evidence, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(project, card, n, kind, cause, JSON.stringify(evidence), now);
  db.prepare("UPDATE esc_facts SET grantN = ? WHERE project = ? AND card = ? AND grantN IS NULL").run(n, project, card);
  db.prepare(`UPDATE esc_cards SET fix = 0, ci = 0${kind === "up" ? ", steps = steps + 1" : ""} WHERE project = ? AND card = ?`).run(project, card);
  return g;
}

/** 一批事实（按给的顺序计数）进库，整批计完再按卡核对授予；返回新事实数与这批授予的级（dryRun 整批回滚，库不变） */
export function ingestFacts(db: Database, facts: readonly EscalationFact[], o: { now: number; dryRun?: boolean }): { added: number; grants: Grant[] } {
  let out = { added: 0, grants: [] as Grant[] };
  try {
    db.transaction(() => {
      const touched = new Map<string, { project: string; card: string }>();
      let added = 0;
      for (const f of facts) {
        if (!countFact(db, f, o.now)) continue;
        added++;
        touched.set(JSON.stringify([f.project, f.card]), { project: f.project, card: f.card });
      }
      const grants = [...touched.values()].map((c) => grantIfDue(db, c.project, c.card, o.now)).filter((g): g is Grant => g !== null);
      out = { added, grants };
      if (o.dryRun) throw new Rollback();
    }).immediate();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

export function listPeaks(db: Database, project: string, card: string): Peak[] {
  return db.query<Omit<Peak, "top"> & { top: number }, [string, string]>("SELECT family, value, rank, top, updatedAt FROM esc_peaks WHERE project = ? AND card = ?")
    .all(project, card).map((p) => ({ ...p, top: p.top === 1 }));
}

/**
 * 启动覆盖拿到的档位：与已存最高档比，只升不降（同一事务里读写，跨进程不回退）；高于基础档（baseRank）才登记这一级在这一家族下发出的值：
 * 没登记过或与最新代次的值不同就另起一代（旧代次的采用记录不带过来），相同则不动。返回实际该用的档（已存档更高就是已存档）。
 */
export function settlePlan(db: Database, p: { project: string; card: string; family: string; step: number; value: string; rank: number; top: boolean; baseRank: number;
  now: number }): Peak {
  return db.transaction(() => {
    const cur = listPeaks(db, p.project, p.card).find((x) => x.family === p.family);
    const keep = cur && cur.rank >= p.rank ? cur : null;
    const peak: Peak = keep ? { ...keep, updatedAt: p.now } : { family: p.family, value: p.value, rank: p.rank, top: p.top, updatedAt: p.now };
    db.prepare("INSERT OR REPLACE INTO esc_peaks (project, card, family, value, rank, top, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(p.project, p.card, p.family, peak.value, peak.rank, peak.top ? 1 : 0, p.now);
    if (peak.rank > p.baseRank) {
      const last = db.query<{ gen: number; value: string }, [string, string, string, number]>(
        "SELECT gen, value FROM esc_plans WHERE project = ? AND card = ? AND family = ? AND step = ? ORDER BY gen DESC LIMIT 1").get(p.project, p.card, p.family, p.step);
      if (last?.value !== peak.value) {
        db.prepare("INSERT INTO esc_plans (project, card, family, step, gen, value, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(p.project, p.card, p.family, p.step, (last?.gen ?? -1) + 1, peak.value, p.now);
      }
    }
    return peak;
  }).immediate();
}

export function latestPlan(db: Database, project: string, card: string): Plan | null {
  return db.query<Plan, [string, string]>(
    "SELECT family, step, gen, value, ts, launchId, sessionId, actual FROM esc_plans WHERE project = ? AND card = ? ORDER BY step DESC, ts DESC, gen DESC LIMIT 1")
    .get(project, card) ?? null;
}

/** 记下某一级某代次带新档的那次启动；已证实实际值等于发出值的不翻案（没证实 / 不符的可被后来的启动替换） */
export function recordAdoption(db: Database, p: { project: string; card: string; family: string; step: number; gen: number; launchId: string; sessionId: string;
  actual: string }): boolean {
  return db.prepare(`UPDATE esc_plans SET launchId = ?, sessionId = ?, actual = ? WHERE project = ? AND card = ? AND family = ? AND step = ? AND gen = ?
    AND (launchId IS NULL OR actual IS NOT value)`).run(p.launchId, p.sessionId, p.actual, p.project, p.card, p.family, p.step, p.gen).changes > 0;
}

/** 原因留痕（同卡同键一条）；返回这次是否新记 */
export function recordNote(db: Database, project: string, card: string, key: string, text: string, now: number): boolean {
  return db.prepare("INSERT OR IGNORE INTO esc_notes (project, card, key, text, ts) VALUES (?, ?, ?, ?, ?)").run(project, card, key, text.slice(0, 400), now).changes > 0;
}

export function listNotes(db: Database, project: string, card: string): { key: string; text: string }[] {
  return db.query<{ key: string; text: string }, [string, string]>("SELECT key, text FROM esc_notes WHERE project = ? AND card = ? ORDER BY ts, key").all(project, card);
}
