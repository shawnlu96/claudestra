/** LC1 owns the queue; only a scheduler ensure call with a fresh intent/lease may drive its deferred creation. */
import type { Database } from "bun:sqlite";
import type { StartPlan } from "./dag-tools-start.js";
import type { LocalAuthorPlan } from "./scheduler-local-author-plan.js";
import type { StepIO, StartOutcome } from "./dag-tools-steps.js";
import { queueLocalStart, retryQueuedLocalStarts } from "./scheduler-local-runtime-queue.js";
import type { LocalStartOptions } from "./scheduler-local-runtime-start.js";
import type { EnsureResult } from "./worker-session.js";

type Run = () => Promise<EnsureResult>;
interface Entry { run: Run | null; result?: EnsureResult; error?: Error; note: StepIO["manager"] | null }
// LedgerReader can reopen the connection between passes; LC1 also keys its callbacks by database filename.
const entries = new Map<string, Map<string, Entry>>();
const wait = (): EnsureResult => ({ kind: "wait", reason: "Codex 排队等槽，调度器下一轮自动重试" });

export async function queuedLocalAuthor(db: Database, plan: LocalAuthorPlan, opts: LocalStartOptions, note: StepIO["manager"], run: Run): Promise<EnsureResult> {
  const perDb = entries.get(db.filename) ?? new Map<string, Entry>(); entries.set(db.filename, perDb);
  const prior = perDb.get(plan.taskId);
  if (prior) {
    prior.run = run; prior.note = note;
    try {
      await retryQueuedLocalStarts();
      if (prior.error) throw prior.error;
      return prior.result ?? wait();
    } finally {
      prior.run = null; prior.note = null;
      if (prior.result || prior.error) { perDb.delete(plan.taskId); if (!perDb.size) entries.delete(db.filename); }
    }
  }
  const first = await run();
  if (first.kind !== "wait") { if (!perDb.size) entries.delete(db.filename); return first; }
  const entry: Entry = { run: null, note }; perDb.set(plan.taskId, entry);
  // queueLocalStart only consumes these IO fields when queuedReady is supplied; no start_node ledger steps run here.
  const io = { db: () => db, attempt: `author-${plan.taskId}`, manager: async (args: string[]) => {
    if (!entry.note) throw new Error("排队执行者没有本轮调度租约，不能写台账");
    return entry.note(args);
  } } as StepIO;
  try {
    await queueLocalStart(io, plan as StartPlan, { ...opts, queuedReady: async () => null, queuedNotice: async () => {} }, first.reason, async () => {
      if (!entry.run) return { kind: "wait", reason: "等持有租约的下一轮作者 ensure" };
      let result: EnsureResult;
      try { result = await entry.run(); }
      catch (e) {
        // LC1 removes failed callbacks; surface the failure and clear our matching receipt instead of waiting forever.
        entry.error = e instanceof Error ? e : new Error(String(e)); throw e;
      }
      if (result.kind === "wait") return result;
      entry.result = result;
      // Creation and its ledger assignment already carry the durable receipt; the queue adds no second write after it.
      return result.kind === "ready" ? { ok: true, taskId: plan.taskId, placement: "local", branch: plan.branch, steps: [], reconciled: [] }
        : { ok: false, code: "start_failed", error: result.reason, failedStep: "agent", rolledBack: [], leftovers: [] } as StartOutcome;
    });
    return first;
  } catch (e) { perDb.delete(plan.taskId); throw e; }
  finally { entry.note = null; }
}
