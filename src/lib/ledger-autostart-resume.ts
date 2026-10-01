/**
 * `ledger scheduler-auto-resume`（i28-A1 §4）的事务：只给调度身份。事务里重跑一遍交回判定（scheduler-autostart-resume.ts resumeVerdict）
 * 与开关，再走 PM 交回的同一个核心（ledger-scheduler-resume.ts resumeCore），事件仍是 workflow_resume，另记 auto / trigger / deliver。
 * 结果分四种，调用方据此决定出不出声：raced（卡或流程已被改过、PM 抢先交回了）与 not_eligible（判定不再成立）不出声；
 * rejected（核心拒：还有结果未定的意图、池单没对账）通知 PM 一次；busy 下一轮再看。tests/scheduler-autostart-resume.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { resumeCore } from "./ledger-scheduler-resume.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import type { ServiceFacts } from "./scheduler-autostart.js";
import { resumeVerdict, serviceBlock } from "./scheduler-autostart-resume.js";

export interface AutoResumeInput { taskId: string; taskRev: number; workflowRev: number; maxWorkers: number; svc: ServiceFacts }

export type AutoResumeOutcome =
  | { ok: true; workflow: TaskWorkflow; trigger: number; deliver: number }
  | { ok: false; code: "raced" | "not_eligible" | "rejected" | "busy"; error: string };

export function autoResume(db: Database, ctx: WriteCtx, input: AutoResumeInput): AutoResumeOutcome {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "自动交回只有调度服务能做（PM 用 workflow-resume）");
  try {
    return tx(db, (): AutoResumeOutcome => {
      const task = getTask(db, input.taskId);
      const wf = task ? getWorkflow(db, task.id) : null;
      if (!task || !wf) return { ok: false, code: "not_eligible", error: `${input.taskId} 没有调度流程` };
      if (wf.mode !== "manual" || task.rev !== input.taskRev || wf.rev !== input.workflowRev) {
        return { ok: false, code: "raced", error: "卡或流程已被改过（或 PM 已手动交回）" };
      }
      const blocked = serviceBlock(db, task, input.svc);
      if (blocked) return { ok: false, code: "not_eligible", error: blocked };
      const v = resumeVerdict(db, task, wf);
      if (!v.ok) return { ok: false, code: "not_eligible", error: v.why };
      const reason = `合并撤销后执行者交付了新 head ${v.facts.head.slice(0, 12)}（被撤销的是 ${v.facts.revoked.slice(0, 12)}），自动交回调度`;
      const r = resumeCore(db, ctx, { ...input, reason }, { auto: true, trigger: v.facts.trigger, deliver: v.facts.deliver });
      return { ok: true, workflow: r.workflow, trigger: v.facts.trigger, deliver: v.facts.deliver };
    });
  } catch (e) {
    // 核心拒绝时事务整笔回滚（池单的撤回也不落），这里只把原因交给调用方
    if (e instanceof LedgerError) return { ok: false, code: e.code === "busy" ? "busy" : "rejected", error: e.message };
    throw e;
  }
}
