/** Full reruns start before merge driving, including cards waiting without the merge slot. Claims survive daemon restarts. */
import type { Database } from "bun:sqlite";
import { CI_SCOPE_LIGHT, CI_SCOPE_FULL, lightOnly } from "./ci-queue-full.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { observeDedupKey, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { mainCiGateOf, decide } from "./scheduler-main-ci-wiring-gate.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { mergeFirst } from "./scheduler-merge-order.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { runBounded } from "./run-bounded.js";
import type { TickPace } from "./scheduler-yield.js";

interface QueueFullIo {
  manager: (...args: string[]) => Promise<Record<string, unknown>>;
  external: (project: SchedulerConfig["projects"][string]) => MergeExternal;
  command: typeof runBounded;
  active: () => void;
  policy?: RecoveryPolicyPort;
  pace?: TickPace;
  now?: () => number;
}
const KEY = "ciQueueFull";
const readTimes = new WeakMap<Database, Map<string, number>>();
const RETRY_MS = 10 * 60_000;
const modeOf = (io: QueueFullIo, project: string): RecoveryMode => {
  try { const p = (io.policy ?? recoveryPolicy)(project, KEY); return p.source === "error" ? "off" : p.mode; }
  catch (e) { console.error(`ciQueueFull policy: ${String(e)}`); return "off"; } // unreadable policy cannot authorize a rerun
};

export async function ciQueueFullStep(db: Database, config: SchedulerConfig, io: QueueFullIo): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [], now = (io.now ?? Date.now)();
  let times = readTimes.get(db);
  if (!times) readTimes.set(db, times = new Map());
  const cards = mergeFirst(db, db.query("SELECT id AS taskId FROM tasks WHERE stage='merge' AND pr IS NOT NULL AND headSHA IS NOT NULL ORDER BY id")
    .all() as { taskId: string }[]);
  let reads = 0;
  for (const { taskId } of cards) {
    const task = getTask(db, taskId), cfg = task && config.projects[task.project];
    if (!task || !cfg || cfg.mergeHandoff || !task.headSHA || !task.pr || io.pace?.skipTask?.(taskId)) continue;
    const mode = modeOf(io, task.project), readKey = `${taskId}@${task.headSHA}`;
    if (mode === "off" || now - (times.get(readKey) ?? -Infinity) < 60_000) continue;
    if (reads >= 4 || io.pace?.yieldNow()) break;
    reads++;
    if (times.size >= 1000) times.clear();
    times.set(readKey, now);
    try {
      io.active();
      const pr = await io.external(cfg).inspect(task.pr);
      io.active();
      if (!current(db, task) || pr.head.toLowerCase() !== task.headSHA.toLowerCase()) continue;
      if (mode === "observe" && lightOnly(pr.checks)) await note(io, task, `disabled:${task.headSHA.slice(0, 12)}`,
        "ciQueueFull 不是 on，不会自动补跑，卡会一直等", { head: task.headSHA });
      const run = eligible(task, pr, cfg.requiredChecks);
      if (!run || !current(db, task)) continue;
      await request(db, task, run, mode, io, now);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ taskId, error: String(e).replace(/\s+/g, " ").slice(0, 300) });
    }
  }
  return failed;
}

function current(db: Database, t: LedgerTask): boolean {
  const live = getTask(db, t.id), gate = mainCiGateOf(db);
  return live?.stage === "merge" && live.headSHA === t.headSHA && live.pr === t.pr
    && (!gate || decide(gate, t.project, t.id, t.headSHA!) === "go");
}

function eligible(task: LedgerTask, pr: PrSnapshot, required: readonly string[]): { repo: string; runId: string } | null {
  if (pr.state !== "OPEN" || pr.draft || pr.crossRepository || pr.base !== "main" || pr.head.toLowerCase() !== task.headSHA!.toLowerCase()) return null;
  if (!required.length || pr.checks.some((c) => ["fail", "cancel", "pending"].includes(c.bucket) || c.name === CI_SCOPE_FULL)) return null;
  if (!required.every((name) => pr.checks.some((c) => c.name === name && c.bucket === "pass"))) return null;
  const light = pr.checks.find((c) => c.name === CI_SCOPE_LIGHT && c.bucket === "pass");
  const link = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/\S*)?$/.exec(light?.link ?? "");
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(task.pr!)?.[1];
  return link && repo && link[1]!.toLowerCase() === repo.toLowerCase() ? { repo, runId: link[2]! } : null;
}

async function note(io: QueueFullIo, task: LedgerTask, key: string, action: string, data: Record<string, unknown>): Promise<boolean> {
  const r = await io.manager("ledger", "scheduler-recovery-observe", task.id, "--mechanism", KEY,
    "--action-key", key, "--action", action, "--data", JSON.stringify(data));
  if (r.ok !== true) throw new Error(`ciQueueFull record: ${String(r.error ?? "manager failed")}`);
  return r.recorded === true;
}

async function request(db: Database, task: LedgerTask, run: { repo: string; runId: string }, mode: RecoveryMode, io: QueueFullIo, now: number): Promise<void> {
  const head = task.headSHA!, key = `rerun:${task.id}@${head.slice(0, 12)}:${run.runId}`;
  const seen = (actionKey: string) => getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: KEY, target: task.id, actionKey }));
  const data = { head, runId: run.runId, repo: run.repo };
  if (mode === "observe") {
    await note(io, task, `observe:${head.slice(0, 12)}:${run.runId}`, `本会重跑 ${run.runId}`, data);
    return;
  }
  const first = seen(key), retry = seen(`${key}:retry`);
  if (first && now - (retry ?? first).ts < RETRY_MS) return;
  if (retry) { await note(io, task, `${key}:stalled`, "全量补跑没起来，请 PM 核对 Actions 后整次重跑", data); return; }
  // Claim before the external call: a crash or an ambiguous gh result waits ten minutes, never sends a duplicate immediately.
  const claimed = await note(io, task, first ? `${key}:retry` : key, `重跑 ${run.runId}${first ? "（第二次）" : ""}`, { ...data, attempt: first ? 2 : 1 });
  io.active();
  if (!claimed || !current(db, task) || modeOf(io, task.project) !== "on") return;
  const r = await io.command(["gh", "run", "rerun", run.runId, "--repo", run.repo], { timeoutMs: 30_000 });
  io.active();
  if (r.code !== 0 || r.timedOut) throw new Error(`ciQueueFull rerun ${run.runId}: ${r.stderr.trim().slice(0, 200) || r.code}`);
}
