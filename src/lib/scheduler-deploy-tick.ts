/**
 * Scheduler side of automatic deploy (T68g). For a project with `deploy` in scheduler.json, a merge run that reached `merged`
 * is deployed through the journal in lib/scheduler-deploy.ts; afterwards the card, now live, gets `ledger verify`.
 * Rules this file keeps: submit only right after assertActive with a fresh drift check; leave `running` only on a checked
 * "job gone"; past the deadline a live job is booted out and judged on a later tick, never declared dead in the same breath.
 * Tests: tests/scheduler-deploy-tick.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { SchedulerConfig } from "./scheduler-config.js";
import { getMergeRun } from "./scheduler-merge.js";
import { deployDrift, deployInFlight, getDeployRun, inFlightDeploys, type DeployRun, type DeployStep } from "./scheduler-deploy.js";
import type { DeployJobs } from "./scheduler-deploy-job.js";
import { getMeta, getTask, getEventByDedup } from "./ledger-store.js";
import { rotateAfter, type TickPace } from "./scheduler-yield.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface DeployTickDeps { manager: Manager; jobs: DeployJobs; assertActive: () => void; now: () => number }

/** A daemon that just restarted can fail a probe for a moment; verify is retried this long before its failure is recorded. */
export const VERIFY_WINDOW_MS = 10 * 60_000;
const VERIFY_EVERY_MS = 60_000;
const lastVerify = new Map<string, number>();

const requireOk = (r: Record<string, unknown>, what: string): Record<string, unknown> => {
  if (r.ok !== true) throw new Error(`${what}: ${String(r.error ?? "manager failed")}`);
  return r;
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 450);

async function step(d: DeployTickDeps, run: DeployRun, s: Omit<DeployStep, "intentId" | "from" | "rev">): Promise<DeployRun> {
  const args = ["ledger", "scheduler-deploy-step", run.intentId, "--from", run.phase, "--to", s.to, "--rev", String(run.rev)];
  if (s.receipt) args.push("--receipt", oneLine(s.receipt));
  if (s.label) args.push("--label", s.label);
  if (s.outcome) args.push("--outcome", s.outcome);
  if (s.liveness) args.push("--liveness", s.liveness);
  return requireOk(await d.manager(...args), `deploy ${run.phase}→${s.to}`).run as DeployRun;
}

type Policy = SchedulerConfig["projects"][string];
type Where = { target: NonNullable<Policy["deploy"]>; repoDir: string };
const whereOf = (p: Policy | undefined): Where | null => (p?.deploy ? { target: p.deploy, repoDir: p.repoDir } : null);

/** claimed means no submit was ever attempted: the row goes to `running` under the fixed label before the job is bootstrapped,
 *  so a crash after that (or a lost job directory) is judged from `running`, never resubmitted. Without a deploy policy
 *  (taken out of the config after the claim) nothing is submitted. */
async function driveClaimed(d: DeployTickDeps, db: Database, run: DeployRun, where: Where | null): Promise<void> {
  const seen = await d.jobs.observe(run);
  if (seen) return void await step(d, run, { to: "running", label: seen.label, receipt: "占位下已有部署任务，按运行中接上" });
  const drift = where ? deployDrift(db, run.intentId) : "scheduler.json 里这个项目已不再自动部署";
  if (drift || !where) return void await step(d, run, { to: "unknown", outcome: "failed", liveness: "dead", receipt: `提交前流程已变，没提交：${drift}` });
  d.assertActive();
  const label = d.jobs.label(run);
  const attempt = await step(d, run, { to: "running", label, receipt: `提交部署任务 ${label}` });
  try {
    await d.jobs.submit(attempt, where.repoDir, where.target);
  } catch (e) {
    const after = await d.jobs.observe(attempt);
    if (after && (after.liveness !== "dead" || after.result)) return; // may have started after all: driveRunning judges it
    await step(d, attempt, { to: "unknown", outcome: "failed", liveness: "dead", receipt: `部署任务没起来：${(e as Error).message}` });
  }
}

async function driveRunning(d: DeployTickDeps, run: DeployRun): Promise<void> {
  const seen = await d.jobs.observe(run);
  if (!seen) {
    // The job directory is gone: only a booted-out label lets us say nothing can still be running from it.
    if (run.label && await d.jobs.remove(run.label)) await step(d, run, { to: "unknown", outcome: "unknown", liveness: "dead", receipt: "部署任务目录丢失，已卸下任务" });
    return;
  }
  if (seen.liveness !== "dead") {
    if (seen.liveness === "alive" && d.now() > seen.deadline) {
      d.assertActive();
      await d.jobs.remove(seen.label); // SIGTERM; its bounded children die with it. Judged dead on a later tick.
    }
    return;
  }
  if (seen.result?.ok) await step(d, run, { to: "deployed", outcome: "success", liveness: "dead", receipt: seen.result.summary || "部署完成" });
  else {
    await step(d, run, { to: "unknown", outcome: seen.result ? "failed" : "unknown", liveness: "dead",
      receipt: seen.result ? `部署失败：${seen.result.summary}` : seen.corrupt ?? "部署任务已结束但没有结果" });
  }
  await d.jobs.remove(seen.label); // unload the finished job; best effort, doctor lists leftovers
}

