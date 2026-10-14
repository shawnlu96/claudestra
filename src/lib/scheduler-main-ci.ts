import { parseRequiredChecks } from "./scheduler-config.js";
import { REPO_RE } from "./lend-config.js";
import type { TrainCheck } from "./scheduler-merge-train.js";

export interface MainCiTarget { project: string; repo: string; requiredChecks: readonly string[] }
type MainCiState = "green" | "red" | "unknown";
interface MainCiReason {
  code: "healthy" | "invalid_target" | "read_error" | "invalid_main" | "scope_mismatch" | "main_changed" |
    "invalid_checks" | "stale_checks" | "missing_check" | "ambiguous_check" | "pending_check" | "unsuccessful_check" | "invalid_observation";
  check?: string;
  conclusion?: string;
  phase?: "main_before" | "checks" | "main_after";
}
export interface MainCiHealth {
  target: MainCiTarget;
  mainSha: string | null;
  /** Start of this observation, not completion time: slow reads must not refresh old evidence. */
  observedAt: number;
  state: MainCiState;
  reasons: readonly MainCiReason[];
  /** Reuses the train's presentation type; only check-run completed/success or commit-status success maps to pass. */
  checks: readonly TrainCheck[];
  /**
   * MAINCIW2's run-aware verdict for the same evidence (state / reasons above keep the original MAINCI meaning). Present only when
   * the checks envelope carried the current SHA's push runs; planMainCi uses it only under rule "run" (mainCiPause=on).
   */
  ci?: MainCiRunVerdict;
}
/** One GitHub Actions workflow run of the current main SHA, as listed (the API lists each run's latest attempt). */
interface MainCiPushRun { id: number; attempt: number; status: string; conclusion: string | null; createdAt: number }
interface MainCiRunVerdict {
  /** pending = the push run is still going and nothing failed; evidence_missing = a conservative pause; unhealthy = the original pause (a failed check, a read / evidence fault). */
  verdict: "green" | "pending" | "evidence_missing" | "unhealthy";
  why: "healthy" | "run_active" | "run_not_created_yet" | "run_not_created" | "run_overdue" | "run_completed_checks_missing" | "run_cancelled" |
    "check_failed" | "other_fault" | "runs_unreadable" | "commit_time_unavailable";
  runs: readonly MainCiPushRun[];
}
/** Repo/project come from the adapter's trusted routing, never from a task title or a cached PR head. */
export interface MainCiReadPort {
  main(target: MainCiTarget): Promise<unknown>;
  checks(target: MainCiTarget, sha: string): Promise<unknown>;
}
export interface MainCiSnapshot { before: unknown; checks: unknown; after: unknown; observedAt: number }
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
export const mainCiSha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);
export const mainCiTargetValid = (t: MainCiTarget): boolean => obj(t) && typeof t.project === "string" && /^[\w.-]{1,80}$/.test(t.project) &&
  typeof t.repo === "string" && REPO_RE.test(t.repo) && parseRequiredChecks(t.requiredChecks) !== null;
const sameRepo = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const scoped = (r: Obj, t: MainCiTarget) => r.project === t.project && sameRepo(r.repo, t.repo);
const validMain = (r: unknown): r is Obj & { sha: string } => obj(r) && r.ref === "refs/heads/main" && mainCiSha(r.sha);
const copyTarget = (target: MainCiTarget): MainCiTarget =>
  ({ ...target, requiredChecks: Array.isArray(target?.requiredChecks) ? [...target.requiredChecks] : [] });
const health = (target: MainCiTarget, observedAt: number, mainSha: string | null, state: MainCiState,
  reasons: MainCiReason[], checks: TrainCheck[] = []): MainCiHealth => ({ target: copyTarget(target), observedAt, mainSha, state, reasons, checks });
/** A push run that has not been created this long after the commit, or runs this long, is an evidence fault, not waiting. */
export const MAIN_CI_RUN_CREATE_MS = 15 * 60_000, MAIN_CI_RUN_MAX_MS = 60 * 60_000;

/**
 * Snapshot envelopes: main = {project, repo, ref, sha}; checks = {project, repo, sha, total_count, check_runs}.
 * checks also requires commit_status = {sha, total_count, statuses}, the fully paginated combined-status response.
 * Both APIs must be read at the pinned SHA (including an explicit empty statuses list); latest contexts/runs only.
 * No config read, GH command, ledger write or scheduling side effect is performed here.
 */
