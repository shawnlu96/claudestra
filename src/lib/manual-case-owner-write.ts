/**
 * merge-arch-OWN1 writers: `manual-case-set` (a valid project PM / master / owner names the responsible, the response deadline and the
 * next step of the current manual episode) and the scheduler's backfill of the defaults (`scheduler-manual-case-default`, through the
 * leased writer). Both re-read the card inside one immediate transaction: still manual, the same entry seq (episode), and for the
 * backfill the same workflow rev, no record yet and the switch still at the caller's mode. Neither touches the workflow, the episode,
 * a merge slot, a manual merge request or any intent; a hold is never released here. tests/manual-case-owner*.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { endStages } from "./ledger-stages.js";
import { busyAsLedgerError, getMeta, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { ManualCaseRole } from "./manual-case-defaults.js";
import type { ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { MANUAL_CASE_KEY, MANUAL_CASE_OP, MANUAL_CASE_ROLES, manualCaseOwnershipMode, pendingDefault, subjectValid, type PendingDefault } from "./manual-case-owner.js";
import { manualEntry } from "./manual-reason.js";
import { recordObserved } from "./recovery-policy.js";

export interface ManualCaseSetInput {
  taskId: string; entrySeq: number; responsible: string; role: string; dueAt: number; next: string; reason: string;
  waitingOn?: string; workflowRev?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** Re-checks and the append under one immediate transaction (appendEvent nests inside it and keeps its own write gate). */
const tx = <T>(db: Database, fn: () => T): T => busyAsLedgerError("写入", () => db.transaction(fn).immediate());

/** Explicit setting: the command's own authorization, never held back by the backfill switch (PM 定 7). */
export function setManualCase(db: Database, ctx: WriteCtx, input: ManualCaseSetInput) {
  const next = textOneLine(input.next, "下一步", 300), reason = textOneLine(input.reason, "原因", 600);
  const waitingOn = input.waitingOn === undefined ? null : textOneLine(input.waitingOn, "等待节点", 200);
  if (!MANUAL_CASE_ROLES.includes(input.role as ManualCaseRole)) throw new LedgerError("invalid", `--role 只能是 ${MANUAL_CASE_ROLES.join(" / ")}`);
  if (!Number.isSafeInteger(input.dueAt)) throw new LedgerError("invalid", "--due-at 要是 ISO 时间");
  return tx(db, () => {
    const task = getTask(db, input.taskId);
    if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
    if (!actorMayConfigure(db, ctx.actor, task.project)) throw new LedgerError("forbidden", `设人工处置要项目 ${task.project} 的有效 PM / master / owner（你是 ${ctx.actor}）`);
    const wf = getWorkflow(db, task.id);
    if (!wf || wf.mode !== "manual") throw new LedgerError("conflict", `${task.id} 当前不在 manual，没有可处置的段`);
    if (input.workflowRev !== undefined && wf.rev !== input.workflowRev) throw new LedgerError("conflict", `流程版本已是 ${wf.rev}（你给 ${input.workflowRev}），重读后再设`);
    if (endStages(task.kind).includes(task.stage)) throw new LedgerError("conflict", `${task.id} 已到终态 ${task.stage}，无待处置`);
    const entry = manualEntry(listEvents(db, { project: task.project, target: task.id }));
    if (!entry) throw new LedgerError("conflict", `${task.id} 没有进入 manual 的正式事件：旧未知段不伪造进入点，先补记理由`);
    if (entry.event.seq !== input.entrySeq) throw new LedgerError("conflict", `当前段是 #${entry.event.seq}（你给 #${input.entrySeq}），重读 manual-queue 后再设`);
    const role = input.role as ManualCaseRole;
    if (!subjectValid(role, input.responsible, task, getMeta(db, task.project))) {
      throw new LedgerError("invalid", role === "pm" ? `${input.responsible} 不是项目 ${task.project} 的有效 PM`
        : role === "owner" ? "--role owner 时 --responsible 要写 owner" : `执行者只能指派卡当前的执行者（${task.agent ?? "无"}）`);
    }
    const ev = appendEvent(db, ctx, { project: task.project, target: task.id, kind: "decision",
      text: `人工处置 #${entry.event.seq}：${input.responsible}（${role}）负责，${iso(input.dueAt)} 前响应；下一步：${next}；原因：${reason}`,
      data: { op: MANUAL_CASE_OP, source: "explicit", entrySeq: entry.event.seq, workflowRev: wf.rev, responsible: input.responsible, role,
        dueAt: input.dueAt, next, ...(waitingOn ? { waitingOn } : {}), reason } });
    return { ok: true, taskId: task.id, entrySeq: entry.event.seq, seq: ev.event.seq, duplicate: ev.duplicate };
  });
}

