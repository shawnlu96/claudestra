/**
 * 内置台账写入前的纯校验与输入类型（ledger-write.ts 用）：字段白名单、枚举、引用存在、id 不撞名、导入口权限。
 * 只读不写——写事件的入口只在 ledger-write.ts，这里拆出来只为让它守住 400 行。
 */
import type { Database } from "bun:sqlite";
import { isStageOfKind, ITEM_STATUSES, STAGES, TASK_KINDS, type ItemStatus, type LedgerItem, type LedgerTask, type Stage, type TaskKind } from "./ledger-stages.js";
import { getItem, getTask, LedgerError } from "./ledger-store.js";

/** specRev 不在里面：它只由阶段机（回退到 spec）维护 */
export const ITEM_FIELDS = ["title", "ownerWords", "priority", "status", "oneLine", "next", "extra"] as const;
export const TASK_FIELDS = ["title", "itemId", "agent", "pm", "branch", "pr", "headSHA", "spec", "model", "extra"] as const;

export type ItemPatch = Partial<Pick<LedgerItem, (typeof ITEM_FIELDS)[number]>>;
export type TaskPatch = Partial<Pick<LedgerTask, (typeof TASK_FIELDS)[number]>>;

export function pick<K extends string>(patch: Record<string, unknown>, allowed: readonly K[], what: string): Partial<Record<K, unknown>> {
  const bad = Object.keys(patch).filter((k) => !(allowed as readonly string[]).includes(k));
  if (bad.length) throw new LedgerError("invalid", `${what} 不能改这些字段：${bad.join(", ")}`);
  if (!Object.keys(patch).length) throw new LedgerError("invalid", `${what} 没有要改的字段`);
  return patch as Partial<Record<K, unknown>>;
}

export function checkStatus(status: unknown): void {
  if (!ITEM_STATUSES.includes(status as ItemStatus)) throw new LedgerError("invalid", `事项状态只能是 ${ITEM_STATUSES.join(" / ")}，收到 ${String(status)}`);
}

export function checkItemRef(db: Database, project: string, itemId: unknown): void {
  if (itemId == null) return;
  if (!getItem(db, project, String(itemId))) throw new LedgerError("not_found", `项目 ${project} 没有事项 ${String(itemId)}`);
}

/** 指标按 target 取事件：事项 id 与任务 id 撞了，事项的事件会被算进任务 */
export function checkIdFree(db: Database, id: string, as: "item" | "task"): void {
  const taken = as === "item" ? getTask(db, id) : db.prepare("SELECT 1 FROM items WHERE id = ?").get(id);
  if (taken) throw new LedgerError("conflict", `id ${id} 已被${as === "item" ? "任务" : "事项"}占用，事项与任务不能同名`);
}

export function isCount(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 0;
}

export function mustTask(db: Database, id: string): LedgerTask {
  const t = getTask(db, id);
  if (!t) throw new LedgerError("not_found", `没有任务 ${id}`);
  return t;
}

/** 自由追加事件的目标：本项目的任务或事项，"" 为项目级 */
export function checkTarget(db: Database, project: string, target: string): void {
  if (!target) return;
  const task = getTask(db, target);
  if (task?.project === project || getItem(db, project, target)) return;
  throw new LedgerError("not_found", `项目 ${project} 里没有任务或事项 ${target}`);
}

export interface NewItem {
  project: string;
  id: string;
  title: string;
  status?: ItemStatus;
  ownerWords?: string;
  priority?: string;
  oneLine?: string;
  next?: string;
  extra?: Record<string, unknown>;
}

export interface NewTask {
  project: string;
  id: string;
  title: string;
  kind: TaskKind;
  itemId?: string | null;
  agent?: string | null;
  pm?: string | null;
  branch?: string | null;
  pr?: string | null;
  headSHA?: string | null;
  spec?: string | null;
  specRev?: number;
  model?: string | null;
  extra?: Record<string, unknown>;
  /** 默认 spec / 0；只有 owner 能带别的值（导入历史任务直接落在当时的阶段），事件记 imported */
  stage?: Stage;
  round?: number;
}

/** 校验新任务，返回是不是导入（非默认的 stage / round）；导入口只给 owner，否则任何人都能建一个直接在 live 的任务绕过阶段机 */
export function checkNewTask(db: Database, actor: string, input: NewTask): boolean {
  if (!input.id || !input.title) throw new LedgerError("invalid", "任务要有 id 和 title");
  if (!TASK_KINDS.includes(input.kind)) throw new LedgerError("invalid", `任务 kind 只能是 ${TASK_KINDS.join(" / ")}`);
  const stage = input.stage ?? "spec";
  if (!STAGES.includes(stage) || !isStageOfKind(input.kind, stage)) throw new LedgerError("invalid", `${input.kind} 任务不能落在阶段 ${stage}`);
  for (const k of ["round", "specRev"] as const) {
    if (input[k] !== undefined && !isCount(input[k])) throw new LedgerError("invalid", `${k} 要是非负整数`);
  }
  const imported = stage !== "spec" || (input.round ?? 0) !== 0;
  if (imported && actor !== "owner") throw new LedgerError("forbidden", "只有 owner 能直接建在非 spec 阶段或带 round 的任务（导入用）");
  if (getTask(db, input.id)) throw new LedgerError("conflict", `任务 ${input.id} 已存在（任务 id 全局唯一）`);
  checkIdFree(db, input.id, "task");
  checkItemRef(db, input.project, input.itemId);
  return imported;
}