export function evaluateMainCi(target: MainCiTarget, snapshot: MainCiSnapshot): MainCiHealth {
  const unknown = (code: MainCiReason["code"], sha: string | null = null) => health(target, snapshot.observedAt, sha, "unknown", [{ code }]);
  if (!Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < 0) return unknown("invalid_observation");
  if (!mainCiTargetValid(target)) return unknown("invalid_target");
  const { before, after, checks } = snapshot;
  if (!validMain(before) || !validMain(after)) return unknown("invalid_main");
  if (!scoped(before, target) || !scoped(after, target)) return unknown("scope_mismatch");
  const sha = after.sha.toLowerCase();
  if (before.sha.toLowerCase() !== sha) return unknown("main_changed", sha);
  if (!obj(checks)) return unknown("invalid_checks", sha);
  if (!scoped(checks, target)) return unknown("scope_mismatch", sha);
  if (!mainCiSha(checks.sha)) return unknown("invalid_checks", sha);
  if (checks.sha.toLowerCase() !== sha) return unknown("stale_checks", sha);
  if (!Array.isArray(checks.check_runs) || !Number.isSafeInteger(checks.total_count) || checks.total_count !== checks.check_runs.length) {
    return unknown("invalid_checks", sha);
  }
  const runs: TrainCheck[] = [], ids = new Set<number>();
  for (const raw of checks.check_runs) {
    const check = parseCheck(raw, sha);
    if (!check || ids.has(raw.id)) return unknown("invalid_checks", sha);
    ids.add(raw.id);
    runs.push(check);
  }
  const statusChecks = parseCommitStatus(checks.commit_status, sha);
  if (!statusChecks) return unknown("invalid_checks", sha);
  runs.push(...statusChecks);
  const reasons: MainCiReason[] = [];
  for (const name of parseRequiredChecks(target.requiredChecks)!) {
    const matches = runs.filter((c) => c.name === name);
    if (matches.length === 0) reasons.push({ code: "missing_check", check: name });
    else if (matches.length !== 1) reasons.push({ code: "ambiguous_check", check: name });
    else if (matches[0]!.bucket === "pending") reasons.push({ code: "pending_check", check: name });
    else if (matches[0]!.bucket !== "pass") {
      const raw = checks.check_runs.find((c) => c.name === name);
      const status = (checks.commit_status as Obj).statuses as Obj[];
      reasons.push({ code: "unsuccessful_check", check: name, conclusion: raw?.conclusion ?? status.find((s) => s.context === name)!.state as string });
    }
  }
  const state = reasons.length === 0 ? "green" : reasons.some((r) => r.code !== "unsuccessful_check") ? "unknown" : "red";
  const h = health(target, snapshot.observedAt, sha, state, reasons.length ? reasons : [{ code: "healthy" }], runs);
  return "push_runs" in checks ? { ...h, ci: classifyRuns(h, checks.push_runs, sha) } : h;
}

const activeRun = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const runStatuses = new Set([...activeRun, "completed"]);
const time = (v: unknown): number | null => {
  const t = typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : NaN;
  return Number.isSafeInteger(t) && t >= 0 ? t : null;
};
/** push_runs = {runs, commit_time}: the SHA's Actions runs (any event; only push runs on this SHA count) and the commit's committer date. */
function parsePushRuns(raw: unknown, sha: string): { runs: MainCiPushRun[]; commitTime: number | null } | null {
  if (!obj(raw) || !Array.isArray(raw.runs)) return null;
  const runs: MainCiPushRun[] = [], ids = new Set<number>();
  for (const r of raw.runs) {
    if (!obj(r) || r.event !== "push") continue;
    const createdAt = time(r.created_at), completed = r.status === "completed";
    if (!mainCiSha(r.head_sha) || r.head_sha.toLowerCase() !== sha || !Number.isSafeInteger(r.id) || (r.id as number) < 1 || ids.has(r.id as number) ||
      !Number.isSafeInteger(r.run_attempt) || (r.run_attempt as number) < 1 || typeof r.status !== "string" || !runStatuses.has(r.status) ||
      (completed ? typeof r.conclusion !== "string" || !conclusions.has(r.conclusion) : r.conclusion !== null) || createdAt === null) return null;
    ids.add(r.id as number);
    runs.push({ id: r.id as number, attempt: r.run_attempt as number, status: r.status, conclusion: r.conclusion as string | null, createdAt });
  }
  return { runs: runs.sort((a, b) => a.id - b.id), commitTime: time(raw.commit_time) };
}

/**
 * Run-aware reading of the same reasons, for this SHA only (staleness, drift and read errors never get here, or stay a fault):
 * green checks whose only push runs were cancelled are evidence_missing; a completed non-success check is a fault even while others
 * are pending; missing / pending with an active push run is waiting until
 * the run is MAIN_CI_RUN_MAX_MS old; no push run is waiting until MAIN_CI_RUN_CREATE_MS after the commit; anything else is evidence_missing.
 */
