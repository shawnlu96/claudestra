/**
 * 自动升档（TIER3c）的持久化：状态目录下独立的 task-tier-escalation.sqlite（不动台账表结构、不进核心调度热点）。
 * 去重 = 项目 + 卡号 + 事实 id 的主键；每批事实在一个 immediate 事务里核对、计数、升档，跨进程 / 重启 / 重放同一事实只算一次。
 * 每张卡：fix = 未消费的真实退回次数，ci = 未消费的 CI 连红，steps = 已授予的升档级数。任一计数到 2 就授予一级、两边计数一起清零、
 * 本批未消费证据记到这一级名下（两个条件同时满足也只升一次，再有两次新失败才再升）。卡上最近用过的家族已在最高档时只记触顶，不加级。
 * peaks = 每家族用过的最高档（只升不降：配置变了也不回降）；plans = 某一级在某家族下发给启动覆盖的值，及后来核实的实际采用值；
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS esc_facts (project TEXT NOT NULL, card TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL,
  ts INTEGER NOT NULL, grantN INTEGER, PRIMARY KEY (project, card, id));
CREATE TABLE IF NOT EXISTS esc_cards (project TEXT NOT NULL, card TEXT NOT NULL, fix INTEGER NOT NULL DEFAULT 0, ci INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL, PRIMARY KEY (project, card));
CREATE TABLE IF NOT EXISTS esc_grants (project TEXT NOT NULL, card TEXT NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, cause TEXT NOT NULL,
  evidence TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (project, card, n));
CREATE TABLE IF NOT EXISTS esc_peaks (project TEXT NOT NULL, card TEXT NOT NULL, family TEXT NOT NULL, value TEXT NOT NULL, rank INTEGER NOT NULL,
  top INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (project, card, family));
CREATE TABLE IF NOT EXISTS esc_plans (project TEXT NOT NULL, card TEXT NOT NULL, family TEXT NOT NULL, step INTEGER NOT NULL, value TEXT NOT NULL,
  ts INTEGER NOT NULL, launchId TEXT, sessionId TEXT, actual TEXT, PRIMARY KEY (project, card, family, step));
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
  cache.set(path, db);
  return db;
}

export function closeEscalationStore(path: string = ESCALATION_DB_PATH): void {
  cache.get(path)?.close();
  cache.delete(path);
}

export interface CardState { fix: number; ci: number; steps: number }
export interface Grant { project: string; card: string; n: number; kind: "up" | "topped"; cause: "fix" | "ci"; evidence: string[]; ts: number }
export interface Peak { family: string; value: string; rank: number; top: boolean; updatedAt: number }
export interface Plan { family: string; step: number; value: string; ts: number; launchId: string | null; sessionId: string | null; actual: string | null }

class Rollback extends Error {}

export function cardState(db: Database, project: string, card: string): CardState | null {
  return db.query<CardState, [string, string]>("SELECT fix, ci, steps FROM esc_cards WHERE project = ? AND card = ?").get(project, card) ?? null;
}

export function listGrants(db: Database, project: string, card: string): Grant[] {
  return db.query<Omit<Grant, "evidence"> & { evidence: string }, [string, string]>(
    "SELECT project, card, n, kind, cause, evidence, ts FROM esc_grants WHERE project = ? AND card = ? ORDER BY n").all(project, card)
    .map((g) => ({ ...g, evidence: JSON.parse(g.evidence) as string[] }));
}

/** 一个事实进来：新的才计数；授予时把本卡未消费证据记到这一级 */
function applyFact(db: Database, f: EscalationFact, now: number): Grant | null {
  const ins = db.prepare("INSERT OR IGNORE INTO esc_facts (project, card, id, kind, outcome, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .run(f.project, f.card, f.id, f.kind, f.outcome, f.ts);
  if (!ins.changes) return null;
  db.prepare("INSERT OR IGNORE INTO esc_cards (project, card, updatedAt) VALUES (?, ?, ?)").run(f.project, f.card, now);
  const col = f.kind === "fix" ? "fix = fix + 1" : f.outcome === "failure" ? "ci = ci + 1" : "ci = 0";
  db.prepare(`UPDATE esc_cards SET ${col}, updatedAt = ? WHERE project = ? AND card = ?`).run(now, f.project, f.card);
  const s = cardState(db, f.project, f.card)!;
  if (s.fix < ESCALATE_AFTER && s.ci < ESCALATE_AFTER) return null;
  const n = (db.query<{ n: number }, [string, string]>("SELECT COALESCE(MAX(n), 0) AS n FROM esc_grants WHERE project = ? AND card = ?").get(f.project, f.card)?.n ?? 0) + 1;
  const last = db.query<{ top: number }, [string, string]>("SELECT top FROM esc_peaks WHERE project = ? AND card = ? ORDER BY updatedAt DESC LIMIT 1").get(f.project, f.card);
  const kind = last?.top ? "topped" : "up";
  const evidence = db.query<{ id: string }, [string, string]>("SELECT id FROM esc_facts WHERE project = ? AND card = ? AND grantN IS NULL ORDER BY rowid")
    .all(f.project, f.card).map((r) => r.id);
  const g: Grant = { project: f.project, card: f.card, n, kind, cause: s.fix >= ESCALATE_AFTER ? "fix" : "ci", evidence, ts: now };
  db.prepare("INSERT INTO esc_grants (project, card, n, kind, cause, evidence, ts) VALUES (?, ?, ?, ?, ?, ?, ?)").run(f.project, f.card, n, kind, g.cause, JSON.stringify(evidence), now);
  db.prepare("UPDATE esc_facts SET grantN = ? WHERE project = ? AND card = ? AND grantN IS NULL").run(n, f.project, f.card);
  db.prepare(`UPDATE esc_cards SET fix = 0, ci = 0${kind === "up" ? ", steps = steps + 1" : ""} WHERE project = ? AND card = ?`).run(f.project, f.card);
  return g;
}

/** 一批事实（按给的顺序）进库；返回新事实数与这批授予的级（dryRun 整批回滚，库不变） */
export function ingestFacts(db: Database, facts: readonly EscalationFact[], o: { now: number; dryRun?: boolean }): { added: number; grants: Grant[] } {
  let out = { added: 0, grants: [] as Grant[] };
  try {
    db.transaction(() => {
      const before = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM esc_facts").get()!.c;
      const grants = facts.map((f) => applyFact(db, f, o.now)).filter((g): g is Grant => g !== null);
      out = { added: db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM esc_facts").get()!.c - before, grants };
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
 * 启动覆盖拿到的档位：与已存最高档比，只升不降（同一事务里读写，跨进程不回退）；高于基础档（baseRank）才登记这一级在这一家族下发出的值。
 * 返回实际该用的档（已存档更高就是已存档）。
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
      db.prepare("INSERT OR IGNORE INTO esc_plans (project, card, family, step, value, ts) VALUES (?, ?, ?, ?, ?, ?)").run(p.project, p.card, p.family, p.step, peak.value, p.now);
    }
    return peak;
  }).immediate();
}

export function latestPlan(db: Database, project: string, card: string): Plan | null {
  return db.query<Plan, [string, string]>("SELECT family, step, value, ts, launchId, sessionId, actual FROM esc_plans WHERE project = ? AND card = ? ORDER BY step DESC, ts DESC LIMIT 1")
    .get(project, card) ?? null;
}

/** 记下某一级实际采用的那次启动（只记一次，已记过不翻案） */
export function recordAdoption(db: Database, p: { project: string; card: string; family: string; step: number; launchId: string; sessionId: string; actual: string }): boolean {
  return db.prepare("UPDATE esc_plans SET launchId = ?, sessionId = ?, actual = ? WHERE project = ? AND card = ? AND family = ? AND step = ? AND launchId IS NULL")
    .run(p.launchId, p.sessionId, p.actual, p.project, p.card, p.family, p.step).changes > 0;
}

/** 原因留痕（同卡同键一条）；返回这次是否新记 */
export function recordNote(db: Database, project: string, card: string, key: string, text: string, now: number): boolean {
  return db.prepare("INSERT OR IGNORE INTO esc_notes (project, card, key, text, ts) VALUES (?, ?, ?, ?, ?)").run(project, card, key, text.slice(0, 400), now).changes > 0;
}

export function listNotes(db: Database, project: string, card: string): { key: string; text: string }[] {
  return db.query<{ key: string; text: string }, [string, string]>("SELECT key, text FROM esc_notes WHERE project = ? AND card = ? ORDER BY ts, key").all(project, card);
}
