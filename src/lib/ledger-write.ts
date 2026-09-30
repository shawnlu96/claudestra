/**
 * 内置台账的写入（docs 10-ledger §3）：每个导出函数一个 BEGIN IMMEDIATE 事务，改行与追加事件同进同出。
 * CAS：items / tasks 改字段带 rev，推阶段带 from；不符抛 LedgerError("conflict")，current 里是库里的实际值。
 * 幂等：ctx.dedupKey 全局唯一；同 key 再提交且 project / target / kind 一致 → 返回原事件与当前行、duplicate=true，不再校验 CAS。
 * 阶段角色由这里按 actor + 项目 PM 名单现算（roleOf），调用方不能自报角色；其余动作的角色矩阵在 CLI（T8b）。
 * tx / insertEvent / replay 在 ledger-tx.ts，只给写入模块用：直接写事件就绕过了阶段机与 owner 校验；纯校验在 ledger-checks.ts。
 */
import type { Database } from "bun:sqlite";
import {
  APPENDABLE_KINDS,
  checkIdFree,
  checkImportChain,
  checkItemRef,
  checkNewTask,
  checkReview,
  checkStatus,
  isOwnerLike,
  checkTarget,
  isManager,
  ITEM_FIELDS,
  mustTask,
  pick,
  resolveAssignee,
  TASK_FIELDS,
  toColumn,
  type AppendableKind,
  type ImportTaskInput,
  type ItemPatch,
  type NewItem,
  type NewTask,
  type ReviewInput,
  type StageMove,
  type TaskPatch,
  type WriteCtx,
  type WriteResult,
} from "./ledger-checks.js";
import { canTransition, nextTaskState, roleOf, TERMINAL_STAGES, type EventKind, type LedgerEvent, type LedgerItem, type LedgerTask, type Role, type Stage } from "./ledger-stages.js";
import { checksAllClear } from "./ledger-probes.js";
import { getItem, getMeta, LedgerError, pmsByProject, type LedgerMeta } from "./ledger-store.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";
import { activeStepFor, checkReviewHead, checkReviewStep, noteStepDelivered, noteStepReview } from "./ledger-steps-write.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { checkStructuredReview } from "./scheduler-review.js";
import { schedulerCanVerify } from "./scheduler-verify-gate.js";

export type { AppendableKind, ImportTaskInput, NewItem, NewTask, ReviewInput, StageMove, WriteCtx, WriteResult };

// ── 事项 ──

