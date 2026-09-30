/**
 * 台账写入的内部底座：事务、写事件、dedupKey 重放。只给写入模块（ledger-write.ts / ledger-deps-write.ts）用——
 * 直接调 insertEvent 就绕过了阶段机与 owner 校验；tests/ledger-migrate.test.ts 扫 src/ 查着别的文件不许 import 这里。
 */
import type { Database } from "bun:sqlite";
import { IMPORT_ACTOR, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import type { EventKind, LedgerEvent } from "./ledger-stages.js";
import { busyAsLedgerError, getEventByDedup, LedgerError, toEvent } from "./ledger-store.js";
import { ORIGIN_VALUES, originArgs } from "./ledger-origin.js";

export type EventDraft = { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> };

export function tx<T>(db: Database, fn: () => T): T {
  return busyAsLedgerError("写入", () => db.transaction(fn).immediate());
}

/** 导入身份写的事件一律带 imported，调用方漏了也补上；approxTime 也只认导入身份 */
function eventData(ctx: WriteCtx, e: EventDraft): Record<string, unknown> {
  if (ctx.actor !== IMPORT_ACTOR) return e.data ?? {};
  return { ...e.data, imported: true, ...(ctx.approxTime ? { approxTime: true } : {}) };
}

/** `dispatch:` 前缀的幂等键留给派审（manager/ledger-dispatch-cmds.ts dispatchKey 按规则算出来）：别的事件先占掉，派审就记不上 */
const DISPATCH_KEY = "dispatch:";

export function insertEvent(db: Database, ctx: WriteCtx, e: EventDraft, primary: boolean): LedgerEvent {
  if (primary && ctx.dedupKey?.startsWith(DISPATCH_KEY) && e.kind !== "dispatch") throw new LedgerError("invalid", `dedupKey 的 ${DISPATCH_KEY} 前缀只给 dispatch 事件用`);
  if (primary && ctx.dedupKey?.startsWith("scheduler:") && e.kind !== "scheduler") throw new LedgerError("invalid", "scheduler: 前缀只给调度事件用");
  const r = db
    .prepare(`INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey, origin, originSeq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${ORIGIN_VALUES}) RETURNING *`)
    .get(ctx.now ?? Date.now(), ctx.actor, e.project, e.target, e.kind, e.text ?? "", JSON.stringify(eventData(ctx, e)), primary ? ctx.dedupKey || null : null, ...originArgs(db));
  return toEvent(r as Record<string, unknown>);
}

/**
 * dedupKey 命中：同一动作 → 原样返回；key 被别的动作用过 → dedup_mismatch。
 * same 可再比事件 data：同一 target 同一 kind 下还分得出不同动作时（依赖边的 add / set / rm、不同前置）必须给，否则会把别的动作当重复吞掉。
 */
export function replay<T>(
  db: Database,
  ctx: WriteCtx,
  e: Pick<EventDraft, "project" | "target" | "kind">,
  load: () => T,
  same: (prev: LedgerEvent) => boolean = () => true,
): WriteResult<T> | null {
  if (ctx.dedupKey === "") throw new LedgerError("invalid", "dedupKey 不能是空字符串（不要幂等就别传）");
  if (!ctx.dedupKey) return null;
  const prev = getEventByDedup(db, ctx.dedupKey);
  if (!prev) return null;
  if (prev.project !== e.project || prev.target !== e.target || prev.kind !== e.kind || !same(prev)) {
    // 别的项目用过这个 key：只说被占用，不带出那个项目的任务名（key 格式可猜，否则能拿来探测别的项目）
    const where = prev.project === e.project ? `：已用于 ${prev.target || "(项目)"} 的 ${prev.kind} 事件` : "";
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已被别的动作用过${where}`);
  }
  return { row: load(), event: prev, duplicate: true };
}
