/** Read adapter and durable PM receipts. Admission stays entirely in the existing MAINCIW gate and repair bindings. */
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEventByDedup, getMeta, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import { mainCiSha, type MainCiHealth } from "./scheduler-main-ci.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { mainCiApprovals } from "./scheduler-main-ci-wiring-store.js";
import type { runBounded } from "./run-bounded.js";

import { correlateMainFailure, planFailureResponse, failureResponseValue, type CorrelationInput, type FailureEvidence, type FailureRun,
  type Receipt } from "./ci-main-failure-response.js";
const { time, positive, token, same } = failureResponseValue;

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
interface ReadInput { project: string; health: MainCiHealth; currentMainSha: string | null; now: number }
interface ResponseRead extends ReadInput { evidence: FailureEvidence | null; mode: RecoveryMode; pm: string | null }
interface Ports { read?: (i: ReadInput) => Promise<CorrelationInput | null> }
let ports: Ports = {};
const correlationRetries = new Map<string, { next: number; failures: number }>();
export function setFailureResponsePortsForTest(p: Ports | null): void { ports = p ?? {}; correlationRetries.clear(); }

/** This bounded retry budget contains no health or admission fact. Missing proof retries slowly without starving MAINCIW's fresh reads. */
async function readEvidence(i: ReadInput, command: typeof runBounded, cwd?: string): Promise<FailureEvidence | null> {
  const key = JSON.stringify([i.project, i.health.target.repo.toLowerCase(), i.currentMainSha]);
  const prior = correlationRetries.get(key);
  if (prior && i.now < prior.next) return null;
  const failures = Math.min((prior?.failures ?? 0) + 1, 5), delay = Math.min(60_000 * 2 ** (failures - 1), 900_000);
  if (!prior && correlationRetries.size >= 128) correlationRetries.delete(correlationRetries.keys().next().value!);
  const budget = { next: i.now + delay, failures }, started = Date.now();
  correlationRetries.set(key, budget);
  try {
    const input = await (ports.read ? ports.read(i) : readCorrelation(i, command, cwd));
    return input ? correlateMainFailure(input) : null;
  } catch (e) {
    if (e instanceof SchedulerStopped) { correlationRetries.delete(key); throw e; }
    console.error(`⚠️ [main-ci-response] ${i.project} 关联读取失败，未归责：${(e as Error).message}`);
    return null;
  } finally { budget.next = i.now + Math.max(0, Date.now() - started) + delay; }
}

/** Guarded scheduler child writes the observation; the pass itself owns a query_only database. */
export async function readFailureResponse(db: Database, i: ReadInput, deps: { manager: Manager; command: typeof runBounded;
  policy: RecoveryPolicyPort; cwd?: string }): Promise<string> {
  const mode = deps.policy(i.project, "mainCiPause").mode;
  if (mode === "off") return "";
  if (i.health.state !== "red" || !i.health.reasons.some((r) => r.code === "unsuccessful_check") || !mainCiSha(i.currentMainSha) ||
    i.health.mainSha !== i.currentMainSha) return "";
  const prior = failureResponseStatus(db, i.project, i.currentMainSha);
  // A durable receipt preserves the first historical correlation, never a claim about today's attempt or a pause decision.
  const recorded = prior?.evidence;
  const evidence = recorded?.project === i.project && same(recorded.repo, i.health.target.repo) ? recorded :
    await readEvidence(i, deps.command, deps.cwd);
  if (!evidence) return "";
  const meta = getMeta(db, i.project), pm = meta.activePm ?? meta.pms.find((p) => p !== meta.team?.dispatcher) ?? null;
  if (!getEventByDedup(db, `${evidence.key}:${mode}`)) {
    const payload: ResponseRead = { ...i, mode, pm, evidence };
    const written = await deps.manager("ledger", "scheduler-main-ci", i.project, "--op", "response", "--response", JSON.stringify(payload));
    if (written.ok !== true) throw new Error(`主线故障回执写失败：${String(written.error)}`);
  }
  return ` 首次 related→full 关联（非因果）：head ${evidence.head.slice(0, 12)} base ${evidence.base.slice(0, 12)} tree ${evidence.tree.slice(0, 12)}；` +
    `run ${evidence.related.runId} → ${evidence.full.runId}；责任人 ${pm ?? "未配置当班 PM"}，30 分钟内回执；见 ci-main-failure-runbook。`;
}

/** Scheduler-only record. One receipt per failed integration SHA, sharing MAINCIW's notification claim rather than a new notice. */
export function recordFailureResponse(db: Database, ctx: WriteCtx, project: string, raw: string) {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "故障观察只由 scheduler 写");
  const r = JSON.parse(raw) as ResponseRead;
  if (r.project !== project || !r.health || r.health.target.project !== project || !time(r.now) || !["on", "observe"].includes(r.mode)) {
    throw new LedgerError("invalid", "故障观察字段无效");
  }
  if (!r.evidence) return { ok: true, recorded: false };
  const result = planFailureResponse({ mode: r.mode, evidence: r.evidence, pm: r.pm });
  const response = appendEvent(db, { ...ctx, dedupKey: `${r.evidence.key}:${r.mode}` }, { project, target: "", kind: "note",
    text: `${r.mode === "observe" ? "拟" : ""}暂停／通知，related→full 相关性不证明因果；责任人 ${r.pm ?? "未配置 PM"}`,
    data: { op: "main_ci_failure_response", evidence: r.evidence, mode: r.mode, ...result } });
  return { ok: true, recorded: !response.duplicate, key: r.evidence.key, receipt: result.receipt };
}

