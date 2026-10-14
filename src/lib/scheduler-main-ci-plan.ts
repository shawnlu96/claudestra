import { createHash } from "node:crypto";
import { mainCiSha, mainCiTargetValid, type MainCiHealth, type MainCiTarget } from "./scheduler-main-ci.js";

interface MainCiCandidate { project: string; repo: string; taskId: string; head: string }
interface MainCiRepairBinding extends MainCiCandidate { kind: "main-ci-repair"; mainSha: string; faultKey: string }
export interface MainCiPmApproval {
  requestId: string;
  /** Authenticated principal from the PM approval record, never an author-supplied role/name. */
  actor: string;
  binding: MainCiRepairBinding;
}
export interface MainCiPlanInput {
  target: MainCiTarget;
  health: MainCiHealth;
  /** Trusted current main read for this target; null if unavailable. Never substitute the cached health SHA. */
  currentMainSha: string | null;
  now: number;
  maxAgeMs: number;
  /** Persisted start of consecutive read failures for this target, reset on any completed read. */
  readFailureSince: number | null;
  /** Persisted consecutive check-evidence uncertainty, scoped to this main. Reset on recovery, pending-only, read error or drift. */
  uncertainty?: { project: string; repo: string; mainSha: string; since: number } | null;
  candidate: MainCiCandidate;
  /** Trusted project metadata and active, persisted PM approvals; MAINCIW supplies these after normal authorization, never from task text. */
  projectPms: readonly string[];
  approvals: readonly MainCiPmApproval[];
  /** Durable notification claims reloaded from storage each tick; not a process-local cache. */
  notificationClaims: readonly string[];
  /**
   * MAINCIW2: "legacy" (default) = the original reading, every non-green pauses; "run" (mainCiPause=on) = health.ci decides: a still
   * running push run with nothing failed is main_ci_pending (no pause, no notice), an evidence gap is main_ci_evidence_missing (pause).
   */
  rule?: "legacy" | "run";
}
type Disposition = "normal-gates" | "pause";
export interface MainCiPlan {
  mode: "plan-only";
  scope: { project: string; repo: string };
  reason: "healthy" | "main_unhealthy" | "scope_mismatch" | "stale_health" | "pm_repair_candidate" | "main_ci_pending" | "main_ci_evidence_missing";
  actions: Record<"formTrain" | "updateBranch" | "rerun" | "merge" | "bounce", Disposition>;
  continue: readonly ["write", "independent-review"];
  preserve: readonly ["reviews", "rounds", "resources", "unknown-side-effects"];
  cancelExistingCi: false;
  /** Current exact approval binding, even when notification is deduped. MAINCIW must refresh before asking PM; changed evidence requires new approval. */
  faultKey: string | null;
  repair: { requestId: string; taskId: string; head: string; requires: readonly ["review", "ui", "ci", "authorization"] } | null;
  /** Integration must atomically persist this claim before sending to this project's PM; a lost claim means no send. */
  notification: { recipient: "project-pm"; project: string; key: string; mainSha: string | null; state: "red" | "unknown";
    kind: "main_red" | "read_unavailable" | "checks_unavailable"; faultKey: string | null } | null;
  /** The run evidence behind this plan (health.ci), only when the health carried it; kept per run id / attempt for later checking. */
  ci?: { rule: "legacy" | "run"; verdict: NonNullable<MainCiHealth["ci"]>["verdict"]; why: NonNullable<MainCiHealth["ci"]>["why"];
    runs: { id: number; attempt: number; status: string; conclusion: string | null }[] };
}

const PLAN_REASONS = ["healthy", "main_unhealthy", "scope_mismatch", "stale_health", "pm_repair_candidate", "main_ci_pending", "main_ci_evidence_missing"];
const RUN_STATUSES = ["queued", "in_progress", "completed", "waiting", "pending", "requested"];
const RUN_CONCLUSIONS = ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure"];
export interface MainCiEvidence { rule: "run"; newReason: MainCiPlan["reason"]; runs: { id: number; attempt: number; status: string; conclusion: string | null }[] }
/** The observe sample's data.evidence (`scheduler-main-ci --op observe --evidence`): exactly this shape, else null (the CLI refuses it whole). */
export function mainCiEvidence(raw: string): MainCiEvidence | null {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 2048) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  const o = v as Record<string, unknown>, pos = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join() !== "newReason,rule,runs" || o.rule !== "run" ||
    !PLAN_REASONS.includes(o.newReason as string) || !Array.isArray(o.runs) || o.runs.length > 10) return null;
  const runs: MainCiEvidence["runs"] = [];
  for (const r of o.runs as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join() !== "attempt,conclusion,id,status" || !pos(r.id) ||
      !pos(r.attempt) || !RUN_STATUSES.includes(r.status as string) ||
      (r.conclusion !== null && !RUN_CONCLUSIONS.includes(r.conclusion as string))) return null;
    runs.push({ id: r.id as number, attempt: r.attempt as number, status: r.status as string, conclusion: r.conclusion as string | null });
  }
  return { rule: "run", newReason: o.newReason as MainCiPlan["reason"], runs };
}