export function createItem(db: Database, ctx: WriteCtx, input: NewItem): WriteResult<LedgerItem> {
  return tx(db, () => {
    const key = { project: input.project, target: input.id, kind: "item" as const };
    const dup = replay(db, ctx, key, () => getItem(db, input.project, input.id) as LedgerItem);
    if (dup) return dup;
    if (!input.id || !input.title) throw new LedgerError("invalid", "事项要有 id 和 title");
    const status = input.status ?? "todo";
    checkStatus(status);
    if (getItem(db, input.project, input.id)) throw new LedgerError("conflict", `事项 ${input.project}/${input.id} 已存在`);
    checkIdFree(db, input.id, "item");
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

const TASK_INSERT_COLS = [
  "id", "project", "itemId", "title", "kind", "stage", "round", "agent", "assigneeKind", "assignee",
  "pm", "branch", "pr", "headSHA", "spec", "specRev", "model", "extra",
] as const;

/** 插任务行并记建任务事件；eventStage = 事件里记的起始阶段（导入时行落在最终阶段、时间线从 eventStage 开始） */
function insertTask(db: Database, ctx: WriteCtx, input: NewTask, imported: boolean, eventStage?: Stage, approx = false, fingerprint?: string): LedgerEvent {
  const given = Object.fromEntries(Object.entries(input).filter(([k, v]) => v !== undefined && ["agent", "assigneeKind", "assignee"].includes(k)));
  const assigned = resolveAssignee({ agent: null, assigneeKind: null, assignee: null }, given);
  const row: Record<string, unknown> = { specRev: 1, round: 0, extra: {}, ...input, ...assigned, stage: input.stage ?? "spec" };
  const now = ctx.now ?? Date.now();
  db.prepare(
    `INSERT INTO tasks (${TASK_INSERT_COLS.join(", ")}, rev, createdAt, updatedAt) VALUES (${TASK_INSERT_COLS.map(() => "?").join(", ")}, 1, ?, ?)`,
  ).run(...(TASK_INSERT_COLS.map((c) => toColumn(c, row[c])) as string[]), now, now);
  const { project, id, ...patch } = row;
  if (eventStage) patch.stage = eventStage;
  const data = { op: "new", patch, rev: 1, ...(imported ? { imported: true } : {}), ...(approx ? { approxTime: true } : {}), ...(fingerprint ? { fingerprint } : {}) };
  return insertEvent(db, ctx, { project: String(project), target: String(id), kind: "task", data }, true);
}

export function createTask(db: Database, ctx: WriteCtx, input: NewTask): WriteResult<LedgerTask> {
  return tx(db, () => {
    const dup = replay(db, ctx, { project: input.project, target: input.id, kind: "task" }, () => mustTask(db, input.id));
    if (dup) return dup;
    const event = insertTask(db, ctx, input, checkNewTask(db, ctx.actor, input));
    return { row: mustTask(db, input.id), event, duplicate: false };
  });
}

/**
 * 导入历史任务（ledger import）：只给 owner。任务行直接落在最终阶段，建任务事件记起始阶段 initialStage，
 * 之后按顺序追加合成事件，全部强制 imported:true，时间取各自的 ts；stage 事件须首尾相接、最后落到行的阶段（checkImportChain）。
 * 整批一个事务，半截失败不留残行；dedupKey 挂在建任务事件上，重跑整条返回 duplicate。
 */
export function importTask(db: Database, ctx: WriteCtx, input: ImportTaskInput): WriteResult<LedgerTask> {
  return tx(db, () => {
    const dup = replay(db, ctx, { project: input.task.project, target: input.task.id, kind: "task" }, () => mustTask(db, input.task.id));
    if (dup) return dup;
    if (!isOwnerLike(ctx.actor)) throw new LedgerError("forbidden", "只有 owner 能导入任务");
    checkNewTask(db, ctx.actor, input.task);
    const initial = input.initialStage ?? input.task.stage ?? "spec";
    checkImportChain(initial, input.task.stage ?? "spec", input.events);
    const event = insertTask(db, { ...ctx, now: input.createdTs }, input.task, true, initial, input.createdApprox, input.fingerprint);
    for (const e of input.events) {
      const draft = { project: input.task.project, target: input.task.id, kind: e.kind, text: e.text, data: { ...e.data, imported: true } };
      insertEvent(db, { ...ctx, now: e.ts }, draft, false);
    }
    return { row: mustTask(db, input.task.id), event, duplicate: false };
  });
}

/** stage / round / stageBefore 只能经 moveStage 改；kind / project / id 建了就不变；agent / assignee* / pm 只有 PM / master / owner 能改 */
export function setTask(db: Database, ctx: WriteCtx, input: { id: string; rev: number; patch: TaskPatch }): WriteResult<LedgerTask> {
  return tx(db, () => {
    const cur = mustTask(db, input.id);
    const key = { project: cur.project, target: cur.id, kind: "task" as const };
    const dup = replay(db, ctx, key, () => mustTask(db, input.id));
    if (dup) return dup;
    const patch = pick(input.patch as Record<string, unknown>, TASK_FIELDS, "任务");
    if (cur.rev !== input.rev) throw new LedgerError("conflict", `任务 ${input.id} 已被改过：当前 rev ${cur.rev}，你带的是 ${input.rev}`, { rev: cur.rev });
    const people = ["agent", "assigneeKind", "assignee", "pm"].filter((k) => k in patch);
    if (people.length && !isManager(db, ctx.actor, cur)) throw new LedgerError("forbidden", `只有 PM / master / owner 能改任务 ${cur.id} 的 ${people.join(" / ")}`);
    if ("itemId" in patch) checkItemRef(db, cur.project, patch.itemId);
    checkReviewHead(cur, patch.headSHA);
    const full = { ...patch, ...resolveAssignee(cur, patch) };
    const rev = updateTask(db, ctx, cur, full);
    const event = insertEvent(db, ctx, { ...key, data: { op: "set", patch: full, rev } }, true);
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

/**
 * 在已开的事务里推一步：CAS from → 现算角色 → canTransition → 改行 + stage 事件。
 * asRole 只给 ledger-human.ts（v3.2：human 节点的人按执行者推 build / fix → review，actor 是 person id，roleOf 认不出）；
 * 别的调用方传它就绕过了角色判定，tests/ledger-migrate.test.ts 查着只有那一处 import。
 */
export function applyMove(
  db: Database, ctx: WriteCtx, task: LedgerTask, move: StageMove, primary: boolean, text = "", asRole?: Role,
): { task: LedgerTask; event: LedgerEvent } {
  if (task.stage !== move.from) {
    throw new LedgerError("conflict", `任务 ${task.id} 当前阶段是 ${task.stage}，不是 ${move.from}`, { stage: task.stage, rev: task.rev });
  }
  const role = asRole ?? roleOf(ctx.actor, task, getMeta(db, task.project).pms, activeStepFor(db, task));
  if (!role) throw new LedgerError("forbidden", `${ctx.actor} 不是任务 ${task.id} 的执行者，也不在项目 ${task.project} 的 PM 名单里`);
  const check = canTransition(task, move.to, role);
  if (!check.ok) throw new LedgerError(check.code === "forbidden" ? "forbidden" : "invalid", check.reason, { stage: task.stage });
  const next = nextTaskState(task, move.to);
  updateTask(db, ctx, task, next);
  noteStepDelivered(db, ctx, task, move.to, move.model);
  const data = { from: task.stage, to: move.to, round: next.round, specRev: next.specRev, ...(next.stageBefore ? { stageBefore: next.stageBefore } : {}) };
  const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "stage", text, data }, primary);
  releaseFinishedCardLeases(db, task.id);
  return { task: mustTask(db, task.id), event };
}

/** 进 verified 只经 recordVerify（系统核对完成检查单）；从 blocked 回到原本就是 verified 的阶段不算「进」 */
export const VERIFY_HINT = "进 verified 要跑 `ledger verify <task>`：系统核对完成检查单，全过才推（stage 不能直接推 verified）";

export function moveStage(db: Database, ctx: WriteCtx, input: { taskId: string; text?: string } & StageMove): WriteResult<LedgerTask> {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "stage" }, () => task);
    if (dup) return dup;
    if (input.to === "verified" && task.stage !== "blocked") throw new LedgerError("forbidden", VERIFY_HINT, { stage: task.stage });
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
    if (TERMINAL_STAGES.includes(task.stage)) throw new LedgerError("invalid", `任务 ${task.id} 已是终态 ${task.stage}，不能再交付`, { stage: task.stage });
    // 先换 head 再推阶段（那一步记的交付 head 要是新的，ledger-steps-write.ts），再记交付：deliver 的 round 与同一轮的 review 事件一致
    if (input.headSHA) {
      checkReviewHead(task, input.headSHA);
      updateTask(db, ctx, task, { headSHA: input.headSHA });
      task = mustTask(db, task.id);
    }
    if (input.moveFrom) task = applyMove(db, ctx, task, { from: input.moveFrom, to: "review" }, false).task;
    const data = { round: task.round, headSHA: input.headSHA ?? null, evidence: input.evidence ?? null };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "deliver", text: input.text, data }, true);
    return { row: task, event, duplicate: false };
  });
}