/** PM's choice is an audit receipt only. Repair admission stays MAINCIW's binding; revert is a human-reviewed ordinary git commit. */
function acknowledgeFailure(db: Database, ctx: WriteCtx, project: string, input: {
  key: string; deadline: number; choice: "repair" | "revert"; taskId?: string; head: string; reason: string;
}) {
  if (!actorMayConfigure(db, ctx.actor, project)) throw new LedgerError("forbidden", "只有当班 PM / master / owner 可回执");
  const event = getEventByDedup(db, `${input.key}:on`), evidence = event?.data.evidence as FailureEvidence | undefined;
  if (event?.project !== project || !evidence || !time(input.deadline) || input.deadline <= (ctx.now ?? Date.now()) ||
    !["repair", "revert"].includes(input.choice) || !mainCiSha(input.head) || !token(input.reason)) throw new LedgerError("invalid", "回执字段无效");
  if (input.choice === "revert" && !same(input.head, evidence.integrationSha)) throw new LedgerError("conflict", "revert 必须绑定失败 SHA");
  if (input.choice === "repair") {
    const task = getTask(db, input.taskId ?? "");
    const bindings = mainCiApprovals(db, project, evidence.repo);
    if (!task || task.project !== project || task.headSHA !== input.head || !bindings.some((a) => a.binding.taskId === task.id &&
      a.binding.head === input.head && a.binding.mainSha === evidence.integrationSha)) throw new LedgerError("conflict", "修复回执须先完成 MAINCIW 修复绑定");
  }
  return appendEvent(db, ctx, { project, target: "", kind: "decision", text: input.reason, data: {
    op: "main_ci_failure_ack", key: input.key, owner: ctx.actor, deadline: input.deadline, choice: input.choice,
    taskId: input.taskId ?? null, head: input.head, resume: "current-main-full-green", automaticGitWrite: false } });
}

