/**
 * 出借单交回时回传这一单的用量（LENDUSAGE1）。两边同一套代码：
 * - 出借方 B：交回（lend-submit.ts 审查结论、lend-drive.ts 写单交付）时，按这一单的 worker 会话（row.sessionId）只读查本机 usage 库，
 *   按家族汇总成 lend-wire.ts 的 `usage`。只算这一单的会话，不按卡、不按时间段扩大；查不到就不带，不写 0。
 *   开关是恢复键 lendUsageReport，缺省 **off**（对外发数据，只认这个键的显式值，项目整体 mode 不算）：off 不带；observe 照常算、不发，
 *   在出借 journal 记一条这一单本会带什么（meta usageObserved:<orderId>，同单覆盖；单结束满 24 小时随之后任一单交回时删掉）；on 且借入方已声明认识 usage 才带。
 *   只读查观察：sqlite3 -readonly ~/.claude-orchestrator/lend/journal.sqlite "SELECT key, value FROM lend_meta WHERE key LIKE 'usageObserved:%'"
 *   借入方的声明 = 它的 hello 应答 proto ≥ 4（lend-wire-v2-schema.ts LEND_PROTO_USAGE），由 lend-hello.ts 每次握手覆盖写 usageAck:<peer>；
 *   没握手成功过、对方是旧版 / 只会 v1、或声明已过 HELLO_FRESH_MS 没刷新 = 不带。
 *   已进 result_pending 的单重交时沿用已存正文里的那份（重交是逐字节幂等的，用量在 worker 继续跑时会变）。
 * - 借入方 A：ledger-lend-result.ts 收到带 usage 的交回，在同一事务里记一条 note（data.lendUsage 原样，data.lend.op = "usage"）；
 *   同一单号同一 gen 的重交走旧回执，不会记第二条。lendReportedUsage 读台账给 usage-task-summary.ts 汇总。
 * tests/lend-usage-report.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { getMeta, LIVE_STATES, setMeta, type LendRow, type LendState } from "./lend-journal.js";
import { usageOf, type LendUsage } from "./lend-wire.js";
import { HELLO_FRESH_MS } from "./lend-wire-v2.js";
import { LEND_PROTO_USAGE } from "./lend-wire-v2-schema.js";
import { PROJECTS_PATH, resolveProjectForRealDir, type ProjectDef } from "./projects.js";
import { isRecoveryMode, readRecoveryFile, RECOVERY_POLICY_PATH, type RecoveryMode } from "./recovery-policy.js";
import { REPO_ROOT } from "./repo-root.js";
import { FAMILY_SQL as FAMILY, USAGE_DB_PATH } from "./usage-store.js";

const USAGE_REPORT_KEY = "lendUsageReport" as const;
export type { LendUsage };

// ── 出借方 B：借入方的声明 ──

export const usageAckKey = (peer: string): string => `usageAck:${peer}`;

/** lend-hello.ts 每次握手都调：应答的 proto（旧版 / 没有 v2 = 传 0）。覆盖写，不留旧的 true：对方降级后再带 usage 会被整条拒收 */
export function writeUsageAck(db: Database, peer: string, proto: number, now = Date.now()): void {
  setMeta(db, usageAckKey(peer), JSON.stringify({ ack: proto >= LEND_PROTO_USAGE, at: now }));
}

/** 借入方此刻是否声明认识 usage：最近一次握手说了 proto ≥ 4，且不早于 HELLO_FRESH_MS（三次没握上就当不知道） */
export function usageAcked(db: Database, peer: string, now = Date.now()): boolean {
  let v: { ack?: unknown; at?: unknown } | null;
  try { v = JSON.parse(getMeta(db, usageAckKey(peer)) ?? "null"); } catch { return false; }
  return !!v && v.ack === true && typeof v.at === "number" && now - v.at <= HELLO_FRESH_MS;
}

// ── 出借方 B：开关 ──

export interface ModeDeps { policyPath?: string; projectsPath?: string; repoRoot?: string }