export function recordReview(db: Database, ctx: WriteCtx, input: ReviewInput): WriteResult<LedgerTask> {
  return tx(db, () => {
    let task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "review" }, () => task);
    if (dup) return dup;
    checkReview(input, task);
    checkStructuredReview(input, task);
    const rc = checkReviewStep(db, task, input.reviewer);
    const { taskId: _t, text, move: _m, ...rest } = input;
    const data = { round: task.round, ...rest, path: input.path ?? null, ...(rc.explicit ? { author: rc.author, authorCheck: rc.authorCheck } : {}) };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "review", text, data }, true);
    noteStepReview(db, ctx, rc, input.verdict, input.model);
    if (input.move) task = applyMove(db, ctx, task, input.move, false).task;
    return { row: task, event, duplicate: false };
  });
}

/**
 * 完成检查单的结论（ledger-probes.ts 判好的）：记 verify 事件；pass 时同一事务推 live → verified。
 * 角色由这里现算（只有 PM / master / owner），任务必须还在 live——采集事实期间被人推走了就 conflict，不记一条过期的结论；
 * pass 还要在事务里再核一遍 checks（checksAllClear），调用方传错 result 也推不进去。
 */
export function recordVerify(
  db: Database,
  ctx: WriteCtx,
  input: { taskId: string; result: "pass" | "fail" | "unknown"; data: Record<string, unknown>; text?: string },
): WriteResult<LedgerTask> {
  return tx(db, () => {
    let task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "verify" }, () => task);
    if (dup) return dup;
    if (!(ctx.actor === "scheduler" ? schedulerCanVerify(db, task.id) : isManager(db, ctx.actor, task))) {
      throw new LedgerError("forbidden", `记完成检查要项目 ${task.project} 的 PM / master / owner 或已部署的调度运行（你是 ${ctx.actor}）`);
    }
    if (task.stage !== "live") throw new LedgerError("conflict", `任务 ${task.id} 当前阶段是 ${task.stage}，不是 live`, { stage: task.stage, rev: task.rev });
    if (input.result === "pass" && !checksAllClear(input.data.checks, input.data.incomplete)) {
      throw new LedgerError("invalid", "结论是 pass 但检查单不全 / 为空，或有没通过也没豁免的项");
    }
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "verify", text: input.text, data: { ...input.data, result: input.result } }, true);
    if (input.result === "pass") task = applyMove(db, ctx, task, { from: "live", to: "verified" }, false).task;
    return { row: task, event, duplicate: false };
  });
}

