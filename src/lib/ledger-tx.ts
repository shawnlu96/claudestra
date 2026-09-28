/**
 * 台账写入的内部底座：事务、写事件、dedupKey 重放。只给写入模块（ledger-write.ts / ledger-deps-write.ts）用——
 * 直接调 insertEvent 就绕过了阶段机与 owner 校验，tests/ledger-store.test.ts 查着别的文件不许 import 这里。
 */
import type { Database } from "bun:sqlite";
import { IMPORT_ACTOR, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import type { EventKind, LedgerEvent } from "./ledger-stages.js";
import { busyAsLedgerError, getEventByDedup, LedgerError, toEvent } from "./ledger-store.js";

export type EventDraft = { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> };

export function tx<T>(db: Database, fn: () => T): T {
  return busyAsLedgerError("写入", () => db.transaction(fn).immediate());
}

/** 导入身份写的事件一律带 imported，调用方漏了也补上；approxTime 也只认导入身份 */
function eventData(ctx: WriteCtx, e: EventDraft): Record<string, unknown> {
  if (ctx.actor !== IMPORT_ACTOR) return e.data ?? {};
  return { ...e.data, imported: true, ...(ctx.approxTime ? { approxTime: true } : {}) };
}

export function insertEvent(db: Database, ctx: WriteCtx, e: EventDraft, primary: boolean): LedgerEvent {
  const r = db
    .prepare("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(ctx.now ?? Date.now(), ctx.actor, e.project, e.target, e.kind, e.text ?? "", JSON.stringify(eventData(ctx, e)), primary ? ctx.dedupKey || null : null);
  return toEvent(r as Record<string, unknown>);
}

/** dedupKey 命中：同一动作 → 原样返回；key 被别的动作用过 → dedup_mismatch */
export function replay<T>(db: Database, ctx: WriteCtx, e: Pick<EventDraft, "project" | "target" | "kind">, load: () => T): WriteResult<T> | null {
  if (ctx.dedupKey === "") throw new LedgerError("invalid", "dedupKey 不能是空字符串（不要幂等就别传）");
  if (!ctx.dedupKey) return null;
  const prev = getEventByDedup(db, ctx.dedupKey);
  if (!prev) return null;
  if (prev.project !== e.project || prev.target !== e.target || prev.kind !== e.kind) {
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已用于 ${prev.project}/${prev.target || "(项目)"} 的 ${prev.kind} 事件`);
  }
  return { row: load(), event: prev, duplicate: true };
}
