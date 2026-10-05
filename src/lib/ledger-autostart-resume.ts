/**
 * `ledger scheduler-auto-resume`（i28-A1 §4）的事务：只给调度身份。事务里重跑一遍交回判定（scheduler-autostart-resume.ts resumeVerdict）
 * 与开关，再走 PM 交回的同一个核心（ledger-scheduler-resume.ts resumeCore），事件仍是 workflow_resume，另记 auto / trigger / deliver。
 * 结果分四种，调用方据此决定出不出声：raced（卡或流程已被改过、PM 抢先交回了）与 not_eligible（判定不再成立）不出声；
 * rejected（核心拒：还有结果未定的意图、池单没对账）通知 PM 一次；busy 下一轮再看。tests/scheduler-autostart-resume.test.ts。
 * 授予分支（resume_grant）还要 input.grant：事务里同一 policy 必须是 on、调度服务核过的 origin head 必须等于这次交付的 head，
 * 缺就 not_eligible（CLI 还没接 CFG 时就是这样：不交回、不出声）。tests/order-local-deliver*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { resumeCore } from "./ledger-scheduler-resume.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { ServiceFacts } from "./scheduler-autostart.js";
import { deliver } from "./ledger-write.js";
import {
  grantFacts, grantOf, localDeliveryPolicy, ORDER_TOOL_OP, RESUME_GRANT_OP, type GrantInput, type LocalDeliveryPolicyPort, type OrderToolCall, type ResumeGrant,
} from "./order-local-deliver.js";
import { resumeVerdict, serviceBlock } from "./scheduler-autostart-resume.js";

export interface AutoResumeInput {
  taskId: string; taskRev: number; workflowRev: number; maxWorkers: number; svc: ServiceFacts;
  grant?: { policy?: LocalDeliveryPolicyPort; checkedHead: string };
}

export type AutoResumeOutcome =
  | { ok: true; workflow: TaskWorkflow; trigger: number; deliver: number; grant?: string }
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
      const v = resumeVerdict(db, task, wf, ctx.now ?? Date.now());
      if (!v.ok) return { ok: false, code: "not_eligible", error: v.why };
      const { grant, head, trigger, deliver } = v.facts;
      if (grant) {
        if (localDeliveryPolicy(input.grant?.policy, task.project).mode !== "on") return { ok: false, code: "not_eligible", error: "本机交付自动交回没开（localDelivery 不是 on）" };
        if (input.grant?.checkedHead !== head) return { ok: false, code: "not_eligible", error: "调度服务没核过 origin 上的这个 head" };
      }
      const reason = grant ? `${grant} 后执行者本人经正式单交付了新 head ${head.slice(0, 12)}，自动交回调度`
        : `合并撤销后执行者交付了新 head ${head.slice(0, 12)}（被撤销的是 ${v.facts.revoked.slice(0, 12)}），自动交回调度`;
      const { grant: _g, ...core } = input;
      const r = resumeCore(db, ctx, { ...core, reason }, { auto: true, trigger, deliver, ...(grant ? { grant } : {}) });
      return { ok: true, workflow: r.workflow, trigger, deliver, ...(grant ? { grant } : {}) };
    });
  } catch (e) {
    // 核心拒绝时事务整笔回滚（池单的撤回也不落），这里只把原因交给调用方
    if (e instanceof LedgerError) return { ok: false, code: e.code === "busy" ? "busy" : "rejected", error: e.message };
    throw e;
  }
}

/**
 * `ledger resume-grant`：真 PM 授予一次「本人正式交付后自动交回」（order-local-deliver.ts grantFacts 的前置在同一事务里核，含 rev / workflowRev CAS）。
 * 只记一条 resume_grant 调度事件；同一 --dedup 重放返回原事件。调用方（CLI）已核过 requireRealPm。
 */
export function grantResume(db: Database, ctx: WriteCtx, input: GrantInput): { event: LedgerEvent; grant: ResumeGrant; duplicate: boolean } {
  return tx(db, () => {
    const dup = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
    const was = dup && grantOf(dup);
    if (dup && was && dup.actor === ctx.actor && dup.target === input.taskId) return { event: dup, grant: was, duplicate: true };
    if (dup) throw new LedgerError("conflict", `dedup 键 ${ctx.dedupKey} 已被别的事件用过`);
    const task = mustTask(db, input.taskId);
    const wf = getWorkflow(db, task.id);
    const g = grantFacts(db, task, wf, input, ctx.now ?? Date.now());
    const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 600);
    const event = insertEvent(db, ctx, {
      project: task.project, target: task.id, kind: "scheduler", text: `授予一次交付后自动交回：${reason}`,
      data: { op: RESUME_GRANT_OP, reason, taskRev: task.rev, workflowRev: (wf as TaskWorkflow).rev, resumeGrant: g },
    }, true);
    return { event, grant: g, duplicate: false };
  });
}

/**
 * `ledger deliver`：带 bridge 来源记录（MCP deliver，order-local-deliver.ts orderToolCall 已核过）时，交付与 order_tool_deliver 同一事务写下；
 * 重放（同 dedup）原样返回、不补记——第一次没记的（裸 CLI 先交）之后也补不上。没有来源 = 原样的 deliver。
 */
export function deliverWithSource(db: Database, ctx: WriteCtx, input: Parameters<typeof deliver>[2], via: OrderToolCall | null): ReturnType<typeof deliver> {
  if (!via) return deliver(db, ctx, input);
  return tx(db, () => {
    const r = deliver(db, ctx, input);
    if (r.duplicate) return r;
    insertEvent(db, ctx, {
      project: r.row.project, target: r.row.id, kind: "scheduler", text: `经派单工具交付 ${via.orderId}`,
      data: { op: ORDER_TOOL_OP, deliverSeq: r.event.seq, call: via },
    }, false);
    return r;
  });
}
