/** Lease-aware effects for reviewer swaps; normal dispatch and merge proofs stay on their existing paths. */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { resolveBunPath } from "./bun-path.js";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { statePath } from "./paths.js";
import { peerPrRepoDir } from "./peer-pr-hold.js";
import { readRegistryAgentsSync } from "./registry.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import { CLAIM_LEASE_MS } from "./scheduler-dispatch.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { swapAuthorFamily } from "./lend-author-family.js";
import { assertSchedulerLease, forwardSchedulerLease, SCHEDULER_LEASE_ENV } from "./scheduler-lease-env.js";
import { localReviewerCount } from "./scheduler-pool-facts.js";
import { archiveReceipt, killOutcome, readLiveAgents, type RetireDeps } from "./scheduler-retire.js";
import { reviewMaterialCheck } from "./scheduler-model-wiring.js";
import { latestReviewerSwap, openRefusal, refusalEpochLapse, swappedSession } from "./scheduler-review-swap.js";
import { git, openReviewWorktree } from "./scheduler-review-worktree.js";
import { beginReviewerSwap, bindSchedulerSession, getSchedulerSession, recordReviewerSwapEffect, type SchedulerSession } from "./scheduler-sessions.js";
import type { EnsureResult } from "./worker-session.js";

type Manager = AutoTickDeps["manager"];
export interface ReviewSwapDeps {
  agent: Manager;
  agents: RetireDeps["agents"];
  /** tag names a refusal epoch's reviewer apart from the refused one, which may still be running (MODELX). */
  ensure(task: LedgerTask, family: AuthorFamily, old: SchedulerSession, tag?: string): Promise<EnsureResult>;
  active(): void;
  registryPath?: string;
}
const oneLine = (s: string): string => s.replace(/\s+/g, " ").slice(0, 560);

/** Exported for the child-process probes: invalid adopted leases remain an explicit empty value (fail closed). */
export function reviewSwapManagerEnv(base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const { [SCHEDULER_LEASE_ENV]: _old, CLAUDESTRA_SCHEDULER_SERVICE: _service, ...env } = base;
  const lease = forwardSchedulerLease();
  return { ...env, DISCORD_CHANNEL_ID: "", ...(lease === undefined ? {} : { [SCHEDULER_LEASE_ENV]: lease }) };
}

