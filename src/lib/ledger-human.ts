/**
 * 台账 v3.2 例外的写入（docs 10-ledger「附：v3.2 例外」）：human 节点的人在指给自己的 ask 上点「完成」→ deliver 事件，
 * 同一事务推 build / fix → review；PM 重开指派 → assign_reopen 事件。规则在 human-node.ts（纯函数），这里在一个
 * BEGIN IMMEDIATE 里重读任务、现算开单序号、过门、写——门在事务外判就会和并发的推阶段 / 重开抢。
 * 人写的说明只进 data.note，事件 text 是固定模板：班子路由和给 PM 的通知都只读 text，人写的字不进 agent 的上下文。
 */
import type { Database } from "bun:sqlite";
import { askPlanFor, assignSeqOf, checkHumanDeliver, humanDeliverText, isHumanNodeAsk, isWorkStage, type AskPlan, type DeliverGate, type HumanResult } from "./human-node.js";
import { hasAsksTable, listAsks, type Ask } from "./ledger-asks.js";
import { isManager, mustTask, type WriteCtx, type WriteResult } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask, LedgerError, listEvents, toTask } from "./ledger-store.js";
import { insertEvent, replay, tx } from "./ledger-tx.js";
import { applyMove } from "./ledger-write.js";

const NOTE_MAX = 4000;
/** 一次交付最多挂几张图；「待你处理」的作答收得更多（20），多出的由 bridge 截掉，不让整笔交付失败 */
export const HUMAN_ATTS_MAX = 9;
const SHA_RE = /^[0-9a-f]{64}$/;

/** 同一条 ask 只记一次交付：重复作答、bridge 重放都落到这个 key 上 */
export const humanDeliverKey = (askId: string): string => `human-deliver:${askId}`;

/** 任务现在的开单序号（事务里现读事件） */
function seqNow(db: Database, task: LedgerTask): number {
  return assignSeqOf(listEvents(db, { project: task.project, target: task.id }), task.id);
}

export interface HumanDeliverInput {
  taskId: string;
  askId: string;
  /** 作答的那条 ask 的 kind 与 dedupKey（调用方从 asks 表读） */
  ask: { dedupKey: string | null; kind: string };
  /** 作答人名下全部 person id（合并过的设备都算）与是否 owner；actor 必须是其中之一 */
  answerer: { persons: readonly string[]; isOwner: boolean };
  note?: string;
  /** talk 附件库的 sha256（按 ask 引用鉴权，见 talk-atts.ts） */
  atts?: readonly string[];
}

/** 门：actor 得是这次作答的人，再按 human-node.ts 的规则（阶段、本轮本次的 ask、assignee 本人或 owner） */
function gate(db: Database, actor: string, task: LedgerTask, input: HumanDeliverInput, result: HumanResult): DeliverGate {
  if (!input.answerer.persons.includes(actor)) return { ok: false, code: "forbidden", reason: `${actor} 不是这次作答的人` };
  return checkHumanDeliver(task, input.ask, input.answerer, result, seqNow(db, task));
}

/** 「做不了」不写台账，只判这次作答算不算数（算数才通知 PM）；返回判门时的任务 */
export function checkHumanCant(db: Database, actor: string, input: HumanDeliverInput): { gate: DeliverGate; task: LedgerTask | null } {
  const task = getTask(db, input.taskId);
  return { gate: task ? gate(db, actor, task, input, "cant") : { ok: false, code: "conflict", reason: `没有任务 ${input.taskId}` }, task };
}

/**
 * 人工交付：actor = 作答人认证后的 person id（local:<principalId>）。前提不满足（阶段已变、ask 过时、不是这个人）整笔不写。
 * 「做不了」不经这里：只结 ask，不写交付、不推阶段。
 */