/**
 * lendUsageReport 的生效值：本机 claudestra 仓库（REPO_ROOT）所属项目的 keys.lendUsageReport 显式值；没设、项目 mode 继承、文件坏、
 * 项目解析不出 = off。同步读（交回正文在同步段里拼），从不抛。
 */
export function usageReportMode(o: ModeDeps = {}): RecoveryMode {
  try {
    const projects = (JSON.parse(readFileSync(o.projectsPath ?? PROJECTS_PATH, "utf8")) as { projects?: ProjectDef[] }).projects;
    const project = Array.isArray(projects) ? resolveProjectForRealDir(projects, o.repoRoot ?? REPO_ROOT)?.id : undefined;
    if (!project) return "off";
    const f = readRecoveryFile(o.policyPath ?? RECOVERY_POLICY_PATH);
    if (f.status !== "ok" || !Object.hasOwn(f.data.projects, project)) return "off";
    const m = f.data.projects[project].keys?.[USAGE_REPORT_KEY];
    return isRecoveryMode(m) ? m : "off";
  } catch { return "off"; }
}

// ── 出借方 B：读库与汇总 ──

interface SessionFamilyRow { family: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; calls: number;
  firstAt: number; lastAt: number }

/** 纯函数：按家族的行 → 线上的 usage；家族不认识、调用数为 0 的行丢掉，过不了 lend-wire 的严格校验 = null（不发一份会被整条拒收的） */
function usageFromRows(rows: readonly SessionFamilyRow[]): LendUsage[] | null {
  const items = rows.filter((r) => (r.family === "claude" || r.family === "codex") && r.calls > 0)
    .map((r) => ({ family: r.family, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, reasoning: r.reasoning,
      calls: r.calls, firstAt: r.firstAt, lastAt: r.lastAt }))
    .sort((a, b) => a.family.localeCompare(b.family));
  if (!items.length) return null;
  try { return usageOf(items); } catch { return null; }
}

/** 只读查一个会话按家族的用量（只看 turns.session_id = 这个会话，主线与 sidechain 都在里面） */
function sessionUsageRows(db: Database, sessionId: string): SessionFamilyRow[] {
  return db.prepare(`SELECT ${FAMILY} AS family, SUM(c.input) AS input, SUM(c.output) AS output, SUM(c.cache_read) AS cacheRead,
      SUM(c.cache_creation) AS cacheWrite, SUM(c.reasoning) AS reasoning, COUNT(*) AS calls, MIN(c.ts) AS firstAt, MAX(c.ts) AS lastAt
    FROM turns t JOIN calls c ON c.turn_id = t.turn_id WHERE t.session_id = ? GROUP BY family`).all(sessionId) as SessionFamilyRow[];
}

/** 本机 usage 库里这个会话的 usage；库不在、读不了、没有这个会话 = null */
export function readSessionUsage(sessionId: string, path = USAGE_DB_PATH): LendUsage[] | null {
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return usageFromRows(sessionUsageRows(db, sessionId));
  } catch { return null; } finally { db?.close(); }
}