function productionDeps(db: Database): ReviewSwapDeps {
  const agent: Manager = async (...args) => {
    assertSchedulerLease();
    const r = await runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`, timeoutMs: 90_000,
      env: reviewSwapManagerEnv() });
    assertSchedulerLease();
    return r;
  };
  return { agent, agents: readLiveAgents, active: assertSchedulerLease, ensure: (task, family, old, tag) => createReplacement(db, task, family, old, agent, tag) };
}

async function createReplacement(db: Database, task: LedgerTask, family: AuthorFamily, old: SchedulerSession, agent: Manager, tag = ""): Promise<EnsureResult> {
  const name = `agent-task-rv-${task.id.toLowerCase()}-r${task.round}${tag}`, rows = readRegistryAgentsSync(), existing = rows.find((r) => r.name === name);
  if (existing && (existing.sessionId !== old.sessionId || existing.status !== "stopped")) {
    return { kind: "unknown", reason: `${name} 被其他会话占用，不能覆盖` };
  }
  const author = getSchedulerSession(db, task.id, "author");
  const source = peerPrRepoDir(task) ?? rows.find((r) => r.name === (author?.agent ?? task.agent))?.cwd;
  if (!source) return { kind: "manual", reason: "找不到作者工作目录，无法建立新的审查 worktree" };
  const dir = join(statePath("worktrees"), `rv-${task.id.toLowerCase()}${tag}`);
  assertSchedulerLease();
  const opened = await openReviewWorktree(source, dir, task.headSHA, async (args) => {
    assertSchedulerLease(); const result = await git(args); assertSchedulerLease(); return result;
  });
  assertSchedulerLease();
  if ("manual" in opened) return { kind: "manual", reason: opened.manual };
  const args = ["create", name, opened.dir, "--project", task.project, "--task", `${task.id} 审查`, "--card", task.id, "--card-role", "reviewer",
    "--purpose", "作者家族变更后的独立复验"];
  if (family === "codex") args.push("--runtime", "codex", "--transport", "acp");
  const r = await agent(...args);
  if (r.ok !== true) return { kind: "unknown", reason: oneLine(`新审查会话创建未确认：${String(r.error)}`) };
  for (let n = 0; n < 20; n++) {
    assertSchedulerLease();
    const row = readRegistryAgentsSync().find((a) => a.name === name);
    if (row?.sessionId && row.sessionId !== old.sessionId) {
      return { kind: "ready", created: true,
      ref: { taskId: task.id, role: "reviewer", agent: name, sessionId: row.sessionId, family, transport: row.transport === "acp" ? "acp" : "tmux" } };
    }
    await Bun.sleep(1000);
  }
  return { kind: "unknown", reason: `${name} 已建，但尚未收到新的 session id` };
}

const stopped = (a: Awaited<ReturnType<RetireDeps["agents"]>>[number]): boolean => a.status === "stopped" && !a.pending && !a.window;

async function stopOld(db: Database, ctx: WriteCtx, intent: SchedulerIntent, deps: ReviewSwapDeps): Promise<string | null> {
  const row = beginReviewerSwap(db, ctx, intent.id);
  if (row.killReceipt) return null;
  const reusedByAuthor = mustTask(db, intent.taskId).agent === row.agent;
  const excludedTask = reusedByAuthor ? intent.taskId : "";
  const shared = db.query(`SELECT id FROM tasks WHERE stage NOT IN ('verified','done','cancelled') AND agent = ? AND id != ? UNION
    SELECT taskId AS id FROM scheduler_sessions WHERE agent = ? AND state != 'retired' AND taskId != ? LIMIT 1`)
    .get(row.agent, excludedTask, row.agent, excludedTask);
  if (shared) return "旧审查 agent 仍被作者或另一张卡使用，等绑定解除后再停止";
  // The current author owns this live session; retiring its review binding must not stop the author's work.
  if (reusedByAuthor) {
    recordReviewerSwapEffect(db, ctx, intent.id, "reuse", `reused_by_author:${row.agent}`);
    return null;
  }
  const live = (await deps.agents()).find((a) => a.name === row.agent);
  deps.active();
  if (live && live.sessionId !== row.sessionId) return "旧审查 agent 当前已是其他会话，不能归档或停止它";
  if (!row.archiveReceipt) {
    const r = live ? await deps.agent("archive", row.agent) : { ok: true, note: "agent 已不存在，保留历史归档" };
    deps.active();
    if (r.ok !== true) return oneLine(`旧审查归档未完成：${String(r.error ?? r.note)}`);
    recordReviewerSwapEffect(db, ctx, intent.id, "archive", archiveReceipt(r));
    return "旧审查已归档，下轮确认停止";
  }
  const before = (await deps.agents()).find((a) => a.name === row.agent);
  deps.active();
  if (before && before.sessionId !== row.sessionId) return "停止前会话已变，不碰新会话";
  const result = !before || stopped(before) ? { receipt: "旧审查会话已停止" } : killOutcome(await deps.agent("kill", row.agent));
  deps.active();
  if (!("receipt" in result)) return "busy" in result ? result.busy : result.failed;
  const after = (await deps.agents()).find((a) => a.name === row.agent);
  deps.active();
  if (after && !stopped(after)) return "旧审查窗口或 pending 尚未清理，下轮继续";
  recordReviewerSwapEffect(db, ctx, intent.id, "kill", result.receipt);
  return null;
}

async function ensureNew(db: Database, ctx: WriteCtx, intent: SchedulerIntent, maxWorkers: number, deps: ReviewSwapDeps): Promise<string | null> {
  const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id);
  const swap = latestReviewerSwap(listEvents(db, { project: task.project, target: task.id }));
  // A refusal epoch has no review_swap intent: its own event is the completed retirement (scheduler-review-swap.ts).
  const refusal = !!swap?.data.refusal;
  if (!swap || typeof swap.data.intentId !== "string" || (!refusal && getIntent(db, swap.data.intentId)?.status !== "done")) {
    throw new LedgerError("conflict", "旧审查尚未完成换人");
  }
  if (getSchedulerSession(db, task.id, "reviewer")?.createIntentId === intent.id) return null;
  if (intent.status === "submitted") {
    if ((ctx.now ?? Date.now()) - intent.updatedAt < CLAIM_LEASE_MS) return "新的审查会话已认领创建，等待绑定回执";
    settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "unknown", receipt: "新审查会话创建结果未确认，不重复创建" });
    return "新审查会话创建结果未确认";
  }
  if (intent.status !== "pending" || intent.node !== "adversarial_review" || task.stage !== "review" || task.headSHA !== intent.head ||
    task.specRev !== intent.specRev || task.rev !== intent.taskRev || workflow?.mode !== "auto" || workflow.specRev !== task.specRev) throw new LedgerError("conflict", "新审查会话的创建意图已过期");
  if (localReviewerCount(db, task.project, task.id) >= maxWorkers) return "本机另一家族审查名额已满，等待空位后自动续派";
  const lapse = refusal ? refusalEpochLapse(db, task, { check: reviewMaterialCheck(db) }) : null; // MODELX: hold / revoked approval / changed materials since the epoch
  if (lapse) throw new LedgerError("conflict", `不建豁免审查会话，退人工：${lapse}`);
  // A FAM1a epoch's toFamily is the author family it retired for (FAMW check); a MODELX refusal epoch's toFamily is the reviewer's target.
  const wrote = refusal ? remoteHeadFamily(db, task) ?? workflow.authorFamily : swapAuthorFamily(db, task, workflow, swap);
  settleIntent(db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "claimed; ensure replacement reviewer" });
  const family: AuthorFamily = refusal ? swap.data.toFamily as AuthorFamily : wrote === "claude" ? "codex" : "claude";
  // MODELXW: a legacy refused ticket's reviewer may still be running too, so its successor gets its own name
  const got = await deps.ensure(task, family, swappedSession(db, swap.data.intentId), refusal ? "-ex" : swap.data.legacy === true ? "-re" : undefined);
  deps.active();
  if (got.kind !== "ready") {
    settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "unknown", receipt: oneLine(got.reason) });
    return got.reason;
  }
  bindSchedulerSession(db, ctx, { ...got.ref, taskId: task.id, role: "reviewer", intentId: intent.id, registryPath: deps.registryPath,
    ...(refusal ? { refusalCheck: reviewMaterialCheck(db) } : {}) });
  return null;
}

/** A committed retirement survives card drift; replacement creation still needs current CAS and safety authorization. */
function assertSwapCurrent(db: Database, intent: SchedulerIntent): void {
  const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id);
  const events = listEvents(db, { project: task.project, target: task.id });
  const retiring = intent.action === "review_swap" && latestReviewerSwap(events)?.data.intentId === intent.id;
  if (workflow?.mode !== "auto" || (!retiring && (task.stage !== "review" || task.rev !== intent.taskRev || task.specRev !== intent.specRev ||
    task.headSHA !== intent.head || workflow.specRev !== task.specRev))) throw new LedgerError("conflict", "换审查会话期间卡已变化，先重算");
  if (openRefusal(events)) {
    throw new LedgerError("conflict", "本卡有未处置的模型安全拒绝，不自动更换审查员");
  }
  const lapse = intent.action === "ensure_session" ? refusalEpochLapse(db, task, { check: reviewMaterialCheck(db) }) : null; // after every async effect, before the next
  if (lapse) throw new LedgerError("conflict", `豁免审查接续已失效，停止后续效果，退人工：${lapse}`);
}

/** Narrow manager command: no arbitrary lifecycle target; it comes only from a validated ledger intent. */
export async function reviewSwapStep(db: Database, ctx: WriteCtx, id: string, maxWorkers: number,
  deps: ReviewSwapDeps = productionDeps(db)): Promise<Record<string, unknown>> {
  deps.active();
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "更换审查员只由调度服务执行");
  const intent = getIntent(db, id);
  if (!intent || !["review_swap", "ensure_session"].includes(intent.action)) throw new LedgerError("invalid", "缺审查换人意图");
  if (!Number.isInteger(maxWorkers) || maxWorkers < 0 || maxWorkers > 32) throw new LedgerError("invalid", "审查名额需在 0–32");
  if (intent.status === "done") return { ok: true, step: "session", detail: "审查会话处理已完成" };
  if (!["pending", "submitted"].includes(intent.status)) return { ok: true, step: "held", detail: "意图结果未定或已取消" };
  const active = deps.active;
  deps = { ...deps, active: () => { active(); assertSwapCurrent(db, intent); } };
  deps.active();
  const wait = intent.action === "review_swap" ? await stopOld(db, ctx, intent, deps) : await ensureNew(db, ctx, intent, maxWorkers, deps);
  deps.active();
  if (wait) return { ok: true, step: "waiting", detail: wait };
  const receipt = intent.action === "review_swap"
    ? mustTask(db, intent.taskId).agent === swappedSession(db, id).agent
      ? "旧审查会话由本卡作者沿用，未停用" : "旧审查已归档并停止，允许重新放置"
    : "新审查 session 已绑定";
  settleIntent(db, ctx, { id, from: "submitted", to: "done", receipt });
  return { ok: true, step: "session", detail: intent.action === "review_swap" ? "旧审查已更换" : "跨家族审查新会话已绑定" };
}

/** Post-swap ensure intents create a fresh worker; the old registry entry and session history remain addressable. */
export async function driveReviewSwap(card: { db: Database; task: LedgerTask; deps: AutoTickDeps; opts: { maxWorkers: number } },
  intent: SchedulerIntent): Promise<{ taskId: string; step: string; detail: string } | null> {
  if (intent.action !== "review_swap" && !(intent.action === "ensure_session" && intent.node === "adversarial_review" &&
    latestReviewerSwap(listEvents(card.db, { project: card.task.project, target: card.task.id })))) return null;
  const r = await card.deps.manager("ledger", "scheduler-review-swap", intent.id, "--max-workers", String(card.opts.maxWorkers));
  return { taskId: card.task.id, step: r.ok === true ? String(r.step) : "held", detail: String(r.ok === true ? r.detail : r.error) };
}