type Obj = Record<string, any>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Read-only Actions adapter. The run's archived selection plan identifies checkout; commit API supplies its tree and parents. */
async function readCorrelation(i: ReadInput, command: typeof runBounded, cwd?: string): Promise<CorrelationInput | null> {
  const repo = i.health.target.repo, sha = i.currentMainSha;
  if (!mainCiSha(sha)) return null;
  const options = { cwd, timeoutMs: 30_000, env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" } };
  const api = async (path: string): Promise<any> => {
    const r = await command(["gh", "api", `repos/${repo}/${path}`], options);
    if (r.code !== 0 || r.timedOut) throw new Error(`GitHub 读取失败 (${r.code ?? "timeout"})`);
    return JSON.parse(r.stdout);
  };
  const list = async (path: string, field: string): Promise<Obj[]> => {
    const r = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100`);
    if (!object(r) || !positive(r.total_count) || !Array.isArray(r[field]) || r[field].length !== r.total_count || !r[field].every(object)) {
      throw new Error("Actions 列表不完整，不关联");
    }
    return r[field];
  };
  const commit = await api(`git/commits/${sha}`), pulls = await api(`commits/${sha}/pulls`);
  if (!object(commit) || commit.sha !== sha || !mainCiSha(commit.tree?.sha) || !Array.isArray(commit.parents) ||
    !commit.parents.length || !commit.parents.every((p: Obj) => mainCiSha(p.sha)) || !Array.isArray(pulls)) return null;
  const merged = pulls.filter((p: Obj) => p.merged_at && p.merge_commit_sha === sha && p.base?.repo?.full_name?.toLowerCase() === repo.toLowerCase());
  if (merged.length !== 1 || !mainCiSha(merged[0].head?.sha)) return null;
  const head = merged[0].head.sha, base = commit.parents[0].sha, tree = commit.tree.sha;
  const fullRuns = await list(`actions/runs?head_sha=${sha}&event=push`, "workflow_runs");
  const relatedRuns = await list(`actions/runs?head_sha=${head}&event=pull_request`, "workflow_runs");
  const eligible = (runs: Obj[], runHead: string) => runs.filter((r) => r.path === ".github/workflows/ci.yml" && r.head_sha === runHead &&
    r.repository?.full_name?.toLowerCase() === repo.toLowerCase()).sort((a, b) => b.id - a.id);
  const latestFull = eligible(fullRuns, sha)[0], latestRelated = eligible(relatedRuns, head)[0];
  if (!latestFull || !latestRelated) return null;
  const full = await loadFailureRun(api, command, options, repo, latestFull, { head, base, tree }, "full");
  const related = await loadFailureRun(api, command, options, repo, latestRelated, { head, base, tree }, "related");
  if (!full || !related) return null;
  const current = await api("git/ref/heads/main");
  if (current.ref !== "refs/heads/main" || current.object?.sha !== sha) return null;
  return { project: i.project, repo, mainSha: sha, now: i.now, requiredChecks: i.health.target.requiredChecks, related, full,
    integration: { origin: "github-api", head, base, sha, tree, parents: commit.parents.map((p: Obj) => p.sha), mergedHead: head } };
}

async function loadFailureRun(api: (path: string) => Promise<any>, command: typeof runBounded,
  options: Parameters<typeof runBounded>[1], repo: string, listed: Obj, subject: { head: string; base: string; tree: string },
  scope: "related" | "full"): Promise<FailureRun | null> {
  if (!positive(listed.id)) return null;
  const run = await api(`actions/runs/${listed.id}`);
  if (run.id !== listed.id || run.head_sha !== listed.head_sha || run.status !== "completed" || !positive(run.run_attempt) ||
    run.repository?.full_name?.toLowerCase() !== repo.toLowerCase() || run.path !== ".github/workflows/ci.yml") return null;
  const jobs = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  if (!Array.isArray(jobs.jobs) || jobs.jobs.length !== jobs.total_count || !jobs.jobs.length ||
    jobs.jobs.some((j: Obj) => j.status !== "completed" || typeof j.name !== "string" || j.run_attempt !== run.run_attempt)) return null;
  if (!jobs.jobs.some((j: Obj) => j.name === `ci scope ${scope}` && j.conclusion === "success") ||
    jobs.jobs.some((j: Obj) => j.name.startsWith("ci scope ") && j.name !== `ci scope ${scope}`)) return null;
  const dir = mkdtempSync(join(tmpdir(), "ci-main-response-"));
  try {
    const artifacts = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
    if (!Array.isArray(artifacts.artifacts) || artifacts.artifacts.length !== artifacts.total_count) return null;
    const plans = artifacts.artifacts.filter((a: Obj) => a.name === "ci-related-plan" && a.expired === false && a.workflow_run?.id === run.id &&
      a.workflow_run?.head_sha === run.head_sha);
    if (plans.length !== 1) return null;
    const r = await command(["gh", "run", "download", String(run.id), "--repo", repo, "--name", "ci-related-plan", "--dir", dir], options);
    if (r.code !== 0 || r.timedOut) return null;
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as Obj;
    if (plan.version !== 1 || plan.scope !== scope || plan.event !== run.event || !mainCiSha(plan.sha)) return null;
    const checked = await api(`git/commits/${plan.sha}`);
    if (checked.sha !== plan.sha || checked.tree?.sha !== subject.tree || !Array.isArray(checked.parents) ||
      checked.parents[0]?.sha !== subject.base || (scope === "related" && (checked.parents.length !== 2 || checked.parents[1]?.sha !== subject.head)) ||
      (scope === "full" && plan.sha !== run.head_sha)) return null;
    const after = await api(`actions/runs/${run.id}`);
    if (after.run_attempt !== run.run_attempt || after.status !== "completed" || after.conclusion !== run.conclusion) return null;
    const completedAt = Math.max(...jobs.jobs.map((j: Obj) => Date.parse(j.completed_at)));
    if (!time(completedAt)) return null;
    return { origin: "actions-api", repo, runId: run.id, attempt: run.run_attempt, latestAttempt: after.run_attempt,
      event: run.event, scope, workflow: run.path, ...subject, checkout: plan.sha, completedAt, conclusion: run.conclusion,
      checks: jobs.jobs.map((j: Obj) => ({ name: j.name, conclusion: j.conclusion })) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Status presents the latest PM acknowledgement alongside the immutable first-discovery receipt. */
export function failureResponseStatus(db: Database, project: string, sha: string | null) {
  const rows = db.query(`SELECT seq, data FROM events WHERE project=? AND json_extract(data,'$.op')='main_ci_failure_response'
    AND json_extract(data,'$.evidence.integrationSha')=? ORDER BY seq DESC LIMIT 1`).get(project, sha) as { seq: number; data: string } | null;
  if (!rows) return null;
  const response = JSON.parse(rows.data) as { evidence: FailureEvidence; receipt: Receipt | null; mode: RecoveryMode };
  const ack = db.query(`SELECT data FROM events WHERE project=? AND kind='decision' AND json_extract(data,'$.op')='main_ci_failure_ack'
    AND json_extract(data,'$.key')=? ORDER BY seq DESC LIMIT 1`).get(project, response.evidence.key) as { data: string } | null;
  return { seq: rows.seq, ...response, acknowledgement: ack ? JSON.parse(ack.data) : null };
}

/** CLI parsing is kept out of the thin MAINCIW command map; only an acknowledgement audit is written. */
export function failureResponseAckCommand(db: Database, ctx: WriteCtx, project: string, flags: Record<string, string | undefined>) {
  return { ok: true, event: acknowledgeFailure(db, ctx, project, { key: flags.key ?? "", deadline: Number(flags.deadline),
    choice: flags.choice as "repair" | "revert", taskId: flags.task, head: (flags.head ?? "").toLowerCase(), reason: flags.reason ?? "" }).event.seq };
}
