/**
 * 出借方 B 的本地 journal（docs/design/remote-capacity.md §6）：statePath("lend","journal.sqlite")，一单一行。
 * 先写后做：每个外部效果（claim、clone、起 worker、首条派单、转发结果）之前，这一行已经写到能让重启后的进程判断「做到哪、下一步做什么」。
 * 状态只能按 NEXT 表往前走，且每次推进都带「从哪个状态来」做 CAS：两个进程（重启交接、手动 lend submit）同时推进时只有一个成功。
 * 终态（acked / stopped / cancelled / released / declined）不再变。tests/lend-journal.test.ts。
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./paths.js";
import { runMigrations, type SchemaSpec } from "./sqlite-migrate.js";

export const LEND_JOURNAL_PATH = statePath("lend", "journal.sqlite");

/**
 * asked = 已看到单子、在等 owner 批（auto 模式也先落这一行再 claim）；claimed = A 已把单给我们（带租约代数）；
 * cloned = 工作副本就绪、head 已核（写单还核过推送权限）；started = worker 会话已建（记 agent / session）；
 * result_pending = 结论 / 写单的提交已落本地（写单还要推送、开 PR），等 A 的回执。
 * 终态：acked 回执已验；stopped 我方停了（额度 / 登录 / 心跳过期 / 手动）；cancelled A 撤单；released 没起过 worker 就退回（not_started）；
 * declined 没 claim 就放弃（owner 不批 / 过期 / 声明变了）。
 */
export type LendState = "asked" | "claimed" | "cloned" | "started" | "result_pending" | "acked" | "stopped" | "cancelled" | "released" | "declined";

const NEXT: Record<LendState, readonly LendState[]> = {
  asked: ["claimed", "declined"],
  claimed: ["cloned", "released", "cancelled", "stopped"],
  cloned: ["started", "released", "cancelled", "stopped"],
  started: ["result_pending", "stopped", "cancelled"],
  result_pending: ["acked", "cancelled", "stopped"],
  acked: [], stopped: [], cancelled: [], released: [], declined: [],
};

export const LIVE_STATES: readonly LendState[] = ["asked", "claimed", "cloned", "started", "result_pending"];
/** 占着 A 那边租约的状态：要续心跳、到期没续上要自停 */
export const LEASED_STATES: readonly LendState[] = ["claimed", "cloned", "started", "result_pending"];
export const isTerminal = (s: LendState): boolean => NEXT[s].length === 0;
export const canMove = (from: LendState, to: LendState): boolean => NEXT[from].includes(to);