const verifyDedup = (run: DeployRun) => `deploy-verify:${run.intentId}`; // `scheduler:` keys are reserved for scheduler events (ledger-tx.ts)
/** Whether a verify try is due now: the card is live, not recorded yet, and its last try is older than VERIFY_EVERY_MS. */
function verifyDue(d: DeployTickDeps, db: Database, run: DeployRun): boolean {
  if (getTask(db, run.taskId)?.stage !== "live" || getEventByDedup(db, verifyDedup(run))) return false;
  const at = lastVerify.get(run.intentId);
  return at === undefined || d.now() - at >= VERIFY_EVERY_MS;
}

/** live card with a deployed journal: dry-run first; record only a pass, or the failure once the window is over. */
async function driveVerify(d: DeployTickDeps, db: Database, run: DeployRun): Promise<void> {
  const dedup = verifyDedup(run);
  if (!verifyDue(d, db, run)) return;
  lastVerify.set(run.intentId, d.now());
  const late = d.now() - (run.deployedAt ?? 0) > VERIFY_WINDOW_MS;
  if (!late) {
    const dry = await d.manager("ledger", "verify", run.taskId, "--dry-run");
    if (dry.ok !== true || dry.result !== "pass") return;
  }
  const r = await d.manager("ledger", "verify", run.taskId, "--dedup", dedup);
  if (r.code === "invalid" || r.code === "forbidden") throw new Error(`ledger verify ${run.taskId}: ${String(r.error)}`);
  lastVerify.delete(run.intentId);
}

/** One deploy card of a tick; `start` is null when there is nothing to start now, else the step (true = counted as handled). */
interface DeployCard { key: string; start(): (() => Promise<boolean>) | null }
const pad = (n: number | null | undefined, w: number) => String(n ?? 0).padStart(w, "0");

/** Every deploy card in the tick's fixed order; keys sort in that order. Lists are read lazily, so a deploy that ends early in
 *  the tick still gets its verify try in the same tick. */
function* deployCards(db: Database, config: SchedulerConfig, d: DeployTickDeps, pace?: TickPace): Generator<DeployCard> {
  // Claimed / running rows are driven from the journal alone, whatever the config or the merge intent says now: dropping
  // `deploy` (or the project) only stops new deploys, and such a row holds off updates until it is observed to an end.
  for (const run of inFlightDeploys(db)) {
    yield { key: `0/${pad(run.createdAt, 15)}/${run.intentId}`, start: () => pace?.skipTask?.(run.taskId) ? null : async () => {
      if (run.phase === "claimed") await driveClaimed(d, db, run, whereOf(config.projects[run.project]));
      else await driveRunning(d, run);
      return true;
    } };
  }
  for (const [k, [project, policy]] of Object.entries(config.projects).entries()) {
    if (!policy.deploy) continue;
    const intents = db.query(`SELECT id, eventSeq FROM scheduler_intents WHERE project=? AND action='merge' AND status='submitted' ORDER BY eventSeq, id`)
      .all(project) as { id: string; eventSeq: number }[];
    for (const { id, eventSeq } of intents) {
      // MTRBUD1: the pace is asked right before a card this loop starts, so a merge still in flight (the oldest is often a lender
      // at ready) or a frozen / blocked one cannot use up the phase's first card
      yield { key: `1/${pad(k, 4)}/0/${pad(eventSeq, 12)}/${id}`, start: () => {
        if (pace?.skipTask?.(getMergeRun(db, id)?.taskId ?? "") || getMergeRun(db, id)?.phase !== "merged" || getDeployRun(db, id)) return null; // an existing row is the journal's
        const drift = deployDrift(db, id);
        if (drift && getMeta(db, project).queueFrozen.frozen) return null; // frozen: wait for the PM, keep the merge slot
        if (!drift && deployInFlight(db)) return null;
        if (drift) return async () => {
          requireOk(await d.manager("ledger", "scheduler-settle", id, "--from", "submitted", "--to", "done", "--receipt",
            `merge:${getMergeRun(db, id)?.mergeSha}; 不自动部署（${drift}），待 PM 部署`), "settle undeployable merge");
          return false;
        };
        return async () => {
          const run = requireOk(await d.manager("ledger", "scheduler-deploy-begin", id), "begin deploy").run as DeployRun;
          await driveClaimed(d, db, run, whereOf(policy));
          return true;
        };
      } };
    }
    const deployed = db.query(`SELECT d.* FROM scheduler_deploys d JOIN tasks t ON t.id=d.taskId
      WHERE d.project=? AND d.phase='deployed' AND t.stage='live' ORDER BY d.deployedAt, d.intentId`).all(project) as DeployRun[];
    for (const run of deployed) {
      yield { key: `1/${pad(k, 4)}/1/${pad(run.deployedAt, 15)}/${run.intentId}`, start: () =>
        pace?.skipTask?.(run.taskId) || (pace && !verifyDue(d, db, run)) ? null : async () => { await driveVerify(d, db, run); return true; } }; // a try not due starts nothing
    }
  }
}

export async function deployTick(db: Database, config: SchedulerConfig, d: DeployTickDeps, pace?: TickPace): Promise<number> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return 0;
  let handled = 0;
  // MTRBUD1: a tick cut off by the pace resumes after its last card, so a running job that only waits (unreadable is never
  // dead) cannot take the phase's one card every pass from a due verify; a tick that got through every card starts in order
  const after = pace?.cursor.deploy;
  for (const card of after === undefined ? deployCards(db, config, d, pace) : rotateAfter([...deployCards(db, config, d, pace)], (c) => c.key, after)) {
    const run = card.start();
    if (!run) continue;
    if (pace?.yieldNow()) return handled;
    if (pace) pace.cursor.deploy = card.key;
    if (await run()) handled++;
  }
  if (pace) pace.cursor.deploy = undefined;
  return handled;
}
