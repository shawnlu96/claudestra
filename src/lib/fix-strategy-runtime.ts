/** Fix swaps are resumed by durable intent and effect receipts, never by another guessed session creation. */
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { runBounded } from "./run-bounded.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { bindFixReplacement, getSchedulerSession } from "./scheduler-sessions.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { convergeReview } from "./review-converge.js";
import { fixHistory, fixStrategy, FIX_STRATEGY_RULE, DISPUTE_RULE } from "./fix-strategy.js";
import { convergenceEvent, convergenceLifecycle, createConvergenceWorker, stopConvergenceAuthor, type ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";
import type { SessionRef } from "./worker-session.js";
import { convergenceIntent } from "./fix-strategy-remote-intent.js";
import { remoteAuthorFix, remoteFixFallback, hasRemoteFix } from "./fix-strategy-remote.js";

export { convergenceIntent } from "./fix-strategy-remote-intent.js";
export { zeroSlotLifecycle } from "./fix-strategy-remote-context.js";

async function materialFor(db: Database, ctx: WriteCtx, intent: SchedulerIntent, source: string, deps: ConvergenceLifecycle) {
  const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id)!;
  const events = listEvents(db, { project: task.project, target: task.id });
  const read = currentReviewFacts(task, events);
  if (read.kind !== "facts") throw new LedgerError("conflict", "修复缺结构化审查报告");
  const configured = events.findLast((e) => e.data.op === "workflow" && e.data.specRev === task.specRev)?.seq ?? 0;
  const firstRound = events.find((e) => e.kind === "review" && e.seq > configured)?.data.round;
  const strategy = fixStrategy(events, convergeReview(events, read.facts, null).facts, remoteHeadFamily(db, task) ?? workflow.authorFamily,
    typeof firstRound === "number" ? firstRound : 1);
  if (!strategy || strategy.mode === "continue") throw new LedgerError("conflict", "没有连续两轮的 P1，不允许换会话");
  const path = join(deps.materialRoot ?? statePath("ledger", "reviews"), `${task.id}-fix-materials-${intent.eventSeq}.md`);
  if (!getEventByDedup(db, `scheduler:${intent.id}:materials`)) {
    const history = await fixHistory(events.filter((e) => e.seq > configured), strategy, deps.readReport ?? (async (p) => readFileSync(p, "utf8")), async (from, to) => {
      if (deps.diffSummary) return deps.diffSummary(source, from, to);
      if (!from) return "首轮审查前没有上一轮修复区间";
      const r = await runBounded(["git", "-C", source, "diff", "--stat", from, to], { timeoutMs: 15_000 });
      if (r.code !== 0 || r.timedOut) throw new Error(`修复 diff 摘要读取失败：${r.stderr}`);
      return r.stdout;
    });
    const text = [FIX_STRATEGY_RULE, DISPUTE_RULE, ...history.map((r) => `## 第 ${r.round} 轮 · ${r.head}\n\n` +
      `报告原文（${r.reportPath}）：\n${r.report}\n\n修复 diff 摘要：\n${r.diffSummary}\n\n复现 probe：\n${r.probes.join("\n")}`)].join("\n\n");
    deps.active();
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
    convergenceEvent(db, ctx, intent, "materials", { material: path, family: strategy.family, mode: strategy.mode, findings: strategy.findings.map((f) => f.finding) });
  }
  return { path, family: strategy.family };
}

export async function fixSwapStep(db: Database, ctx: WriteCtx, id: string, deps: ConvergenceLifecycle = convergenceLifecycle()) {
  deps.active();
  const intent = convergenceIntent(db, ctx, id, "fix_swap"), task = mustTask(db, intent.taskId);
  if (intent.status === "done") return { ok: true, step: "session", detail: "修复会话已更换" };
  const already = getEventByDedup(db, `scheduler:${id}:replacement`);
  if (already) {
    settleIntent(db, ctx, { id, from: "submitted", to: "done", receipt: "新修复会话已绑定" });
    return { ok: true, step: "session", detail: "新修复会话已绑定" };
  }
  if (task.stage !== "fix" || task.rev !== intent.taskRev) throw new LedgerError("conflict", "修复换会话计划已过期");
  const oldRow = getSchedulerSession(db, task.id, "author");
  if (oldRow?.transport === "peer" || task.assigneeKind === "peer_agent" || remoteHeadFamily(db, task) || hasRemoteFix(db, id)) {
    return remoteAuthorFix(db, ctx, intent, deps, materialFor);
  }
  const old: SessionRef | null = oldRow ? { ...oldRow, role: "author" } : null;
  const source = deps.registry().find((r) => r.name === (old?.agent ?? task.agent))?.cwd;
  if (!source) return { ok: true, step: "waiting", detail: "缺作者 checkout，不能准备修复材料" };
  const material = await materialFor(db, ctx, intent, source, deps); deps.active();
  if (intent.status === "pending") settleIntent(db, ctx, { id, from: "pending", to: "submitted", receipt: "claimed; 修复会话更换" });
  const wait = await stopConvergenceAuthor(db, ctx, intent, old, deps);
  if (wait) return { ok: true, step: "waiting", detail: wait };
  const ref = await createConvergenceWorker(db, ctx, intent, task, material.family, source, "author", deps);
  deps.active();
  if ("wait" in ref) return remoteFixFallback(db, ctx, intent, material, deps, ref.wait);
  if (ref.sessionId === old?.sessionId) throw new LedgerError("conflict", "换会话不能复用旧 session id");
  bindFixReplacement(db, ctx, id, ref, material.path, deps.registryPath);
  settleIntent(db, ctx, { id, from: "submitted", to: "done", receipt: "新修复会话已绑定" });
  return { ok: true, step: "session", detail: `${ref.family} 新修复会话已绑定` };
}
