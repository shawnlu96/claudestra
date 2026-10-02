/**
 * i28-SR1: a security card is reviewed on this machine only (scheduler-placement-plan.ts), so when the reviewing family's local
 * cap is 0 (not busy: configured 0) it can never be placed. The planner says so with a fixed wait reason instead of queueing
 * silently; the tick then writes one alarm event per card + reason and opens one PM ask (a: grant 1 slot for this card, the
 * default, only after PM confirms; b: another local reviewer family, with a reason and owner approval; c: back to the author).
 * A cap above 0 that is merely busy keeps the old queueing. tests/scheduler-sec-review.test.ts.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { openAskFull } from "./ledger-asks.js";
import { getWorkflow, type AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PlannerDecision } from "./scheduler-plan.js";

export const SEC_REVIEW_NO_ROOM = "安全卡审查放不下";
const CODE = "sec_review_no_room";

type Remote = { agents?: Partial<Record<AuthorFamily, number>>; localFamilies?: readonly AuthorFamily[] } | null | undefined;
interface SecFacts {
  workflow: { template: string; authorFamily: AuthorFamily } | null;
  reviewer: unknown;
  pool?: { remote: Remote } | null;
}

const reviewFamily = (author: AuthorFamily): AuthorFamily => author === "claude" ? "codex" : "claude";
const reasonFor = (family: AuthorFamily): string =>
  `${SEC_REVIEW_NO_ROOM}：安全卡只在本机审，审查要 ${family}，本机 ${family} 名额上限是 0；已报 PM 选 a 临时开名额 / b 改派 / c 退回重写`;

/** The local cap of a family: agents mode's limit, 0 when localFamilies leaves it out; null = no cap configured here. */
function localCap(remote: Remote, family: AuthorFamily): number | null {
  if (remote?.agents) return remote.agents[family] ?? 0;
  if (remote?.localFamilies) return remote.localFamilies.includes(family) ? null : 0;
  return null;
}

/** Planner hook: a security card whose review family has local cap 0 waits with the fixed reason; anything else = null (unchanged). */
export function secReviewNoRoom(s: SecFacts): { wait: string; code: string } | null {
  if (s.workflow?.template !== "security" || s.reviewer) return null;
  const family = reviewFamily(s.workflow.authorFamily);
  return localCap(s.pool?.remote, family) === 0 ? { wait: reasonFor(family), code: CODE } : null;
}

/** Card + reason, hashed because the reason is free text. */
const alarmKey = (taskId: string, reason: string): string =>
  `sec-review-no-room:${taskId}:${createHash("sha256").update(reason).digest("hex").slice(0, 24)}`;

function askBody(task: LedgerTask, family: AuthorFamily): string {
  return [`${task.id} 是安全卡，只在本机审；作者家族的对面是 ${family}，本机 ${family} 名额上限是 0，调度器放不下这次审查。`,
    "选一个：",
    `a. 本机临时给这张卡开 1 个 ${family} 名额（default；PM 确认后才执行）`,
    `b. 改派本机非 ${family} 的审查员：写明理由，仍需 owner 批`,
    "c. 退回作者重写"].join("\n");
}

/** Structural CLI port (same shape as scheduler-family-pick-notice.ts) keeps lib independent of manager. */
interface AlarmCommand {
  db: Database; p: { pos: string[] }; ctx(): WriteCtx; need(flag: string): string; task(id: string | undefined): LedgerTask;
}

/** `ledger scheduler-sec-review-alarm`: one alarm event + one PM ask per card and reason, in one transaction; a repeat writes nothing. */
export const secReviewAlarmCommand = {
  valued: ["rev"], bools: [], usage: "scheduler-sec-review-alarm <task> --rev N",
  run(c: AlarmCommand): Record<string, unknown> {
    return c.db.transaction(() => {
      const ctx = c.ctx(), task = c.task(c.p.pos[1]), wf = getWorkflow(c.db, task.id);
      if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "安全卡审查放不下的报警只由调度服务记账");
      if (task.stage !== "review" || task.rev !== Number(c.need("rev")) || wf?.mode !== "auto" || wf.template !== "security") {
        throw new LedgerError("conflict", "卡已不在安全卡自动审查等待状态");
      }
      const family = reviewFamily(wf.authorFamily), reason = reasonFor(family), key = alarmKey(task.id, reason);
      const prior = getEventByDedup(c.db, key);
      if (prior) return { ok: true, duplicate: true, event: prior };
      const { event } = appendEvent(c.db, { ...ctx, dedupKey: key }, {
        project: task.project, target: task.id, kind: "note", text: reason, data: { op: CODE, kind: "alarm", family },
      });
      const { ask } = openAskFull(c.db, {
        project: task.project, taskId: task.id, source: "system", kind: "decide", fromAgent: "scheduler", createdBy: "system:scheduler",
        blocking: true, title: `${task.id} 安全卡审查本机没有 ${family} 名额`, body: askBody(task, family), context: reason, dedupKey: `${key}:ask`,
        options: [{ type: "buttons", buttons: [
          { id: "sec_review_grant", label: `a. 临时开 1 个 ${family} 名额（default）`, style: "success" },
          { id: "sec_review_other", label: "b. 改派其他家族（要 owner 批）", style: "secondary" },
          { id: "sec_review_rewrite", label: "c. 退回作者重写", style: "danger" },
        ] }],
      }, ctx.now ?? Date.now());
      return { ok: true, duplicate: false, event, askId: ask.id };
    }).immediate();
  },
};

interface NoticeDeps { notifyPm(task: LedgerTask, text: string): Promise<void>; manager(...args: string[]): Promise<Record<string, unknown>> }

/** Tick hook (watch): on the planner's fixed reason, record the alarm + ask once and tell PM; an already recorded alarm is a no-op. */
export async function raiseSecReviewNoRoom(db: Database, task: LedgerTask, wait: Extract<PlannerDecision, { kind: "wait" }>, deps: NoticeDeps): Promise<void> {
  if (task.stage !== "review" || !wait.reason.startsWith(SEC_REVIEW_NO_ROOM) || getEventByDedup(db, alarmKey(task.id, wait.reason))) return;
  const r = await deps.manager("ledger", "scheduler-sec-review-alarm", task.id, "--rev", String(task.rev));
  if (r.ok !== true) { console.error(`⚠️ [scheduler] 安全卡审查报警未记账，下轮重试：${String(r.error)}`); return; }
  if (r.duplicate === true) return;
  try {
    await deps.notifyPm(task, `[调度引擎] ${task.id} ${wait.reason}。提问卡 ${String(r.askId)} 已开，default a 要 PM 确认才执行`);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] 安全卡审查报警通知失败（台账已记、提问卡已开）：${(e as Error).message}`);
  }
}
