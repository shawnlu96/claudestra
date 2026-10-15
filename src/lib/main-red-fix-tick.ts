/**
 * main-red-fix's scheduler side, one of the autostart tick's pmWakeTicks: per project at most one GitHub round every
 * MAIN_RED_READ_EVERY_MS, whether or not anything wants to merge. Reads (gh, the query_only ledger) and the rerun call happen here;
 * every ledger write goes through `ledger scheduler-main-red-fix` (lease-guarded env.ledger). mainRedFix off = no read at all.
 * A run counts once (handled per run id + attempt); a lost lease stops the tick, any other error only lands in this round's failed.
 * tests/main-red-fix-tick.test.ts.
 */
import { existsSync } from "node:fs";
import { classifyFailedLog, type FailureClass } from "./ci-failure-class.js";
import { activeKnownFlaky } from "./ci-known-flaky.js";
import { prCoordinates } from "./card-repo.js";
import { realScrub } from "./dag-write-scrub.js";
import { getEventByDedup, getTask, listTasks } from "./ledger-store.js";
import { firstRedSha, greenBefore, handledKey, knownFlakyOnly, latestDecided, logPaths, MAIN_RED_READ_EVERY_MS, MAIN_RED_WORKFLOWS, rerunKey, snippetOf, todoKey,
  type MainRedFacts, type MainRedRun } from "./main-red-fix.js";
import { mainRedGh, type MainRedGh } from "./main-red-fix-gh.js";
import { mainRedNodes, nodeState, placeFix } from "./main-red-fix-place.js";
import { statePath } from "./paths.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { projectRepo } from "./scheduler-foreign-repo.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MainCiHealth } from "./scheduler-main-ci.js";
import { mainCiFaultKey } from "./scheduler-main-ci-plan.js";
import { readMainCiNow } from "./scheduler-main-ci-wiring-gh.js";
import { mainCiApprovals, REVOKE_OP } from "./scheduler-main-ci-wiring-store.js";
import { cutFailedJobLog } from "./scheduler-merge-ci-log-cut.js";
import { parseFailedLog } from "./scheduler-merge-ci-rerun-log.js";
import type { SpecWaitEnv } from "./scheduler-spec-wait.js";
import { isTestProcess } from "./test-guard.js";

type Failed = { taskId: string; error: string }[];
type Workflow = (typeof MAIN_RED_WORKFLOWS)[number];
/** Tests only: a fake gh, config, policy and main health read (production: scheduler.json, recovery-policy.json, the MAINCIW read). */
interface TickPorts { gh?: (cwd?: string) => MainRedGh; config?: () => SchedulerConfig; policy?: RecoveryPolicyPort; ledgerDir?: string;
  health?: (project: string, repo: string, requiredChecks: readonly string[]) => Promise<MainCiHealth | null> }
let ports: TickPorts = {};
const lastRead = new Map<string, number>();
export function setMainRedFixTickForTest(p: TickPorts | null): void { ports = p ?? {}; lastRead.clear(); }

interface Round { env: SpecWaitEnv; project: string; repo: string; gh: MainRedGh; mode: "on" | "observe"; health: () => Promise<MainCiHealth | null> }

async function cli(r: Round, op: string, facts: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await r.env.ledger("ledger", "scheduler-main-red-fix", r.project, "--op", op, "--facts", JSON.stringify(facts));
  if (res.code === "lease-lost") throw new SchedulerStopped(`ledger scheduler-main-red-fix: ${String(res.error)}`);
  if (res.ok !== true) throw new Error(`scheduler-main-red-fix ${op}：${String(res.error ?? res.code)}`);
  return res;
}

/** The card whose merged PR is the first red commit (push only); null when GitHub or the ledger cannot say. */
async function responsible(r: Round, runs: readonly MainRedRun[], red: MainRedRun): Promise<string | null> {
  const prs = new Set(await r.gh.commitPulls(r.repo, firstRedSha(runs, red)));
  const hit = listTasks(r.env.db, r.project).find((t) => {
    const c = prCoordinates(t.pr);
    return !!c && c.repo.toLowerCase() === r.repo.toLowerCase() && prs.has(c.pr);
  });
  return hit?.id ?? null;
}

