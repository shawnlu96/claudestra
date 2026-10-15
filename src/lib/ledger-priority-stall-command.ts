import type { StallClaim } from "./ledger-priority-stall-store.js";
/** A leased scheduler command owns every mutation; the daemon keeps its query_only connection. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { autoResume } from "./ledger-autostart-resume.js";
import { resumeVerdict } from "./scheduler-autostart-resume.js";
import type { ServiceFacts } from "./scheduler-autostart.js";
import { claimPriorityStalls, finishPriorityStall, livePriorityStallClaim, priorityStallOwner, priorityStallRevision } from "./ledger-priority-stall-store.js";
import type { StallResult } from "./ledger-priority-stall.js";

export interface StallCommand { op: "claim" | "check" | "finish" | "owner" | "heal"; key: string; token?: string; result?: StallResult; detail?: string }

function heal(db: Database, ctx: WriteCtx, c: StallClaim, svc: ServiceFacts, observe = false): { result: StallResult; detail: string } {
  const b = c.basis, t = b.taskId ? getTask(db, b.taskId) : null, w = t ? getWorkflow(db, t.id) : null;
  if (b.frozen || b.ask || !t || !w) return { result: "unavailable", detail: b.why };
  const verdict = resumeVerdict(db, t, w, ctx.now ?? Date.now());
  if (!verdict.ok || verdict.facts.grant) return { result: "unavailable", detail: verdict.ok ? "授予交回须由既有机制核验 origin head" : verdict.why };
  if (observe) return { result: "success", detail: "本会调用既有 scheduler-auto-resume 合法交回" };
  const r = autoResume(db, ctx, { taskId: t.id, taskRev: t.rev, workflowRev: w.rev, maxWorkers: svc.maxWorkers(b.project), svc });
  return { result: r.ok ? "success" : "failed", detail: r.ok ? "既有 scheduler-auto-resume 合法交回" : r.error };
}

export function priorityStallCommand(db: Database, ctx: WriteCtx, project: string, target: string, input: StallCommand,
  svc: ServiceFacts, expectedRev?: number, beforeWrite?: () => void): Record<string, unknown> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "停滞命令只给调度服务");
  if (!ctx.dedupKey) throw new LedgerError("invalid", "停滞命令需 dedup");
  if (expectedRev !== undefined && (!Number.isSafeInteger(expectedRev) || expectedRev < 0)) throw new LedgerError("invalid", "停滞 rev 不合法");
  if (!input || typeof input.key !== "string" || !["claim", "check", "finish", "owner", "heal"].includes(input.op)) {
    throw new LedgerError("invalid", "停滞命令参数不合法");
  }
  return db.transaction(() => {
    beforeWrite?.();
    const prior = ctx.dedupKey ? getEventByDedup(db, ctx.dedupKey) : null;
    if (prior) {
      if (prior.project !== project || prior.actor !== ctx.actor || prior.data.namespace !== "priority-stall-command"
        || JSON.stringify(prior.data.request) !== JSON.stringify({ target, input })) throw new LedgerError("dedup_mismatch", "停滞命令去重键内容不符");
      return prior.data.result as Record<string, unknown>;
    }
    if (expectedRev !== undefined && priorityStallRevision(db, project, input.key) !== expectedRev) {
      throw new LedgerError("conflict", "停滞周期版本已变");
    }
    const live = input.token ? livePriorityStallClaim(db, project, input.key, input.token) : null;
    if (live && (live.basis.taskId ?? "-") !== target) throw new LedgerError("forbidden", "停滞目标不匹配");
    let result: Record<string, unknown>;
    if (input.op === "claim") {
      const claims = claimPriorityStalls(db, ctx, project, input.key, target);
      if (claims.some((c) => (c.basis.taskId ?? "-") !== target)) throw new LedgerError("forbidden", "停滞目标不匹配");
      result = { claims };
    } else if (input.op === "check") return { ok: true, claim: live };
    else if (!live) return { ok: true, stale: true };
    else if (input.op === "owner") result = { askId: priorityStallOwner(db, ctx, project, input.key, input.token!) };
    else if (input.op === "heal") {
      if (live.action !== "heal") throw new LedgerError("invalid", "不是自愈认领");
      const r = heal(db, ctx, live, svc, live.mode === "observe");
      result = { ...r, finished: finishPriorityStall(db, ctx, project, input.key, input.token!, r.result, r.detail) };
    } else {
      if (!["success", "failed", "unknown", "unavailable"].includes(input.result ?? "")) throw new LedgerError("invalid", "停滞回执结果不合法");
      result = { finished: finishPriorityStall(db, ctx, project, input.key, input.token!, input.result!, input.detail ?? "") };
    }
    const response = { ok: true, ...result };
    if (input.op === "claim" && !(result.claims as unknown[]).length) return response;
    if (ctx.dedupKey) appendEvent(db, ctx, { project, target: target === "-" ? "" : target, kind: "note",
      data: { namespace: "priority-stall-command", request: { target, input }, result: response } });
    return response;
  }).immediate();
}