export interface UsageReportDeps {
  mode?: () => RecoveryMode;
  read?: (sessionId: string) => LendUsage[] | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** 生产不调：单测注入开关 / 读库 / 时钟（lend-submit 与 lend-drive 的调用处不传 deps） */
let injected: UsageReportDeps = {};
export function useUsageReportDeps(d: UsageReportDeps | null): void { injected = d ?? {}; }

const OBSERVED_PREFIX = "usageObserved:";
const usageObservedKey = (orderId: string): string => `${OBSERVED_PREFIX}${orderId}`;
/** 观察记录随出借单的保留期走：单结束（不在 LIVE_STATES）满这么久就删，同 lend-work-retention.ts STOPPED_RETENTION_MS */
export const OBSERVED_KEEP_MS = 24 * 60 * 60_000;

/** 删掉已过保留期的观察：journal 里没有这一单了，或这一单已结束且最后一次更新早于 OBSERVED_KEEP_MS。返回删了几条 */
export function pruneUsageObserved(db: Database, now = Date.now()): number {
  const rows = db.query(`SELECT m.key AS key, o.state AS state, o.updatedAt AS updatedAt FROM lend_meta m
    LEFT JOIN lend_orders o ON o.orderId = substr(m.key, ${OBSERVED_PREFIX.length + 1}) WHERE m.key LIKE '${OBSERVED_PREFIX}%'`).all() as
    { key: string; state: LendState | null; updatedAt: number | null }[];
  const stale = rows.filter((r) => r.state === null || (!LIVE_STATES.includes(r.state) && now - (r.updatedAt ?? 0) > OBSERVED_KEEP_MS));
  for (const r of stale) db.run("DELETE FROM lend_meta WHERE key = ?", [r.key]);
  return stale.length;
}

/** 已经落进 journal 的正文里的 usage（重交时沿用，保证逐字节幂等） */
function storedUsage(payload: Record<string, unknown>): { usage?: LendUsage[] } {
  return Array.isArray(payload.usage) ? { usage: payload.usage as LendUsage[] } : {};
}

/**
 * 交回正文里要带的 usage（B）。row 已有 payload（result_pending 重交）= 原样沿用；否则按开关现算：
 * off / 没有会话 / 查不到 = 不带；observe = 记观察、不带；on = 借入方已声明才带。
 */
export function lendUsageFor(db: Database, row: Pick<LendRow, "orderId" | "peer" | "sessionId" | "payload">, deps: UsageReportDeps = {}): { usage?: LendUsage[] } {
  if (row.payload) return storedUsage(row.payload);
  const d = { ...injected, ...deps };
  const now = (d.now ?? Date.now)();
  pruneUsageObserved(db, now); // 每次交回顺手清：开关切走以后旧观察也会按期删
  const mode = (d.mode ?? usageReportMode)();
  if (mode === "off" || !row.sessionId) return {};
  const usage = (d.read ?? readSessionUsage)(row.sessionId);
  if (!usage) return {};
  const acked = usageAcked(db, row.peer, now);
  if (mode === "observe") {
    setMeta(db, usageObservedKey(row.orderId), JSON.stringify({ at: now, peer: row.peer, sessionId: row.sessionId, acked, usage }));
    (d.log ?? console.log)(`📏 [lendUsageReport=observe] ${row.orderId} 本会带 ${usage.map((u) => `${u.family} ${u.calls} 次调用`).join("、")}，没带`);
    return {};
  }
  return acked ? { usage } : {};
}

/** observe 记下的观察（doctor / 测试读）；没有 = null */
export function usageObserved(db: Database, orderId: string): { at: number; peer: string; sessionId: string; acked: boolean; usage: LendUsage[] } | null {
  try { return JSON.parse(getMeta(db, usageObservedKey(orderId)) ?? "null"); } catch { return null; }
}

// ── 借入方 A：读台账 ──

export interface LendReported { orderId: string; family: string; usage: LendUsage[] }

/** 纯函数：台账 note 的 data → 一单的回传；不是 usage 记录、格式不对 = null（台账里的旧数据不拖垮汇总） */
export function reportedOf(data: unknown): LendReported | null {
  const d = data as { lend?: { op?: unknown; orderId?: unknown; family?: unknown }; lendUsage?: unknown } | null;
  if (!d?.lend || d.lend.op !== "usage" || typeof d.lend.orderId !== "string" || typeof d.lend.family !== "string") return null;
  try { return { orderId: d.lend.orderId, family: d.lend.family, usage: usageOf(d.lendUsage) }; } catch { return null; }
}

/** 台账里这张卡各出借单回传的用量；同一单只取第一条 */
export function lendReportedUsage(ledger: Database, taskId: string): LendReported[] {
  if (!ledger.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()) return [];
  const rows = ledger.prepare(`SELECT data FROM events WHERE target = ? AND kind = 'note' AND json_extract(data, '$.lend.op') = 'usage' ORDER BY seq`)
    .all(taskId) as { data: string }[];
  const seen = new Map<string, LendReported>();
  for (const r of rows) {
    let data: unknown;
    try { data = JSON.parse(r.data); } catch { continue; }
    const one = reportedOf(data);
    if (one && !seen.has(one.orderId)) seen.set(one.orderId, one);
  }
  return [...seen.values()];
}