const observed = (r: Round, w: Workflow, sha: string, action: string) =>
  !!getEventByDedup(r.env.db, observeDedupKey({ project: r.project, mechanism: "mainRedFix", target: "", actionKey: `main-red:${w.id}:${sha}:${action}` }));

/** Observe: what on would write, from the same placement the writer uses (identity-only scrub, no git). */
async function observeNode(r: Round, w: Workflow, facts: MainRedFacts): Promise<void> {
  const scrub = await realScrub([]);
  const p = placeFix(r.env.db, r.project, facts, { ledgerDir: ports.ledgerDir ?? statePath("ledger"), exists: existsSync,
    scrub: { ...scrub, commits: new Set([facts.mainSha]) } });
  const text = p.placed ? `写修复节点 ${p.placed.f.id}/${p.placed.key}（${w.label} run ${facts.runId}）` : `记待办，不写节点：${p.misses.join("；")}`.slice(0, 400);
  await cli(r, "observe", { workflow: w.id, mainSha: facts.mainSha, action: "node", text });
}

async function judge(r: Round, w: Workflow, runs: readonly MainRedRun[], red: MainRedRun, rerunSpent: boolean): Promise<void> {
  const db = r.env.db;
  // observe has no rerun to wait for: one would-be action per main SHA + workflow, then this red is not read again
  if (r.mode === "observe" && (observed(r, w, red.headSha, "node") || observed(r, w, red.headSha, "rerun"))) return;
  const checks = await r.gh.failedJobs(r.repo, red.id, red.attempt);
  const log = await r.gh.failedLog(r.repo, red.id, red.attempt);
  const cls: FailureClass = log === null ? { kind: "unknown", why: "失败日志太长" } : classifyFailedLog(log, new Set());
  const failures = (log && parseFailedLog(log)) || [];
  // no bun test failed (a type error, a guard, an install fault): the files the log names, or none (the writer then scopes otherwise)
  const files = failures.length ? [...new Set(failures.map((f) => f.file))].sort().slice(0, 50) : log ? logPaths(log) : [];
  const facts: MainRedFacts = { workflow: w.id, runId: red.id, attempt: red.attempt, mainSha: red.headSha, url: red.url, checks: checks.slice(0, 50),
    cases: [...new Set(failures.map((f) => `${f.file} > ${f.name}`))].slice(0, 50), files,
    snippet: log ? snippetOf(cutFailedJobLog(log)) : [], responsibleTask: null, faultKey: null, rerun: rerunSpent, greenBefore: greenBefore(runs, red) };
  if (!rerunSpent && knownFlakyOnly(cls, new Set(activeKnownFlaky(db, r.project).keys()))) {
    if (r.mode === "observe") {
      await cli(r, "observe", { workflow: w.id, mainSha: red.headSha, action: "rerun", text: `重跑 ${w.label} 失败的 job（run ${red.id}）` });
      return;
    }
    if ((await cli(r, "rerun-claim", { ...facts })).claimed !== true) return;
    try { await r.gh.rerunFailed(r.repo, red.id); return; }
    catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      await cli(r, "rerun-result", { workflow: w.id, runId: red.id, url: red.url, green: false }); // spent: the red is written as a fix below
    }
  }
  if (w.id === "push") {
    facts.responsibleTask = await responsible(r, runs, red);
    const h = await r.health();
    facts.faultKey = h && h.mainSha?.toLowerCase() === red.headSha ? mainCiFaultKey(h) : null;
  }
  if (r.mode === "observe") return observeNode(r, w, facts);
  const res = await cli(r, "fix", { ...facts });
  if (typeof res.notify === "string" && res.notify) await r.env.notifyPm(r.project, res.notify);
}