/**
 * The observe actionKey suffix: newReason and each run's `id@attempt` ('#' and ',' are outside recovery-policy's actionKey charset),
 * so each attempt of one SHA keeps its own sample; a run list too long for the 120-character key is replaced by its digest.
 */
export function mainCiEvidenceKey(ev: MainCiEvidence): string {
  const runs = ev.runs.map((r) => `${r.id}@${r.attempt}`).join("/");
  return `${ev.newReason}:${runs.length <= 40 ? runs : `h${createHash("sha256").update(runs).digest("hex").slice(0, 16)}`}`;
}

/** Exact repair identity; notification dedup deliberately excludes volatile check progress. */
export function mainCiFaultKey(h: MainCiHealth): string | null {
  if (h.state === "green" || !mainCiSha(h.mainSha)) return null;
  const faults = h.reasons.map((r) => JSON.stringify([r.code, r.check ?? null, r.conclusion ?? null, r.phase ?? null])).sort();
  return JSON.stringify([h.target.project, h.target.repo.toLowerCase(), h.mainSha.toLowerCase(), h.state, faults]);
}

const sameScope = (a: { project: string; repo: string }, b: { project: string; repo: string }) =>
  a.project === b.project && a.repo.toLowerCase() === b.repo.toLowerCase();
const token = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 200 && s === s.trim() && !/[\p{Cc}\p{Cf}]/u.test(s);
function repairApproval(input: MainCiPlanInput, fault: string | null): MainCiPmApproval | undefined {
  const { candidate: c, health: h } = input;
  const repairable = h.reasons.length > 0 && h.reasons.every((r) =>
    ["missing_check", "ambiguous_check", "unsuccessful_check", "pending_check"].includes(r.code)) &&
    h.reasons.some((r) => r.code !== "pending_check");
  if (!repairable || !fault || !token(c.taskId) || !mainCiSha(c.head)) return;
  return input.approvals.find((a) => {
    const b = a?.binding;
    return token(a?.requestId) && token(a.actor) && input.projectPms.includes(a.actor) && !!b && b.kind === "main-ci-repair" &&
      typeof b.repo === "string" && sameScope(b, c) && b.taskId === c.taskId && mainCiSha(b.head) && b.head.toLowerCase() === c.head.toLowerCase() &&
      mainCiSha(b.mainSha) && b.mainSha.toLowerCase() === h.mainSha?.toLowerCase() && b.faultKey === fault;
  });
}

function recentObservation(i: MainCiPlanInput): boolean {
  return Number.isSafeInteger(i.now) && Number.isSafeInteger(i.health.observedAt) && i.health.observedAt >= 0 &&
    Number.isSafeInteger(i.maxAgeMs) && i.maxAgeMs > 0 && i.now >= i.health.observedAt && i.now - i.health.observedAt <= i.maxAgeMs;
}

function uncertaintyWindow(i: MainCiPlanInput): number | null {
  const u = i.uncertainty, h = i.health;
  if (!u || !mainCiTargetValid({ ...u, requiredChecks: i.target.requiredChecks }) || !sameScope(u, i.target) ||
    !mainCiSha(u.mainSha) || u.mainSha.toLowerCase() !== h.mainSha?.toLowerCase() ||
    !Number.isSafeInteger(u.since) || u.since < 0 || u.since > h.observedAt || i.now - u.since < 15 * 60_000) return null;
  const faults = ["invalid_checks", "scope_mismatch", "stale_checks", "missing_check", "ambiguous_check"];
  if (h.state !== "unknown" || !h.reasons.some((r) => faults.includes(r.code)) ||
    !h.reasons.every((r) => faults.includes(r.code) || r.code === "pending_check")) return null;
  return Math.floor((i.now - u.since - 15 * 60_000) / (60 * 60_000));
}

