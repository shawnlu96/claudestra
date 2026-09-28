/**
 * 内置台账的项目级写入与自由追加事件（docs 10-ledger §3）：note / decision / deploy / verify / rollback、合并队列冻结、PM 名单与文档目录。
 * 事务、幂等与事件写法与 ledger-write.ts 同一套（tx / insertEvent / replay 从那里来）。
 */
import type { Database } from "bun:sqlite";
import type { EventKind, LedgerEvent } from "./ledger-stages.js";
import { getItem, getMeta, getTask, LedgerError, type LedgerMeta } from "./ledger-store.js";
import { insertEvent, replay, tx, type WriteCtx, type WriteResult } from "./ledger-write.js";

/** 调用方可直接追加的事件；stage / item / task / meta / freeze 由对应写函数产生 */
const APPENDABLE_KINDS = ["note", "decision", "deploy", "verify", "rollback"] as const;
export type AppendableKind = (typeof APPENDABLE_KINDS)[number];

function checkTarget(db: Database, project: string, target: string): void {
  if (!target) return;
  const task = getTask(db, target);
  if (task?.project === project || getItem(db, project, target)) return;
  throw new LedgerError("not_found", `项目 ${project} 里没有任务或事项 ${target}`);
}

/** note / decision / deploy / verify / rollback；target 为 "" 表示项目级 */
export function appendEvent(
  db: Database,
  ctx: WriteCtx,
  input: { project: string; target: string; kind: AppendableKind; text?: string; data?: Record<string, unknown> },
): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const dup = replay(db, ctx, input, () => null);
    if (dup) return { event: dup.event, duplicate: true };
    if (!APPENDABLE_KINDS.includes(input.kind)) throw new LedgerError("invalid", `不能直接追加 ${input.kind} 事件`);
    checkTarget(db, input.project, input.target);
    return { event: insertEvent(db, ctx, input, true), duplicate: false };
  });
}

function putMeta(db: Database, project: string, key: string, value: unknown): void {
  db.prepare("INSERT INTO meta (project, key, value) VALUES (?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run(
    project,
    key,
    JSON.stringify(value),
  );
}

/** 合并队列冻结 / 解冻（项目级事件，target ""） */
export function setFrozen(db: Database, ctx: WriteCtx, input: { project: string; frozen: boolean; reason?: string }): WriteResult<LedgerMeta> {
  return tx(db, () => {
    const key = { project: input.project, target: "", kind: (input.frozen ? "freeze" : "unfreeze") as EventKind };
    const dup = replay(db, ctx, key, () => getMeta(db, input.project));
    if (dup) return dup;
    const cur = getMeta(db, input.project).queueFrozen;
    if (cur.frozen === input.frozen) throw new LedgerError("conflict", `项目 ${input.project} 的合并队列已经是${cur.frozen ? "冻结" : "未冻结"}状态`, { ...cur });
    const now = ctx.now ?? Date.now();
    putMeta(db, input.project, "queueFrozen", { frozen: input.frozen, reason: input.reason ?? "", since: input.frozen ? now : null });
    const event = insertEvent(db, ctx, { ...key, text: input.reason }, true);
    return { row: getMeta(db, input.project), event, duplicate: false };
  });
}

/** PM 名单与文档目录只有 owner（终端）能设 */
export function setMeta(
  db: Database,
  ctx: WriteCtx,
  input: { project: string; key: "pms"; value: string[] } | { project: string; key: "docsDir"; value: string },
): WriteResult<LedgerMeta> {
  return tx(db, () => {
    const key = { project: input.project, target: "", kind: "meta" as const };
    const dup = replay(db, ctx, key, () => getMeta(db, input.project));
    if (dup) return dup;
    if (ctx.actor !== "owner") throw new LedgerError("forbidden", `只有 owner 能设项目的 ${input.key}`);
    const ok = input.key === "pms" ? Array.isArray(input.value) && input.value.every((p) => typeof p === "string" && p) : typeof input.value === "string";
    if (!ok) throw new LedgerError("invalid", input.key === "pms" ? "pms 要是非空字符串数组" : "docsDir 要是字符串");
    putMeta(db, input.project, input.key, input.value);
    const event = insertEvent(db, ctx, { ...key, data: { op: "set", patch: { [input.key]: input.value } } }, true);
    return { row: getMeta(db, input.project), event, duplicate: false };
  });
}
