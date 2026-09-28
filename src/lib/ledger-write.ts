/**
 * 内置台账的写入（docs 10-ledger §3）：每个导出函数一个 BEGIN IMMEDIATE 事务，改行与追加事件同进同出。
 * CAS：items / tasks 改字段带 rev，推阶段带 from；不符抛 LedgerError("conflict")，current 里是库里的实际值。
 * 幂等：ctx.dedupKey 全局唯一；同 key 再提交且 project / target / kind 一致 → 返回原事件与当前行、duplicate=true，不再校验 CAS。
 * 阶段角色由这里按 actor + 项目 PM 名单现算（roleOf），调用方不能自报角色；其余动作的角色矩阵在 CLI（T8b）。
 */
import type { Database } from "bun:sqlite";
import {
  canTransition,
  ITEM_STATUSES,
  nextTaskState,
  roleOf,
  STAGES,
  TASK_KINDS,
  type EventKind,
  type ItemStatus,
  type LedgerEvent,
  type LedgerItem,
  type LedgerTask,
  type ReviewVerdict,
  type Stage,
  type TaskKind,
} from "./ledger-stages.js";
import { getEventByDedup, getItem, getMeta, getTask, LedgerError, toEvent, type LedgerMeta } from "./ledger-store.js";

export interface WriteCtx {
  /** 写入者：agent 名 / "master" / "owner"（身份推导在 CLI） */
  actor: string;
  /** 事件时间（epoch ms），默认 Date.now()；测试注入 */
  now?: number;
  dedupKey?: string;
}

export interface WriteResult<T> {
  row: T;
  /** 本次动作的主事件（带 dedupKey 的那条） */
  event: LedgerEvent;
  duplicate: boolean;
}

export const ITEM_FIELDS = ["title", "ownerWords", "priority", "status", "oneLine", "next", "extra"] as const;
export const TASK_FIELDS = ["title", "itemId", "agent", "pm", "branch", "pr", "headSHA", "spec", "specRev", "model", "extra"] as const;
/** 调用方可直接追加的事件；stage / item / task / meta / freeze 由对应写函数产生 */
export const APPENDABLE_KINDS = ["note", "decision", "deploy", "verify", "rollback"] as const;
export type AppendableKind = (typeof APPENDABLE_KINDS)[number];

type ItemPatch = Partial<Pick<LedgerItem, (typeof ITEM_FIELDS)[number]>>;
type TaskPatch = Partial<Pick<LedgerTask, (typeof TASK_FIELDS)[number]>>;
type EventDraft = { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> };

function tx<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}

