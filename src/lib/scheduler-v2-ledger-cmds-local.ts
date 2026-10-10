import type { Database } from "bun:sqlite";
import { INTENT_ACTIONS, INTENT_STATUSES, type IntentAction, type IntentStatus } from "./ledger-scheduler.js";
import { planIntent } from "./ledger-scheduler-write.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { beginRetire, bindSchedulerSession, recordSessionRetirement, type SessionRole, type SessionTransport } from "./scheduler-sessions.js";
import { advanceMergeRun, beginMergeRun, type MergePhase } from "./scheduler-merge.js";
import { schedulerV2LedgerFlags, type SchedulerV2LedgerCall } from "./scheduler-v2-ledger-cmds-args.js";

function choice<T extends string>(raw: string, allowed: readonly T[]): T {
  if (!allowed.includes(raw as T)) throw new LedgerError("invalid", `未知值 ${raw}`);
  return raw as T;
}

/** Only the injected executor scope may invoke these existing synchronous ledger writers. */
export function schedulerV2LedgerLocal(db: Database, call: SchedulerV2LedgerCall, args: readonly string[], registryPath?: string): Record<string, unknown> {
  const ctx = { actor: "scheduler" }, parse = schedulerV2LedgerFlags;
  if (call.command === "scheduler-plan") {
    const p = parse(args, ["id", "rev", "workflow-rev", "seq", "node", "action", "recipient", "reason", "resources"]);
    return { ok: true, ...planIntent(db, ctx, {
      id: p.need("id"), taskId: call.taskId, taskRev: p.integer("rev"), workflowRev: p.integer("workflow-rev"), causalSeq: p.integer("seq"),
      node: p.need("node"), action: choice<IntentAction>(p.need("action"), INTENT_ACTIONS),
      recipient: p.flags.recipient, reason: p.need("reason"), resources: p.flags.resources?.split(",").map(value => value.trim()),
    }) };
  }
  if (call.command === "scheduler-settle") {
    const p = parse(args, ["from", "to", "receipt"]);
    return { ok: true, intent: settleIntent(db, ctx, {
      id: call.intentId!, from: choice<IntentStatus>(p.need("from"), INTENT_STATUSES),
      to: choice<IntentStatus>(p.need("to"), INTENT_STATUSES), receipt: p.flags.receipt,
    }) };
  }
  if (call.command === "scheduler-retire") {
    parse(args, []);
    return { ok: true, ...beginRetire(db, ctx, call.taskId) };
  }
  if (call.command === "scheduler-session-bind") {
    const p = parse(args, ["role", "intent", "agent", "session", "family", "transport"]);
    if (call.argument !== call.taskId) throw new LedgerError("conflict", "绑定意图不属于所给任务");
    return { ok: true, ...bindSchedulerSession(db, ctx, {
      taskId: call.taskId, intentId: p.need("intent"), agent: p.need("agent"), sessionId: p.need("session"), registryPath,
      role: choice<SessionRole>(p.need("role"), ["author", "reviewer"]), family: choice(p.need("family"), ["claude", "codex"]),
      transport: choice<SessionTransport>(p.need("transport"), ["acp", "tmux", "peer"]),
    }) };
  }
  if (call.command === "scheduler-session-retire") {
    const p = parse(args, ["role", "intent", "effect", "receipt"]);
    if (call.argument !== call.taskId) throw new LedgerError("conflict", "退役意图不属于所给任务");
    return { ok: true, session: recordSessionRetirement(db, ctx, {
      taskId: call.taskId, intentId: p.need("intent"), role: choice<SessionRole>(p.need("role"), ["author", "reviewer"]),
      effect: choice(p.need("effect"), ["archive", "kill"]), receipt: p.need("receipt"),
    }) };
  }
  if (call.command === "scheduler-merge-begin") {
    const p = parse(args, ["required-checks"]);
    return { ok: true, ...beginMergeRun(db, ctx, call.intentId!, p.need("required-checks").split(",")) };
  }
  const p = parse(args, ["from", "to", "rev", "receipt", "merge-sha", "new-head"]);
  return { ok: true, run: advanceMergeRun(db, ctx, {
    intentId: call.intentId!, from: p.need("from") as MergePhase, to: p.need("to") as MergePhase, rev: p.integer("rev"),
    receipt: p.flags.receipt, mergeSha: p.flags["merge-sha"], newHead: p.flags["new-head"],
  }) };
}