export function humanDeliver(db: Database, actor: string, input: HumanDeliverInput, now?: number): WriteResult<LedgerTask> {
  const note = (input.note ?? "").trim();
  const atts = [...new Set(input.atts ?? [])];
  if (note.length > NOTE_MAX) throw new LedgerError("invalid", `说明最多 ${NOTE_MAX} 字`);
  if (atts.length > HUMAN_ATTS_MAX || !atts.every((a) => SHA_RE.test(a))) throw new LedgerError("invalid", `附件最多 ${HUMAN_ATTS_MAX} 张，且要是 sha256`);
  const ctx: WriteCtx = { actor, now, dedupKey: humanDeliverKey(input.askId) };
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "deliver" }, () => task);
    if (dup) return dup;
    const g = gate(db, actor, task, input, "done");
    if (!g.ok) throw new LedgerError(g.code, g.reason, { stage: task.stage, rev: task.rev });
    const moved = applyMove(db, ctx, task, { from: task.stage, to: "review" }, false, "", "executor").task;
    const data = { round: moved.round, headSHA: null, evidence: null, askId: input.askId, external: true, ...(note ? { note } : {}), ...(atts.length ? { atts } : {}) };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "deliver", text: humanDeliverText(task.id, "done"), data }, true);
    return { row: moved, event, duplicate: false };
  });
}

/**
 * PM 重开指派（ask 过期了，或人点了「做不了」、PM 处理完要再派一次）：记一条 assign_reopen，data 带本轮 round 与新的开单序号，
 * bridge 撤掉旧的、按新的 dedupKey 再开一条 ask。只有 PM / master / owner，只在 human 节点的 build / fix。
 */
export function reopenAssignment(db: Database, ctx: WriteCtx, taskId: string): WriteResult<LedgerTask> {
  return tx(db, () => {
    const task = mustTask(db, taskId);
    const dup = replay(db, ctx, { project: task.project, target: task.id, kind: "assign_reopen" }, () => task);
    if (dup) return dup;
    if (!isManager(db, ctx.actor, task)) throw new LedgerError("forbidden", `重开指派要项目 ${task.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    if (task.assigneeKind !== "human") throw new LedgerError("invalid", `${task.id} 不是指给人的任务`);
    if (!isWorkStage(task.stage)) throw new LedgerError("invalid", `${task.id} 当前阶段是 ${task.stage}，只有 build / fix 能重开指派`, { stage: task.stage });
    const data = { round: task.round, seq: seqNow(db, task) + 1 };
    const event = insertEvent(db, ctx, { project: task.project, target: task.id, kind: "assign_reopen", data }, true);
    return { row: task, event, duplicate: false };
  });
}

/** 该有指派 ask 的：负责人是人、在 build / fix 的任务，开单序号现算。调用方按 plan.dedupKey 开，撞上 = 这一次已经开过 */
export function pendingAssignments(db: Database): { task: LedgerTask; plan: AskPlan }[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE assigneeKind = 'human' AND stage IN ('build', 'fix') ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(toTask).flatMap((task) => {
    const plan = askPlanFor(task, seqNow(db, task));
    return plan ? [{ task, plan }] : [];
  });
}

/** 这条指派还是不是任务眼下该有的那条（任务在、同一项目、还在 build / fix，负责人与开单序号都对得上） */
export function isCurrentAssignment(db: Database, a: Pick<Ask, "project" | "taskId" | "dedupKey">): boolean {
  const task = a.taskId ? getTask(db, a.taskId) : null;
  return !!task && task.project === a.project && !!a.dedupKey && askPlanFor(task, seqNow(db, task))?.dedupKey === a.dedupKey;
}

/**
 * 开着、但已不是任务眼下那条的指派（离开 build / fix、改派、PM 重开过、任务没了）：bridge 撤成 cancelled，免得人答了一条台账不认的。
 * due 是本轮已算好的 pendingAssignments（省得再算一遍）
 */
export function staleAssignments(db: Database, due = pendingAssignments(db)): Ask[] {
  if (!hasAsksTable(db)) return [];
  const want = new Set(due.map((x) => `${x.task.project}\n${x.plan.dedupKey}`));
  return listAsks(db, { states: ["open"], source: "system" }).filter((a) => isHumanNodeAsk(a) && !want.has(`${a.project}\n${a.dedupKey}`));
}

/**
 * 项目开没开班子（meta team，值带 sinceSeq 才算开）：开了，人工交付和执行者交付一样由班子路由通知，这里不再给 PM 发。
 * 班子的读法以 ledger-store 的 getMeta 为准，这里只看开没开（班子那边的 toTeam 同一判据）。
 */
export function projectHasTeam(db: Database, project: string): boolean {
  const r = db.prepare("SELECT value FROM meta WHERE project = ? AND key = 'team'").get(project) as { value: string } | null;
  if (!r) return false;
  const v = JSON.parse(r.value) as unknown;
  return !!v && typeof v === "object" && typeof (v as { sinceSeq?: unknown }).sinceSeq === "number";
}
