/** LC1 owns the queue; only the scheduler pass driving a retry may lend its current intent/lease to creation. */
import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StartPlan } from "./dag-tools-start.js";
import type { LocalAuthorPlan } from "./scheduler-local-author-plan.js";
import type { StepIO, StartOutcome } from "./dag-tools-steps.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { getMeta, getTask } from "./ledger-store.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { queueLocalStart, retryQueuedLocalStarts } from "./scheduler-local-runtime-queue.js";
import type { LocalStartOptions } from "./scheduler-local-runtime-start.js";
import type { EnsureResult } from "./worker-session.js";

type Run = () => Promise<EnsureResult>;
interface Entry { result?: EnsureResult; error?: Error }
interface Driver { entry: Entry; run: Run | null; note: StepIO["manager"] | null; active: boolean }
const entries = new Map<string, Map<string, Entry>>();
const driver = new AsyncLocalStorage<Driver>();
const wait = (): Extract<EnsureResult, { kind: "wait" }> => ({ kind: "wait", reason: "本机执行者排队等槽，调度器下一轮自动重试" });

// A timer has no live scheduler reader or write lease. Reopen a read-only snapshot to retire stale callbacks safely.
function queueRefusal(path: string, plan: LocalAuthorPlan, opts: LocalStartOptions): string | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const task = getTask(db, plan.taskId), w = getWorkflow(db, plan.taskId), config = readSchedulerConfig(opts.configPath);
    if (!task || task.project !== plan.project || task.agent || !["spec", "build", "fix"].includes(task.stage)
      || (task.assigneeKind && task.assigneeKind !== "agent") || String(task.extra.placement ?? "").startsWith("peer:")
      || !w || w.mode !== "auto" || w.specRev !== task.specRev || getMeta(db, task.project).queueFrozen.frozen
      || !config.enabled || !config.autoDispatch || !config.projects[task.project]) return "卡或自动调度配置已改变";
    return null;
  } catch (e) { return `排队卡已无法核实：${(e as Error).message}`; }
  finally { db?.close(); }
}

async function retry(entry: Entry, plan: LocalAuthorPlan): Promise<Extract<EnsureResult, { kind: "wait" }> | StartOutcome> {
  const current = driver.getStore();
  if (!current?.active || current.entry !== entry || !current.run) return wait();
  let result: EnsureResult;
  try { result = await current.run(); }
  catch (e) {
    // LC1 removes failed callbacks; retain the error until the owning ensure call has observed it.
    entry.error = e instanceof Error ? e : new Error(String(e)); throw e;
  }
  if (result.kind === "wait") return result;
  entry.result = result;
  return result.kind === "ready" ? { ok: true, taskId: plan.taskId, placement: "local", branch: plan.branch, steps: [], reconciled: [] }
    : { ok: false, code: "start_failed", error: result.reason, failedStep: "agent", rolledBack: [], leftovers: [] };
}

export async function queuedLocalAuthor(db: Database, plan: LocalAuthorPlan, opts: LocalStartOptions, note: StepIO["manager"], run: Run): Promise<EnsureResult> {
  const path = db.filename, perDb = entries.get(path) ?? new Map<string, Entry>(); entries.set(path, perDb);
  const forget = () => { perDb.delete(plan.taskId); if (!perDb.size) entries.delete(path); };
  const prior = perDb.get(plan.taskId);
  if (prior) {
    const scope: Driver = { entry: prior, run, note, active: true };
    try {
      await driver.run(scope, retryQueuedLocalStarts);
      if (prior.error) throw prior.error;
      return prior.result ?? wait();
    } finally { scope.active = false; scope.run = null; scope.note = null; if (prior.result || prior.error) forget(); }
  }
  let first: EnsureResult;
  try { first = await run(); }
  catch (e) { if (!perDb.size) entries.delete(path); throw e; }
  if (first.kind !== "wait") { if (!perDb.size) entries.delete(path); return first; }
  const entry: Entry = {}; perDb.set(plan.taskId, entry);
  const io = { db: () => db, attempt: `author-${plan.taskId}`, manager: async (args: string[]) => {
    const current = driver.getStore();
    // Cancellation by a timer only drops in-memory state; a stale intent cannot authorize another ledger note.
    if (!current?.active || current.entry !== entry || !current.note) return { ok: true };
    return current.note(args.map((arg, n) => n === 3 ? arg.replace("Codex 排队", "本机执行者排队") : arg));
  } } as StepIO;
  const scope: Driver = { entry, run: null, note, active: true };
  try {
    await driver.run(scope, () => queueLocalStart(io, plan as StartPlan, { ...opts,
      queuedReady: async () => {
        const reason = queueRefusal(path, plan, opts);
        if (reason) { entry.result = { kind: "wait", reason }; forget(); }
        return reason;
      }, queuedNotice: async () => {},
    }, first.reason, () => retry(entry, plan)));
    return first;
  } catch (e) { forget(); throw e; }
  finally { scope.active = false; scope.note = null; }
}