function classifyRuns(h: MainCiHealth, raw: unknown, sha: string): MainCiRunVerdict {
  const parsed = parsePushRuns(raw, sha), runs = parsed?.runs ?? [];
  const v = (verdict: MainCiRunVerdict["verdict"], why: MainCiRunVerdict["why"]): MainCiRunVerdict => ({ verdict, why, runs });
  // Green checks still need trustworthy run evidence: a sole (every) push run cancelled with no new attempt is not a healthy main.
  if (h.state === "green") {
    if (!parsed) return v("unhealthy", "runs_unreadable");
    const cancelled = runs.length > 0 && runs.every((r) => r.status === "completed" && r.conclusion === "cancelled");
    return cancelled ? v("evidence_missing", "run_cancelled") : v("green", "healthy");
  }
  if (h.reasons.some((r) => !["missing_check", "pending_check", "unsuccessful_check"].includes(r.code))) return v("unhealthy", "other_fault");
  const failed = h.reasons.filter((r) => r.code === "unsuccessful_check");
  if (failed.some((r) => r.conclusion !== "cancelled")) return v("unhealthy", "check_failed");
  if (!parsed) return v("unhealthy", "runs_unreadable");
  if (failed.length) return v("evidence_missing", "run_cancelled");
  const active = runs.filter((r) => activeRun.has(r.status));
  if (active.length) return active.some((r) => h.observedAt - r.createdAt > MAIN_CI_RUN_MAX_MS) ? v("evidence_missing", "run_overdue") : v("pending", "run_active");
  if (runs.length) return v("evidence_missing", runs.every((r) => r.conclusion === "cancelled") ? "run_cancelled" : "run_completed_checks_missing");
  if (parsed.commitTime === null) return v("unhealthy", "commit_time_unavailable");
  return h.observedAt - parsed.commitTime >= MAIN_CI_RUN_CREATE_MS ? v("evidence_missing", "run_not_created") : v("pending", "run_not_created_yet");
}

/** Combined statuses contain the latest value per context, unlike the historical /statuses endpoint. */
function parseCommitStatus(raw: unknown, sha: string): TrainCheck[] | null {
  if (!obj(raw) || !mainCiSha(raw.sha) || raw.sha.toLowerCase() !== sha || !Array.isArray(raw.statuses) ||
    !Number.isSafeInteger(raw.total_count) || raw.total_count !== raw.statuses.length) return null;
  const runs: TrainCheck[] = [], ids = new Set<number>();
  for (const s of raw.statuses) {
    if (!obj(s) || !Number.isSafeInteger(s.id) || (s.id as number) < 1 || ids.has(s.id as number) ||
      typeof s.context !== "string" || !s.context.trim() || !["success", "pending", "failure", "error"].includes(s.state as string)) return null;
    ids.add(s.id as number);
    runs.push({ name: s.context, bucket: s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail" });
  }
  return runs;
}

const statuses = new Set(["queued", "in_progress", "completed", "waiting", "pending", "requested"]);
const conclusions = new Set(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"]);
function parseCheck(raw: unknown, sha: string): TrainCheck | null {
  if (!obj(raw) || !Number.isSafeInteger(raw.id) || (raw.id as number) < 1 || typeof raw.name !== "string" || !raw.name.trim() ||
    !mainCiSha(raw.head_sha) || raw.head_sha.toLowerCase() !== sha || typeof raw.status !== "string" || !statuses.has(raw.status)) return null;
  const completed = raw.status === "completed";
  if (completed ? typeof raw.conclusion !== "string" || !conclusions.has(raw.conclusion) : raw.conclusion !== null) return null;
  const bucket = !completed ? "pending" : raw.conclusion === "success" ? "pass" : raw.conclusion === "cancelled" ? "cancel" : "fail";
  return { name: raw.name, bucket };
}

/** No default live implementation: MAINCIW must inject GH reads and bind their envelopes to its project policy. */
export async function readMainCi(target: MainCiTarget, port: MainCiReadPort, now: () => number = Date.now): Promise<MainCiHealth> {
  // Copy before awaiting: a config reload must not change the required set or repo halfway through one observation.
  const fixed = copyTarget(target);
  const observedAt = now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) return health(fixed, observedAt, null, "unknown", [{ code: "invalid_observation" }]);
  if (!mainCiTargetValid(fixed)) return health(fixed, observedAt, null, "unknown", [{ code: "invalid_target" }]);
  let phase: MainCiReason["phase"] = "main_before", sha: string | null = null;
  try {
    const before = await port.main(fixed);
    if (!validMain(before) || !scoped(before, fixed)) return evaluateMainCi(fixed, { before, after: before, checks: null, observedAt });
    sha = before.sha.toLowerCase();
    phase = "checks";
    const checks = await port.checks(fixed, sha);
    phase = "main_after";
    const after = await port.main(fixed);
    return evaluateMainCi(fixed, { before, checks, after, observedAt });
  } catch {
    // Read errors become an explicit unknown pause; raw GH stderr can contain credentials and is not a notification key.
    return health(fixed, observedAt, sha, "unknown", [{ code: "read_error", phase }]);
  }
}