function insertEvent(db: Database, ctx: WriteCtx, e: EventDraft, primary: boolean): LedgerEvent {
  const r = db
    .prepare("INSERT INTO events (ts, actor, project, target, kind, text, data, dedupKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(ctx.now ?? Date.now(), ctx.actor, e.project, e.target, e.kind, e.text ?? "", JSON.stringify(e.data ?? {}), primary ? (ctx.dedupKey ?? null) : null);
  return toEvent(r as Record<string, unknown>);
}

/** dedupKey 命中：同一动作 → 原样返回；key 被别的动作用过 → dedup_mismatch */
function replay<T>(db: Database, ctx: WriteCtx, e: Pick<EventDraft, "project" | "target" | "kind">, load: () => T): WriteResult<T> | null {
  if (!ctx.dedupKey) return null;
  const prev = getEventByDedup(db, ctx.dedupKey);
  if (!prev) return null;
  if (prev.project !== e.project || prev.target !== e.target || prev.kind !== e.kind) {
    throw new LedgerError("dedup_mismatch", `dedupKey ${ctx.dedupKey} 已用于 ${prev.project}/${prev.target || "(项目)"} 的 ${prev.kind} 事件`);
  }
  return { row: load(), event: prev, duplicate: true };
}

function pick<K extends string>(patch: Record<string, unknown>, allowed: readonly K[], what: string): Partial<Record<K, unknown>> {
  const bad = Object.keys(patch).filter((k) => !(allowed as readonly string[]).includes(k));
  if (bad.length) throw new LedgerError("invalid", `${what} 不能改这些字段：${bad.join(", ")}`);
  if (!Object.keys(patch).length) throw new LedgerError("invalid", `${what} 没有要改的字段`);
  return patch as Partial<Record<K, unknown>>;
}

function toColumn(k: string, v: unknown): unknown {
  return k === "extra" ? JSON.stringify(v ?? {}) : (v ?? null);
}

function checkStatus(status: unknown): void {
  if (!ITEM_STATUSES.includes(status as ItemStatus)) throw new LedgerError("invalid", `事项状态只能是 ${ITEM_STATUSES.join(" / ")}，收到 ${String(status)}`);
}

function checkItemRef(db: Database, project: string, itemId: unknown): void {
  if (itemId == null) return;
  if (!getItem(db, project, String(itemId))) throw new LedgerError("not_found", `项目 ${project} 没有事项 ${String(itemId)}`);
}

function mustTask(db: Database, id: string): LedgerTask {
  const t = getTask(db, id);
  if (!t) throw new LedgerError("not_found", `没有任务 ${id}`);
  return t;
}

// ── 事项 ──

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

export function createItem(db: Database, ctx: WriteCtx, input: NewItem): WriteResult<LedgerItem> {
  return tx(db, () => {
    const key = { project: input.project, target: input.id, kind: "item" as const };
    const dup = replay(db, ctx, key, () => getItem(db, input.project, input.id) as LedgerItem);
    if (dup) return dup;
    if (!input.id || !input.title) throw new LedgerError("invalid", "事项要有 id 和 title");
    const status = input.status ?? "todo";
    checkStatus(status);
    if (getItem(db, input.project, input.id)) throw new LedgerError("conflict", `事项 ${input.project}/${input.id} 已存在`);
    const now = ctx.now ?? Date.now();
    const row = { ownerWords: "", priority: "", oneLine: "", next: "", extra: {}, ...input, status };
    db.prepare(
      "INSERT INTO items (project, id, title, ownerWords, priority, status, oneLine, next, rev, extra, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
    ).run(row.project, row.id, row.title, row.ownerWords, row.priority, row.status, row.oneLine, row.next, JSON.stringify(row.extra), now, now);
    const { project: _p, id: _i, ...patch } = row;
    const event = insertEvent(db, ctx, { ...key, data: { op: "new", patch, rev: 1 } }, true);
    return { row: getItem(db, input.project, input.id) as LedgerItem, event, duplicate: false };
  });
}

/** extra 整体替换（带 rev 的 CAS 保证不会覆盖别人刚写的） */
export function setItem(db: Database, ctx: WriteCtx, input: { project: string; id: string; rev: number; patch: ItemPatch }): WriteResult<LedgerItem> {
  return tx(db, () => {
    const key = { project: input.project, target: input.id, kind: "item" as const };
    const dup = replay(db, ctx, key, () => getItem(db, input.project, input.id) as LedgerItem);
    if (dup) return dup;
    const patch = pick(input.patch as Record<string, unknown>, ITEM_FIELDS, "事项");
    if ("status" in patch) checkStatus(patch.status);
    const cur = getItem(db, input.project, input.id);
    if (!cur) throw new LedgerError("not_found", `没有事项 ${input.project}/${input.id}`);
    if (cur.rev !== input.rev) throw new LedgerError("conflict", `事项 ${input.id} 已被改过：当前 rev ${cur.rev}，你带的是 ${input.rev}`, { rev: cur.rev });
    const cols = Object.keys(patch);
    const rev = cur.rev + 1;
    db.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(", ")}, rev = ?, updatedAt = ? WHERE project = ? AND id = ?`).run(
      ...(cols.map((c) => toColumn(c, patch[c as keyof typeof patch])) as string[]),
      rev,
      ctx.now ?? Date.now(),
      input.project,
      input.id,
    );
    const event = insertEvent(db, ctx, { ...key, data: { op: "set", patch, rev } }, true);
    return { row: getItem(db, input.project, input.id) as LedgerItem, event, duplicate: false };
  });
}

// ── 任务 ──

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
  /** 默认 spec；导入历史任务时可直接落在当时的阶段（不能是 blocked，缺 stageBefore） */
  stage?: Stage;
  round?: number;
}

const TASK_INSERT_COLS = ["id", "project", "itemId", "title", "kind", "stage", "round", "agent", "pm", "branch", "pr", "headSHA", "spec", "specRev", "model", "extra"] as const;

export function createTask(db: Database, ctx: WriteCtx, input: NewTask): WriteResult<LedgerTask> {
  return tx(db, () => {
    const key = { project: input.project, target: input.id, kind: "task" as const };
    const dup = replay(db, ctx, key, () => mustTask(db, input.id));
    if (dup) return dup;
    if (!input.id || !input.title) throw new LedgerError("invalid", "任务要有 id 和 title");
    if (!TASK_KINDS.includes(input.kind)) throw new LedgerError("invalid", `任务 kind 只能是 ${TASK_KINDS.join(" / ")}`);
    const stage = input.stage ?? "spec";
    if (!STAGES.includes(stage) || stage === "blocked") throw new LedgerError("invalid", `新任务不能落在阶段 ${stage}`);
    if (getTask(db, input.id)) throw new LedgerError("conflict", `任务 ${input.id} 已存在（任务 id 全局唯一）`);
    checkItemRef(db, input.project, input.itemId);
    const row: Record<string, unknown> = { specRev: 1, round: 0, extra: {}, ...input, stage };
    const now = ctx.now ?? Date.now();
    db.prepare(
      `INSERT INTO tasks (${TASK_INSERT_COLS.join(", ")}, rev, createdAt, updatedAt) VALUES (${TASK_INSERT_COLS.map(() => "?").join(", ")}, 1, ?, ?)`,
    ).run(...(TASK_INSERT_COLS.map((c) => toColumn(c, row[c])) as string[]), now, now);
    const { project: _p, id: _i, ...patch } = row;
    const event = insertEvent(db, ctx, { ...key, data: { op: "new", patch, rev: 1 } }, true);
    return { row: mustTask(db, input.id), event, duplicate: false };
  });
}

/** stage / round / stageBefore 只能经 moveStage 改；kind / project / id 建了就不变 */
export function setTask(db: Database, ctx: WriteCtx, input: { id: string; rev: number; patch: TaskPatch }): WriteResult<LedgerTask> {
  return tx(db, () => {
    const cur = mustTask(db, input.id);
    const key = { project: cur.project, target: cur.id, kind: "task" as const };
    const dup = replay(db, ctx, key, () => mustTask(db, input.id));
    if (dup) return dup;
    const patch = pick(input.patch as Record<string, unknown>, TASK_FIELDS, "任务");
    if (cur.rev !== input.rev) throw new LedgerError("conflict", `任务 ${input.id} 已被改过：当前 rev ${cur.rev}，你带的是 ${input.rev}`, { rev: cur.rev });
    if ("itemId" in patch) checkItemRef(db, cur.project, patch.itemId);
    const rev = updateTask(db, ctx, cur, patch);
    const event = insertEvent(db, ctx, { ...key, data: { op: "set", patch, rev } }, true);
    return { row: mustTask(db, input.id), event, duplicate: false };
  });
}

function updateTask(db: Database, ctx: WriteCtx, cur: LedgerTask, patch: Record<string, unknown>): number {
  const cols = Object.keys(patch);
  const rev = cur.rev + 1;
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, rev = ?, updatedAt = ? WHERE id = ?`).run(
    ...(cols.map((c) => toColumn(c, patch[c])) as string[]),
    rev,
    ctx.now ?? Date.now(),
    cur.id,
  );
  return rev;
}

// ── 阶段 ──

export interface StageMove {
  /** 调用方以为的当前阶段（CAS） */
  from: Stage;
  to: Stage;
}

/** 在已开的事务里推一步：CAS from → 现算角色 → canTransition → 改行 + stage 事件 */
function applyMove(db: Database, ctx: WriteCtx, task: LedgerTask, move: StageMove, primary: boolean, text = ""): { task: LedgerTask; event: LedgerEvent } {
  if (task.stage !== move.from) {
    throw new LedgerError("conflict", `任务 ${task.id} 当前阶段是 ${task.stage}，不是 ${move.from}`, { stage: task.stage, rev: task.rev });
  }
  const role = roleOf(ctx.actor, task, getMeta(db, task.project).pms);
  if (!role) throw new LedgerError("forbidden", `${ctx.actor} 不是任务 ${task.id} 的执行者，也不在项目 ${task.project} 的 PM 名单里`);
  const check = canTransition(task, move.to, role);
  if (!check.ok) throw new LedgerError(check.code === "forbidden" ? "forbidden" : "invalid", check.reason, { stage: task.stage });
  const next = nextTaskState(task, move.to);
  updateTask(db, ctx, task, next);
  const data = { from: task.stage, to: move.to, round: next.round, specRev: next.specRev, ...(next.stageBefore ? { stageBefore: next.stageBefore } : {}) };
  const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "stage", text, data }, primary);
  return { task: mustTask(db, task.id), event };
}