function notification(i: MainCiPlanInput, current: boolean, faultKey: string | null): MainCiPlan["notification"] {
  const h = i.health;
  const uncertainWindow = current ? uncertaintyWindow(i) : null;
  let key: string, kind: NonNullable<MainCiPlan["notification"]>["kind"];
  if (current && (h.state === "red" || h.reasons.some((r) => r.code === "unsuccessful_check"))) {
    // One red claim per main commit: even failed/cancelled jobs finishing at different times must not spam PM.
    key = JSON.stringify([i.target.project, i.target.repo.toLowerCase(), h.mainSha!.toLowerCase(), "red"]);
    kind = "main_red";
  } else if (h.state === "unknown" && h.reasons.length > 0 && h.reasons.every((r) => r.code === "read_error") &&
    Number.isSafeInteger(i.readFailureSince) && i.readFailureSince! >= 0 && i.readFailureSince! <= h.observedAt &&
    i.now - i.readFailureSince! >= 15 * 60_000) {
    // Persistent outages alert after 15 minutes, then at most once per hour from that threshold, even without a SHA.
    const window = Math.floor((i.now - i.readFailureSince! - 15 * 60_000) / (60 * 60_000));
    key = JSON.stringify([i.target.project, i.target.repo.toLowerCase(), "read_unavailable", i.readFailureSince, window]);
    kind = "read_unavailable";
  } else if (uncertainWindow !== null) {
    key = JSON.stringify([i.target.project, i.target.repo.toLowerCase(), h.mainSha!.toLowerCase(), "checks_unavailable", i.uncertainty!.since, uncertainWindow]);
    kind = "checks_unavailable";
  } else return null;
  return i.notificationClaims.includes(key) ? null :
    { recipient: "project-pm", project: i.target.project, key, mainSha: h.mainSha, state: h.state as "red" | "unknown", kind, faultKey };
}

/** A pause is an overlay, never a ledger transition. No rounds/failures are charged and no in-flight effect is retried. */
export function planMainCi(input: MainCiPlanInput): MainCiPlan {
  const { target, health: h, candidate: c } = input;
  const scopeOk = mainCiTargetValid(target) && mainCiTargetValid(h.target) && sameScope(target, h.target) &&
    typeof c.repo === "string" && sameScope(target, c) && JSON.stringify([...new Set(target.requiredChecks)].sort()) ===
    JSON.stringify([...new Set(h.target.requiredChecks)].sort());
  const fault = scopeOk ? mainCiFaultKey(h) : null;
  const recent = recentObservation(input);
  const current = recent && mainCiSha(input.currentMainSha) && mainCiSha(h.mainSha) && input.currentMainSha.toLowerCase() === h.mainSha.toLowerCase();
  const repair = scopeOk && current ? repairApproval(input, fault) : undefined;
  const green = scopeOk && current && h.state === "green";
  const rule = input.rule === "run" ? "run" : "legacy";
  // Waiting is judged only for this exact, fresh, in-scope SHA; stale / drifted / unreadable evidence never reaches it.
  const waiting = rule === "run" && scopeOk && current && !green && h.ci?.verdict === "pending";
  const evidence = rule === "run" && scopeOk && current && h.ci?.verdict === "evidence_missing";
  const normal: Disposition = green || waiting ? "normal-gates" : "pause";
  // Repairs take a serial path through unchanged gates; main CI alone never authorizes merge or a red-train bypass.
  const serial: Disposition = repair ? "normal-gates" : normal;
  return {
    mode: "plan-only", scope: { project: target.project, repo: target.repo },
    reason: !scopeOk ? "scope_mismatch" : !recent || (!current && h.state !== "unknown") ? "stale_health" :
      green ? "healthy" : waiting ? "main_ci_pending" : repair ? "pm_repair_candidate" : evidence ? "main_ci_evidence_missing" : "main_unhealthy",
    actions: { formTrain: normal, updateBranch: serial, rerun: serial, merge: serial, bounce: normal },
    continue: ["write", "independent-review"], preserve: ["reviews", "rounds", "resources", "unknown-side-effects"], cancelExistingCi: false,
    faultKey: current ? fault : null,
    repair: repair ? { requestId: repair.requestId, taskId: c.taskId, head: c.head, requires: ["review", "ui", "ci", "authorization"] } : null,
    notification: scopeOk && recent && !waiting ? notification(input, current, current ? fault : null) : null,
    ...h.ci ? { ci: { rule, verdict: h.ci.verdict, why: h.ci.why,
      runs: h.ci.runs.map((r) => ({ id: r.id, attempt: r.attempt, status: r.status, conclusion: r.conclusion })) } } : {},
  };
}