export interface ManualCaseDefaultInput { taskId: string; entrySeq: number; workflowRev: number; mode: "on" | "observe" }

const defaultDedupKey = (taskId: string, entrySeq: number) => `manual-case-default:${taskId}:${entrySeq}`;
/** One observation per episode and would-be assignment: the same subject and deadline is never noted twice. */
export const observeActionKey = (p: Pick<PendingDefault, "entrySeq" | "who" | "dueAt">) =>
  `assign.${p.entrySeq}.${createHash("sha256").update(JSON.stringify([p.who, p.dueAt])).digest("hex").slice(0, 12)}`;

/** The scheduler's backfill (on) or its would-assign note (observe); contents are derived here, never taken from the caller. */
export function writeManualCaseDefault(db: Database, ctx: WriteCtx, input: ManualCaseDefaultInput, active: () => void, port?: ExplicitPolicyPort) {
  return tx(db, () => {
    active();
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "缺省处置补记只给调度服务");
    const task = getTask(db, input.taskId), wf = getWorkflow(db, input.taskId);
    if (!task || !wf) throw new LedgerError("not_found", "任务或流程不存在");
    if (wf.rev !== input.workflowRev) throw new LedgerError("conflict", `流程版本已是 ${wf.rev}，拒绝补记`);
    const m = manualCaseOwnershipMode(task.project, port);
    if (m.mode !== input.mode) throw new LedgerError("forbidden", `${MANUAL_CASE_KEY} 当前是 ${m.mode}（${m.why}），不按 ${input.mode} 写`);
    const p = pendingDefault(task, wf.mode, listEvents(db, { project: task.project, target: task.id }), getMeta(db, task.project));
    if (!p.ok) throw new LedgerError("conflict", `不补记：${p.why}`);
    const v = p.value, now = ctx.now ?? Date.now();
    if (v.entrySeq !== input.entrySeq) throw new LedgerError("conflict", `当前段是 #${v.entrySeq}（调用方读到 #${input.entrySeq}），下一轮重读`);
    const assign = { entrySeq: v.entrySeq, responsible: v.who, role: v.role, dueAt: v.dueAt, slaHours: v.slaHours, basis: v.source };
    if (input.mode === "observe") {
      return { ok: true, mode: "observe", ...recordObserved(db, { project: task.project, mechanism: MANUAL_CASE_KEY, target: task.id, actionKey: observeActionKey(v),
        action: `把 ${task.id} 的 manual 段 #${v.entrySeq} 缺省分给 ${v.who}（${v.role}），${iso(v.dueAt)} 前响应`, data: { wouldAssign: assign } }, now) };
    }
    const ev = appendEvent(db, { actor: "scheduler", now, dedupKey: defaultDedupKey(task.id, v.entrySeq) }, { project: task.project, target: task.id, kind: "decision",
      text: `人工处置 #${v.entrySeq} 缺省补记：${v.who}（${v.role}）负责，${iso(v.dueAt)} 前响应（${v.source}）`,
      data: { op: MANUAL_CASE_OP, source: "default", workflowRev: wf.rev, ...assign } });
    return { ok: true, mode: "on", recorded: !ev.duplicate, seq: ev.event.seq };
  });
}