export function moveStage(db: Database, ctx: WriteCtx, input: { taskId: string; text?: string } & StageMove): WriteResult<LedgerTask> {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "stage" }, () => task);
    if (dup) return dup;
    const { task: row, event } = applyMove(db, ctx, task, input, true, input.text);
    return { row, event, duplicate: false };
  });
}

/** 交付：记 headSHA 与证据位置；带 moveFrom 时同一事务推到 review（build / fix → review） */
export function deliver(
  db: Database,
  ctx: WriteCtx,
  input: { taskId: string; headSHA?: string; evidence?: string; text?: string; moveFrom?: Stage },
): WriteResult<LedgerTask> {
  return tx(db, () => {
    let task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "deliver" }, () => task);
    if (dup) return dup;
    const data = { round: task.round, headSHA: input.headSHA ?? null, evidence: input.evidence ?? null };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "deliver", text: input.text, data }, true);
    if (input.headSHA) {
      updateTask(db, ctx, task, { headSHA: input.headSHA });
      task = mustTask(db, task.id);
    }
    if (input.moveFrom) task = applyMove(db, ctx, task, { from: input.moveFrom, to: "review" }, false).task;
    return { row: task, event, duplicate: false };
  });
}

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["pass", "changes", "block"];

export interface ReviewInput {
  taskId: string;
  /** 审查者（PM 的子 agent / Claude 审查员 / agent-codex），由 PM 代写 */
  reviewer: string;
  verdict: ReviewVerdict;
  p0: number;
  p1: number;
  p2: number;
  /** 结论全文路径 */
  path?: string;
  text?: string;
  /** 同一事务推阶段（review → fix / merge / done / spec） */
  move?: StageMove;
}

export function recordReview(db: Database, ctx: WriteCtx, input: ReviewInput): WriteResult<LedgerTask> {
  return tx(db, () => {
    let task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "review" }, () => task);
    if (dup) return dup;
    if (!REVIEW_VERDICTS.includes(input.verdict)) throw new LedgerError("invalid", `verdict 只能是 ${REVIEW_VERDICTS.join(" / ")}`);
    for (const k of ["p0", "p1", "p2"] as const) {
      if (!Number.isInteger(input[k]) || input[k] < 0) throw new LedgerError("invalid", `${k} 要是非负整数`);
    }
    const { taskId: _t, text, move: _m, ...rest } = input;
    const data = { round: task.round, ...rest, path: input.path ?? null };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "review", text, data }, true);
    if (input.move) task = applyMove(db, ctx, task, input.move, false).task;
    return { row: task, event, duplicate: false };
  });
}

// ── 其它事件与项目级 ──

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
