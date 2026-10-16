/**
 * Full reruns start before merge driving, including cards waiting without the merge slot. Claims survive daemon restarts.
 * Fairness (CIQFAIR1): the slot holder waiting on CI is read first; a card whose PR settled ineligible (full marker, no light,
 * red, not an open main PR) is not read again for ten minutes at the same head, and a card inside its rerun window is not read,
 * so neither spends one of the four reads a pass may make. All of this applies in on mode only; observe reads as before.
 */
import type { Database } from "bun:sqlite";
import { CI_SCOPE_LIGHT, CI_SCOPE_FULL, lightOnly } from "./ci-queue-full.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { observeDedupKey, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { prMergeOff, type SchedulerConfig } from "./scheduler-config.js";
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
/** `card@head` → when it was judged settled-ineligible; process-local, a restart only costs a few extra reads. */
const judgedTimes = new WeakMap<Database, Map<string, number>>();
const RETRY_MS = 10 * 60_000, JUDGED_MS = 10 * 60_000;
const modeOf = (io: QueueFullIo, project: string): RecoveryMode => {
  try { const p = (io.policy ?? recoveryPolicy)(project, KEY); return p.source === "error" ? "off" : p.mode; }
  catch (e) { console.error(`ciQueueFull policy: ${String(e)}`); return "off"; } // unreadable policy cannot authorize a rerun
};

export async function ciQueueFullStep(db: Database, config: SchedulerConfig, io: QueueFullIo): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [], now = (io.now ?? Date.now)();
  let times = readTimes.get(db), judged = judgedTimes.get(db);
  if (!times) readTimes.set(db, times = new Map());
  if (!judged) judgedTimes.set(db, judged = new Map());
  const holders = slotHolders(db, io);
  const cards = mergeFirst(db, db.query("SELECT id AS taskId FROM tasks WHERE stage='merge' AND pr IS NOT NULL AND headSHA IS NOT NULL ORDER BY id")
    .all() as { taskId: string }[]);
  cards.sort((a, b) => Number(holders.has(b.taskId)) - Number(holders.has(a.taskId))); // stable: holders first, mergeFirst otherwise
  let reads = 0;
  for (const { taskId } of cards) {
    const task = getTask(db, taskId), cfg = task && config.projects[task.project];
    if (!task || !cfg || prMergeOff(cfg) || !task.headSHA || !task.pr || io.pace?.skipTask?.(taskId)) continue;
    const mode = modeOf(io, task.project), readKey = `${taskId}@${task.headSHA}`;
    if (mode === "off" || now - (times.get(readKey) ?? -Infinity) < 60_000) continue;
    // The holder is always re-read (a manual rerun may have turned it green); the judged cache only ever skips an inspect.
    if (mode === "on" && !holders.has(taskId) && now - (judged.get(readKey) ?? -Infinity) < JUDGED_MS) continue;
    if (mode === "on" && rerunWithin(db, task, now)) continue;
    if (reads >= 4 || io.pace?.yieldNow()) break;
    reads++;
    if (times.size >= 1000) times.clear();
    if (judged.size >= 1000) judged.clear();
    times.set(readKey, now);
    try {
      io.active();
      const pr = await io.external(cfg).inspect(task.pr);
      io.active();
      if (!current(db, task) || pr.head.toLowerCase() !== task.headSHA.toLowerCase()) continue;
      if (mode === "observe" && lightOnly(pr.checks)) await note(io, task, `disabled:${task.headSHA.slice(0, 12)}`,
        "ciQueueFull 不是 on，不会自动补跑，卡会一直等", { head: task.headSHA });
      const run = eligible(task, pr, cfg.requiredChecks);
      if (mode === "on" && !run && settled(pr)) judged.set(readKey, now);
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

/** Cards holding their on-mode project's merge slot while the merge journal waits on CI. */
function slotHolders(db: Database, io: QueueFullIo): Set<string> {
  const rows = db.query(`SELECT r.taskId, r.project FROM scheduler_resources r JOIN scheduler_merges m ON m.intentId = r.intentId
    WHERE r.resource = 'merge:' || r.project AND m.project = r.project AND m.phase = 'await_ci'`).all() as { taskId: string; project: string }[];
  return new Set(rows.filter((r) => modeOf(io, r.project) === "on").map((r) => r.taskId));
}

/** A PR whose ineligibility will not change without a new head or a human: anything still pending (or nothing reported yet) is not. */
function settled(pr: PrSnapshot): boolean {
  if (pr.state !== "OPEN" || pr.draft || pr.crossRepository || pr.base !== "main") return true;
  if (pr.checks.some((c) => c.name === CI_SCOPE_FULL || c.bucket === "fail" || c.bucket === "cancel")) return true;
  if (!pr.checks.length || pr.checks.some((c) => c.bucket === "pending")) return false;
  return !pr.checks.some((c) => c.name === CI_SCOPE_LIGHT);
}

/** A rerun (or its retry) claimed for this head inside RETRY_MS: request() would do nothing, so the PR is not read. */
function rerunWithin(db: Database, task: LedgerTask, now: number): boolean {
  const prefix = `rerun:${task.id}@${task.headSHA!.slice(0, 12)}:`;
  const rows = db.query(`SELECT ts, json_extract(data, '$.actionKey') AS actionKey FROM events WHERE target = ? AND project = ? AND kind = 'note'
    AND json_extract(data, '$.op') = 'recovery_observe' AND json_extract(data, '$.mechanism') = ? AND ts > ?`)
    .all(task.id, task.project, KEY, now - RETRY_MS) as { ts: number; actionKey: string | null }[];
  return rows.some((r) => !!r.actionKey?.startsWith(prefix) && !r.actionKey.endsWith(":stalled"));
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