export interface LendRow {
  orderId: string;
  peer: string;
  fp: string | null;
  family: string;
  state: LendState;
  /** poll 时看到的摘要（taskId / repo / pr / head / step），ask 正文与收据用；完整订单在 claim 之后才有 */
  preview: Record<string, unknown>;
  askId: string | null;
  /** claim 返回的 { order: OrderWire, text: A 渲染的派单全文, write: 写单的订单分支与基线 }（text 的 sha256 在 claim 时已核） */
  wire: { order: Record<string, unknown>; text: string; write?: { branch: string; base: string } } | null;
  leaseGen: number | null;
  /** 租约截止（毫秒）：最近一次成功续租 / claim 给的；过了它还没续上 = 自停 */
  leaseUntil: number | null;
  lastBeatAt: number | null;
  dir: string | null;
  agent: string | null;
  sessionId: string | null;
  /** worker 建好的时刻（跑太久没交结论按它算） */
  startedAt: number | null;
  /** 首条派单：null 没发过；"sending" 发出前落的；"sent" 送达。sending 下重启不重发（可能已送达），交给超时自停 */
  submit: "sending" | "sent" | null;
  payload: Record<string, unknown> | null;
  payloadSha: string | null;
  /** 写单：worker 交来的 head / 一行摘要 / 自查（lend submit 落的）；推送、开 PR 之后才拼成 payload 发给 A */
  work: { head: string; summary: string; selfCheck: string } | null;
  receipt: Record<string, unknown> | null;
  reason: string | null;
  /** 终态之后还没做完的外部效果（lend-drive.ts settleOrder）：和终态同一次写入，做完清成 null；非 null 的单每轮补做 */
  settle: { notify: "stopped" | "not_started" | null; removeDir: boolean } | null;
  /** claim 那天（本机日界线），日额度按它数；released 的不算 */
  day: string | null;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA: SchemaSpec = {
  label: "出借 journal",
  migrations: [[
    `CREATE TABLE IF NOT EXISTS lend_orders (orderId TEXT PRIMARY KEY, peer TEXT NOT NULL, fp TEXT, family TEXT NOT NULL, state TEXT NOT NULL,
      preview TEXT NOT NULL, askId TEXT, wire TEXT, leaseGen INTEGER, leaseUntil INTEGER, lastBeatAt INTEGER, dir TEXT, agent TEXT, sessionId TEXT,
      startedAt INTEGER, submit TEXT, payload TEXT, payloadSha TEXT, receipt TEXT, reason TEXT, day TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
    "CREATE INDEX IF NOT EXISTS lend_orders_state ON lend_orders(state)",
    "CREATE TABLE IF NOT EXISTS lend_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ], (db) => {
    const cols = (db.prepare("PRAGMA table_info(lend_orders)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("settle")) db.prepare("ALTER TABLE lend_orders ADD COLUMN settle TEXT").run();
  }, (db) => {
    const cols = (db.prepare("PRAGMA table_info(lend_orders)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("work")) db.prepare("ALTER TABLE lend_orders ADD COLUMN work TEXT").run();
  }],
  tables: ["lend_orders", "lend_meta"],
  columns: { lend_orders: ["settle", "work"] },
  indexes: { lend_orders: ["lend_orders_state"] },
};

/** claim 到的订单（OrderWire 的字段）；没 claim 过是 null */
export const orderOf = (row: Pick<LendRow, "wire">): Record<string, unknown> | null => row.wire?.order ?? null;

/** 调度服务的 lend 这一步挂上 active（lend-deps.ts）：每次写 journal 前同步核一次，与写之间不隔 await；失租 / 停止就抛、不写 */
const writeGuards = new WeakMap<Database, () => void>();
export const guardJournalWrites = (db: Database, check: () => void): void => void writeGuards.set(db, check);
const checkWrite = (db: Database): void => writeGuards.get(db)?.();

export function openLendJournal(path = LEND_JOURNAL_PATH): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 10000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, SCHEMA);
  return db;
}

const JSON_COLS = ["preview", "wire", "payload", "receipt", "settle", "work"] as const;

function toRow(r: Record<string, unknown>): LendRow {
  const out = { ...r } as Record<string, unknown>;
  for (const k of JSON_COLS) out[k] = typeof r[k] === "string" ? JSON.parse(r[k] as string) : (k === "preview" ? {} : null);
  return out as unknown as LendRow;
}

export function getOrder(db: Database, orderId: string): LendRow | null {
  const r = db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(orderId) as Record<string, unknown> | null;
  return r ? toRow(r) : null;
}

export function liveOrders(db: Database): LendRow[] {
  const marks = LIVE_STATES.map(() => "?").join(",");
  return (db.query(`SELECT * FROM lend_orders WHERE state IN (${marks}) ORDER BY createdAt`).all(...LIVE_STATES) as Record<string, unknown>[]).map(toRow);
}

/** 终态了、收尾效果还没做完的单（进程在终态和收据之间退出、收据写盘失败） */
export function unsettledOrders(db: Database): LendRow[] {
  return (db.query("SELECT * FROM lend_orders WHERE settle IS NOT NULL ORDER BY updatedAt").all() as Record<string, unknown>[]).map(toRow);
}

/** 新单：同一 orderId 已有就原样返回（重复 poll 看到同一张单不会开第二条），inserted 说明是不是这次建的 */
export function recordAsked(db: Database, o: { orderId: string; peer: string; fp: string | null; family: string; preview: Record<string, unknown> },
  now = Date.now()): { row: LendRow; inserted: boolean } {
  checkWrite(db);
  const r = db.query(`INSERT INTO lend_orders (orderId, peer, fp, family, state, preview, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'asked', ?, ?, ?)
    ON CONFLICT(orderId) DO NOTHING`).run(o.orderId, o.peer, o.fp, o.family, JSON.stringify(o.preview), now, now);
  return { row: getOrder(db, o.orderId)!, inserted: r.changes === 1 };
}

type Patch = Partial<Omit<LendRow, "orderId" | "peer" | "fp" | "family" | "state" | "createdAt" | "updatedAt">>;

const PATCH_COLS = ["preview", "askId", "wire", "leaseGen", "leaseUntil", "lastBeatAt", "dir", "agent", "sessionId", "startedAt", "submit", "payload", "payloadSha",
  "receipt", "reason", "day", "settle", "work"] as const;

function patchSql(p: Patch): { sets: string[]; vals: (string | number | null)[] } {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const k of PATCH_COLS) {
    if (!(k in p)) continue;
    const v = p[k];
    sets.push(`${k} = ?`);
    vals.push(v === null || v === undefined ? null : (JSON_COLS as readonly string[]).includes(k) ? JSON.stringify(v) : (v as string | number));
  }
  return { sets, vals };
}

export class JournalConflict extends Error {}

/** 只改字段、不换状态：要求此刻仍在 from 里（CAS），否则 JournalConflict */
export function patchOrder(db: Database, orderId: string, from: readonly LendState[], p: Patch, now = Date.now()): LendRow {
  checkWrite(db);
  const { sets, vals } = patchSql(p);
  const marks = from.map(() => "?").join(",");
  const r = db.query(`UPDATE lend_orders SET ${[...sets, "updatedAt = ?"].join(", ")} WHERE orderId = ? AND state IN (${marks})`)
    .run(...vals, now, orderId, ...from);
  if (r.changes !== 1) throw new JournalConflict(`${orderId} 已不在 ${from.join("/")}（${getOrder(db, orderId)?.state ?? "不存在"}），这次不改`);
  return getOrder(db, orderId)!;
}

/** 推进状态：from → to 必须是 NEXT 表允许的一步，且此刻仍在 from（CAS）；终态写 reason */
export function advance(db: Database, orderId: string, from: LendState | readonly LendState[], to: LendState, p: Patch = {}, now = Date.now()): LendRow {
  checkWrite(db);
  const froms = typeof from === "string" ? [from] : from;
  const bad = froms.find((f) => !canMove(f, to));
  if (bad) throw new JournalConflict(`不能从 ${bad} 走到 ${to}`);
  const { sets, vals } = patchSql(p);
  const marks = froms.map(() => "?").join(",");
  const r = db.query(`UPDATE lend_orders SET ${["state = ?", ...sets, "updatedAt = ?"].join(", ")} WHERE orderId = ? AND state IN (${marks})`)
    .run(to, ...vals, now, orderId, ...froms);
  if (r.changes !== 1) throw new JournalConflict(`${orderId} 已不在 ${froms.join("/")}（${getOrder(db, orderId)?.state ?? "不存在"}），不推进到 ${to}`);
  return getOrder(db, orderId)!;
}

/** 本机日界线的 YYYY-MM-DD（设计稿 §6：日额度只受 B 本机时区约束） */
export function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 这个 peer 今天已占的单数：claim 过的都算（含已结束的），released（没起过 worker 就退回）与没 claim 的不算 */
export function ordersToday(db: Database, peer: string, now = Date.now()): number {
  const r = db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND day = ? AND state NOT IN ('asked','declined','released')")
    .get(peer, localDay(now)) as { n: number };
  return r.n;
}

/** 这个 peer、这个家族此刻在占位的单（含等 owner 批的：批下来就要占位） */
export function openSlots(db: Database, peer: string, family: string): number {
  const marks = LIVE_STATES.map(() => "?").join(",");
  const r = db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND state IN (${marks})`).get(peer, family, ...LIVE_STATES) as { n: number };
  return r.n;
}

export function getMeta(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM lend_meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  checkWrite(db);
  db.query("INSERT INTO lend_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
