/**
 * 派单的投递与回执（T48，docs/team/collab-model.md §4）：每张步骤单一行，主键是它那条 dispatch 事件的 seq。
 * 事件表只追加，投递次数、送达、回执、提醒这些会变的状态记在这里；正文是生成时那一份（发往 peer 的已脱敏），重试原样重发、不重新生成。
 * 回执 = 执行者在这张卡上写了任何事件（本机 agent 按名字，peer 按 peer:<实例>），不另造「收到」命令。
 * 调度规则（退避、15 分钟提醒、被新派单顶掉就停）是纯函数，扫描在 manager/ledger-step-dispatch.ts。tests/ledger-step-dispatch.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent } from "./ledger-stages.js";

export const DISPATCH_LOG_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS dispatch_log (
  seq INTEGER PRIMARY KEY,
  taskId TEXT NOT NULL REFERENCES tasks(id), project TEXT NOT NULL,
  step TEXT NOT NULL, round INTEGER NOT NULL, executor TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('local','peer')), target TEXT NOT NULL,
  text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER,
  deliveredAt INTEGER, ackAt INTEGER, remindedAt INTEGER, failAlertAt INTEGER, stoppedAt INTEGER, lastError TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS dispatch_log_open ON dispatch_log(ackAt, stoppedAt)",
];
export const DISPATCH_LOG_COLUMNS = ["seq", "taskId", "step", "executor", "channel", "target", "text", "attempts", "nextAt", "deliveredAt", "ackAt", "remindedAt"] as const;

/** 送达后这么久没回执就提醒 PM 改派（owner 定 15 分钟，从送达那一刻算；一直送不到的走重试，不算超时） */
export const ACK_TIMEOUT_MS = 15 * 60_000;
/** 重试退避：1、2、4、8… 分钟，封顶 1 小时 */
const RETRY_CAP_MS = 60 * 60_000;
/** 连着失败这么多次就告诉 PM 一次（大约 15 分钟送不出去），之后照常按小时重试 */
const FAIL_ALERT_ATTEMPTS = 4;

export interface DispatchRow {
  seq: number;
  taskId: string;
  project: string;
  step: string;
  round: number;
  executor: string;
  channel: "local" | "peer";
  /** 本机 agent 名，或 <对方项目 PM>@<peer> */
  target: string;
  text: string;
  attempts: number;
  nextAt: number | null;
  deliveredAt: number | null;
  ackAt: number | null;
  remindedAt: number | null;
  failAlertAt: number | null;
  stoppedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const hasTable = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dispatch_log'").get();

export function insertDispatch(db: Database, r: Omit<DispatchRow, "attempts" | "nextAt" | "deliveredAt" | "ackAt" | "remindedAt" | "failAlertAt" | "stoppedAt" | "lastError" | "updatedAt">): void {
  db.prepare(
    `INSERT OR IGNORE INTO dispatch_log (seq, taskId, project, step, round, executor, channel, target, text, nextAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.seq, r.taskId, r.project, r.step, r.round, r.executor, r.channel, r.target, r.text, r.createdAt, r.createdAt, r.createdAt);
}

export function getDispatch(db: Database, seq: number): DispatchRow | null {
  return hasTable(db) ? ((db.query("SELECT * FROM dispatch_log WHERE seq = ?").get(seq) as DispatchRow | null) ?? null) : null;
}

export function listDispatches(db: Database, taskId?: string): DispatchRow[] {
  if (!hasTable(db)) return [];
  const rows = taskId
    ? db.query("SELECT * FROM dispatch_log WHERE taskId = ? ORDER BY seq").all(taskId)
    : db.query("SELECT * FROM dispatch_log WHERE ackAt IS NULL AND stoppedAt IS NULL ORDER BY seq").all();
  return rows as DispatchRow[];
}

/** 投递结果落库：成功记送达；失败按次数退避排下一次 */
export function noteAttempt(db: Database, seq: number, now: number, ok: boolean, error: string | null): void {
  const row = getDispatch(db, seq);
  if (!row) return;
  const attempts = row.attempts + 1;
  if (ok) {
    db.prepare("UPDATE dispatch_log SET attempts = ?, deliveredAt = ?, nextAt = NULL, lastError = NULL, updatedAt = ? WHERE seq = ?").run(attempts, now, now, seq);
  } else {
    db.prepare("UPDATE dispatch_log SET attempts = ?, nextAt = ?, lastError = ?, updatedAt = ? WHERE seq = ?").run(attempts, now + retryDelayMs(attempts), (error ?? "").slice(0, 300), now, seq);
  }
}

export function markDispatch(db: Database, seq: number, field: "ackAt" | "remindedAt" | "failAlertAt" | "stoppedAt", now: number): void {
  db.prepare(`UPDATE dispatch_log SET ${field} = ?, updatedAt = ? WHERE seq = ?`).run(now, now, seq);
}

/** 第 n 次失败后隔多久再试（n 从 1 起） */
export function retryDelayMs(n: number): number {
  return Math.min(RETRY_CAP_MS, 60_000 * 2 ** Math.max(0, n - 1));
}

/** 回执方：本机 agent 就是它的名字；peer 执行者（<x>@<peer>）写卡时 actor 是 peer:<peer>（manager/ledger-peer.ts） */
function ackActorOf(row: Pick<DispatchRow, "channel" | "executor">): string {
  return row.channel === "peer" ? `peer:${row.executor.slice(row.executor.lastIndexOf("@") + 1)}` : row.executor;
}

/** 派单之后执行者在这张卡上写的第一条事件（系统写的派单 / 升级不算） */
export function ackEvent(row: Pick<DispatchRow, "seq" | "channel" | "executor">, events: readonly LedgerEvent[]): LedgerEvent | null {
  const who = ackActorOf(row);
  return events.find((e) => e.seq > row.seq && e.actor === who && e.kind !== "dispatch" && e.kind !== "escalate") ?? null;
}

export type SweepAction = { kind: "send" } | { kind: "ack"; at: number } | { kind: "remind" } | { kind: "fail_alert" } | { kind: "stop" } | { kind: "wait" };

/**
 * 一行现在该做什么（纯函数）。superseded = 同一张卡的同一步后来又派过单（换人 / 重派），旧单停止重试和提醒；
 * closed = 卡已经结束（done / cancelled）。
 */
export function sweepAction(row: DispatchRow, now: number, ack: LedgerEvent | null, superseded: boolean, closed: boolean): SweepAction {
  if (row.ackAt || row.stoppedAt) return { kind: "wait" };
  if (ack) return { kind: "ack", at: ack.ts };
  if (superseded || closed) return { kind: "stop" };
  if (row.deliveredAt === null) {
    if (row.attempts >= FAIL_ALERT_ATTEMPTS && !row.failAlertAt) return { kind: "fail_alert" };
    return row.nextAt !== null && row.nextAt <= now ? { kind: "send" } : { kind: "wait" };
  }
  return !row.remindedAt && now - row.deliveredAt >= ACK_TIMEOUT_MS ? { kind: "remind" } : { kind: "wait" };
}

