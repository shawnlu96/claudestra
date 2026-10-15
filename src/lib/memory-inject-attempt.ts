/**
 * PMEMTUNE1 · 项目记忆的检索尝试样本：每次真实派单（本机领单 / 出借 / 全文直发）的检索结果写一条 note（op = memory_inject_attempt），
 * 让 memory-metrics 分得清未覆盖是「没领单 / 没候选 / 预算放不下 / 只剩 home / 故障」。同一单号同一渠道只写一次（dedupKey）。
 * 只追加记录：写失败不影响派单（吞掉，打一行日志）。bridge / 调度器的只读连接另开写连接（同 memory-retrieve-order.ts record）。
 * tests/memory-inject-attempt.test.ts。
 */
import { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { insertEvent } from "./ledger-tx.js";
import type { MemoryOrderKind } from "./memory-retrieve.js";

export const MEMORY_ATTEMPT_OP = "memory_inject_attempt";
export const MEMORY_CHANNELS = ["local_take", "lend", "direct"] as const;
export type MemoryChannel = (typeof MEMORY_CHANNELS)[number];
export type MemoryAttemptResult = "injected" | "empty" | "budget_drop" | "filtered_visibility" | "error";

export interface MemoryAttempt {
  orderId: string;
  channel: MemoryChannel;
  /** 写单（write / fix）还是审查单；覆盖率只数写单 */
  order: MemoryOrderKind;
  result: MemoryAttemptResult;
  /** 实际写进单子的条数（observe 档不写这条记录，只留恢复观察样本） */
  count: number;
  elapsedMs: number;
  /** error 的原因（一行，不带记忆正文） */
  reason?: string;
}

const WRITER_BUSY_MS = 2_000;

const attemptDedupKey = (channel: MemoryChannel, orderId: string): string => `memory-inject-attempt:${channel}:${orderId}`;

/** 只读连接另开一条写连接跑 fn；可写连接直接用。 */
export function withLedgerWriter<T>(db: Database, fn: (w: Database) => T): T {
  const queryOnly = (db.query("PRAGMA query_only").get() as { query_only: number }).query_only === 1;
  const writer = queryOnly ? new Database(db.filename, { readwrite: true, create: false }) : db;
  try {
    if (writer !== db) writer.exec(`PRAGMA busy_timeout = ${WRITER_BUSY_MS}`);
    return fn(writer);
  } finally {
    if (writer !== db) writer.close();
  }
}

/** 一单一渠道一条；已有就不写。永不抛。 */
export function recordMemoryAttempt(db: Database, task: Pick<LedgerTask, "id" | "project" | "specRev">, a: MemoryAttempt, now = Date.now()): void {
  const key = attemptDedupKey(a.channel, a.orderId);
  try {
    if (getEventByDedup(db, key)) return;
    withLedgerWriter(db, (w) => w.transaction(() => getEventByDedup(w, key) ?? insertEvent(w, { actor: "scheduler", dedupKey: key, now }, {
      project: task.project, target: task.id, kind: "note",
      text: `项目记忆检索：${a.channel} ${a.result}（${a.count} 条，${a.elapsedMs} ms）`,
      data: { op: MEMORY_ATTEMPT_OP, taskId: task.id, orderId: a.orderId, channel: a.channel, order: a.order, result: a.result, count: a.count,
        elapsedMs: a.elapsedMs, specRev: task.specRev, ...(a.reason ? { reason: a.reason.slice(0, 200) } : {}) },
    }, true)).immediate());
  } catch (e) {
    console.error(`⚠️ ${task.id} 记忆检索样本没记上（派单照常）：${(e as Error).message}`);
  }
}