// ── 其它事件与项目级 ──

/** note / decision / deploy / rollback（verify 只经 recordVerify）；target 为 "" 表示项目级 */
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

/** 班子配置的输入：null = 关掉班子（停止事件路由） */
export type TeamInput = { dispatcher: string | null; audit: boolean } | null;

function metaValueOk(input: MetaInput): boolean {
  if (input.key === "pms") return Array.isArray(input.value) && input.value.every((p) => typeof p === "string" && p);
  if (input.key === "docsDir") return typeof input.value === "string";
  const v = input.value;
  return v === null || ((v.dispatcher === null || (typeof v.dispatcher === "string" && !!v.dispatcher)) && typeof v.audit === "boolean");
}

type MetaInput =
  | { project: string; key: "pms"; value: string[] }
  | { project: string; key: "docsDir"; value: string }
  | { project: string; key: "team"; value: TeamInput };

/** PM 名单、文档目录、班子配置只有 owner 能设；班子的 sinceSeq 取这条 meta 事件自己的 seq（之前的历史不路由） */
export function setMeta(db: Database, ctx: WriteCtx, input: MetaInput): WriteResult<LedgerMeta> {
  return tx(db, () => {
    const key = { project: input.project, target: "", kind: "meta" as const };
    const dup = replay(db, ctx, key, () => getMeta(db, input.project));
    if (dup) return dup;
    if (!isOwnerLike(ctx.actor)) throw new LedgerError("forbidden", `只有 owner 能设项目的 ${input.key}`);
    if (!metaValueOk(input)) throw new LedgerError("invalid", `${input.key} 的值不合法`);
    const event = insertEvent(db, ctx, { ...key, data: { op: "set", patch: { [input.key]: input.value } } }, true);
    const value = input.key === "team" && input.value ? { ...input.value, sinceSeq: event.seq } : input.value;
    putMeta(db, input.project, input.key, value);
    return { row: getMeta(db, input.project), event, duplicate: false };
  });
}

/**
 * agent 改名（manager rename 的钩子）：tasks.agent / tasks.pm 与各项目 PM 名单里的旧名换成新名，每处一条 task / meta 事件。
 * 不查角色：registry 改名已经过 manager 的认主守卫与写锁，这里只是跟着同步——不同步的话改名后 roleOf 认不出原执行者和 PM。
 */
export function renameAgentRefs(db: Database, ctx: WriteCtx, from: string, to: string): { tasks: string[]; projects: string[] } {
  return tx(db, () => {
    const tasks = (db.prepare("SELECT id FROM tasks WHERE agent = ? OR pm = ? ORDER BY id").all(from, from) as { id: string }[]).map((r) => r.id);
    for (const id of tasks) {
      const cur = mustTask(db, id);
      const patch = {
        ...(cur.agent === from ? { agent: to, ...resolveAssignee(cur, { agent: to }) } : {}),
        ...(cur.pm === from ? { pm: to } : {}),
      };
      const rev = updateTask(db, ctx, cur, patch);
      insertEvent(db, ctx, { project: cur.project, target: id, kind: "task", data: { op: "set", patch, rev, rename: { from, to } } }, false);
    }
    const projects: string[] = [];
    for (const [project, pms] of pmsByProject(db)) {
      if (!pms.includes(from)) continue;
      const next = pms.map((p) => (p === from ? to : p));
      putMeta(db, project, "pms", next);
      insertEvent(db, ctx, { project, target: "", kind: "meta", data: { op: "set", patch: { pms: next }, rename: { from, to } } }, false);
      projects.push(project);
    }
    for (const { project } of db.prepare("SELECT project FROM meta WHERE key = 'team' ORDER BY project").all() as { project: string }[]) {
      const team = getMeta(db, project).team;
      if (team?.dispatcher !== from) continue;
      putMeta(db, project, "team", { ...team, dispatcher: to });
      insertEvent(db, ctx, { project, target: "", kind: "meta", data: { op: "set", patch: { team: { ...team, dispatcher: to } }, rename: { from, to } } }, false);
      if (!projects.includes(project)) projects.push(project);
    }
    return { tasks, projects };
  });
}