async function oneWorkflow(r: Round, w: Workflow): Promise<void> {
  const db = r.env.db, runs = await r.gh.runs(r.repo, w.file, w.event), latest = latestDecided(runs);
  if (!latest) return;
  const claim = getEventByDedup(db, rerunKey(r.project, latest.id)), claimedAt = Number(claim?.data.attempt ?? 0);
  if (latest.conclusion === "success") {
    if (claim && r.mode === "on" && latest.attempt > claimedAt && !getEventByDedup(db, todoKey(r.project, latest.id, "rerun-green"))) {
      await cli(r, "rerun-result", { workflow: w.id, runId: latest.id, url: latest.url, green: true });
    }
    return;
  }
  if (getEventByDedup(db, handledKey(r.project, latest.id, latest.attempt))) return;
  // the attempt that was re-run: wait for the new attempt, unless the rerun call itself failed (then it is written now)
  const failedRerun = !!getEventByDedup(db, todoKey(r.project, latest.id, "rerun-failed"));
  if (claim && latest.attempt <= claimedAt && !failedRerun) return;
  await judge(r, w, runs, latest, !!claim);
}

/** mainRedRepairBind: this mechanism's cards at merge whose main is still the fault they were written for; the CLI decides on / observe. */
async function bindPass(r: Round, policy: RecoveryPolicyPort): Promise<void> {
  const bindMode = policy(r.project, "mainRedRepairBind").mode;
  if (bindMode === "off") return;
  const db = r.env.db, approvals = mainCiApprovals(db, r.project, r.repo);
  for (const n of mainRedNodes(db, r.project).filter((x) => x.workflow === "push" && x.faultKey)) {
    const taskId = nodeState(db, n).node?.taskId, t = taskId ? getTask(db, taskId) : null;
    if (!t || t.stage !== "merge" || !t.headSHA || approvals.some((a) => a.binding.taskId === t.id && a.binding.head === t.headSHA!.toLowerCase())) continue;
    if (db.query(`SELECT 1 FROM events WHERE project = ? AND target = ? AND kind = 'decision' AND json_extract(data, '$.op') = ? LIMIT 1`)
      .get(r.project, t.id, REVOKE_OP)) continue;
    const h = await r.health(), faultKey = h ? mainCiFaultKey(h) : null;
    if (!h?.mainSha || faultKey !== n.faultKey) continue;
    // the would-bind note only dedups observe; on goes by the real binding above, so an observed card is bound once on is set
    if (bindMode === "observe" && getEventByDedup(db, observeDedupKey({ project: r.project, mechanism: "mainRedRepairBind", target: t.id,
      actionKey: `main-red:push:${h.mainSha}:bind` }))) continue;
    await cli(r, "bind", { taskId: t.id, head: t.headSHA.toLowerCase(), mainSha: h.mainSha.toLowerCase(), faultKey });
  }
}

async function liveHealth(project: string, repo: string, requiredChecks: readonly string[], cwd: string | undefined): Promise<MainCiHealth | null> {
  try { return (await readMainCiNow({ project, repo, requiredChecks: [...requiredChecks] }, runBounded, cwd, Date.now)).health; }
  catch (e) { console.error(`⚠️ [main-red-fix] ${project} main 健康读不到，不算 faultKey：${(e as Error).message}`); return null; }
}

export async function mainRedFixTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [], policy = ports.policy ?? recoveryPolicy;
  if (isTestProcess() && !ports.gh) return failed; // never a real gh from a test process
  for (const project of [...env.svc.projects].sort()) {
    try {
      const mode = policy(project, "mainRedFix").mode, now = env.now();
      if (mode === "off" || now - (lastRead.get(project) ?? -Infinity) < MAIN_RED_READ_EVERY_MS) continue;
      const cfg = (ports.config ?? readSchedulerConfig)().projects[project], repo = cfg ? projectRepo(cfg) : null;
      if (!cfg || !repo) continue;
      lastRead.set(project, now);
      let health: Promise<MainCiHealth | null> | undefined;
      const r: Round = { env, project, repo, mode, gh: (ports.gh ?? ((cwd) => mainRedGh(runBounded, cwd)))(cfg.repoDir),
        health: () => health ??= (ports.health ? ports.health(project, repo, cfg.requiredChecks) : liveHealth(project, repo, cfg.requiredChecks, cfg.repoDir)) };
      for (const w of MAIN_RED_WORKFLOWS) {
        try { await oneWorkflow(r, w); }
        catch (e) { if (e instanceof SchedulerStopped) throw e; failed.push({ taskId: `main-red-fix:${project}:${w.id}`, error: (e as Error).message }); }
      }
      await bindPass(r, policy);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ taskId: `main-red-fix:${project}`, error: (e as Error).message });
    }
  }
  return failed;
}
