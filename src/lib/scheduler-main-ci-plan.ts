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
  candidate: MainCiCandidate;
  /** Trusted project metadata and active, persisted PM approvals; MAINCIW supplies these after normal authorization, never from task text. */
  projectPms: readonly string[];
  approvals: readonly MainCiPmApproval[];
  /** Durable notification claims reloaded from storage each tick; not a process-local cache. */
  notificationClaims: readonly string[];
}
type Disposition = "normal-gates" | "pause";
export interface MainCiPlan {
  mode: "plan-only";
  scope: { project: string; repo: string };
  reason: "healthy" | "main_unhealthy" | "scope_mismatch" | "stale_health" | "pm_repair_candidate";
  actions: Record<"formTrain" | "updateBranch" | "rerun" | "merge" | "bounce", Disposition>;
  continue: readonly ["write", "independent-review"];
  preserve: readonly ["reviews", "rounds", "resources", "unknown-side-effects"];
  cancelExistingCi: false;
  repair: { requestId: string; taskId: string; head: string; requires: readonly ["review", "ui", "ci", "authorization"] } | null;
  /** Integration must atomically persist this claim before sending to this project's PM; a lost claim means no send. */
  notification: { recipient: "project-pm"; project: string; key: string; mainSha: string | null; state: "red" | "unknown";
    kind: "main_red" | "read_unavailable" } | null;
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

function notification(i: MainCiPlanInput, current: boolean): MainCiPlan["notification"] {
  const h = i.health;
  let key: string, kind: "main_red" | "read_unavailable";
  if (current && h.state === "red") {
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
  } else return null;
  return i.notificationClaims.includes(key) ? null :
    { recipient: "project-pm", project: i.target.project, key, mainSha: h.mainSha, state: h.state as "red" | "unknown", kind };
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
  const normal: Disposition = green ? "normal-gates" : "pause";
  // Repairs take a serial path through unchanged gates; main CI alone never authorizes merge or a red-train bypass.
  const serial: Disposition = repair ? "normal-gates" : normal;
  return {
    mode: "plan-only", scope: { project: target.project, repo: target.repo },
    reason: !scopeOk ? "scope_mismatch" : !recent || (!current && h.state !== "unknown") ? "stale_health" :
      green ? "healthy" : repair ? "pm_repair_candidate" : "main_unhealthy",
    actions: { formTrain: normal, updateBranch: serial, rerun: serial, merge: serial, bounce: normal },
    continue: ["write", "independent-review"], preserve: ["reviews", "rounds", "resources", "unknown-side-effects"], cancelExistingCi: false,
    repair: repair ? { requestId: repair.requestId, taskId: c.taskId, head: c.head, requires: ["review", "ui", "ci", "authorization"] } : null,
    notification: scopeOk && recent ? notification(input, current) : null,
  };
}
