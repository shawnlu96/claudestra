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
  reason: "healthy" | "main_unhealthy" | "scope_mismatch" | "pm_repair_candidate";
  actions: Record<"formTrain" | "updateBranch" | "rerun" | "merge" | "bounce", Disposition>;
  continue: readonly ["write", "independent-review"];
  preserve: readonly ["reviews", "rounds", "resources", "unknown-side-effects"];
  cancelExistingCi: false;
  repair: { requestId: string; taskId: string; head: string; requires: readonly ["review", "ui", "ci", "authorization"] } | null;
  /** Integration must atomically persist this claim before sending to this project's PM; a lost claim means no send. */
  notification: { recipient: "project-pm"; project: string; key: string; mainSha: string; state: "red" | "unknown" } | null;
}

/** Canonical structured fault identity: no volatile stderr, task names or check ordering in dedup/repair bindings. */
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
  if (h.state !== "red" || !fault || !token(c.taskId) || !mainCiSha(c.head)) return;
  return input.approvals.find((a) => {
    const b = a?.binding;
    return token(a?.requestId) && token(a.actor) && input.projectPms.includes(a.actor) && !!b && b.kind === "main-ci-repair" &&
      typeof b.repo === "string" && sameScope(b, c) && b.taskId === c.taskId && mainCiSha(b.head) && b.head.toLowerCase() === c.head.toLowerCase() &&
      mainCiSha(b.mainSha) && b.mainSha.toLowerCase() === h.mainSha && b.faultKey === fault;
  });
}

/** A pause is an overlay, never a ledger transition. No rounds/failures are charged and no in-flight effect is retried. */
export function planMainCi(input: MainCiPlanInput): MainCiPlan {
  const { target, health: h, candidate: c } = input;
  const scopeOk = mainCiTargetValid(target) && mainCiTargetValid(h.target) && sameScope(target, h.target) &&
    typeof c.repo === "string" && sameScope(target, c) && JSON.stringify([...new Set(target.requiredChecks)].sort()) ===
    JSON.stringify([...new Set(h.target.requiredChecks)].sort());
  const fault = scopeOk ? mainCiFaultKey(h) : null;
  const repair = scopeOk ? repairApproval(input, fault) : undefined;
  const green = scopeOk && h.state === "green" && mainCiSha(h.mainSha);
  const normal: Disposition = green ? "normal-gates" : "pause";
  // Repairs take a serial path through unchanged gates; main CI alone never authorizes merge or a red-train bypass.
  const serial: Disposition = repair ? "normal-gates" : normal;
  return {
    mode: "plan-only", scope: { project: target.project, repo: target.repo },
    reason: !scopeOk ? "scope_mismatch" : green ? "healthy" : repair ? "pm_repair_candidate" : "main_unhealthy",
    actions: { formTrain: normal, updateBranch: serial, rerun: serial, merge: serial, bounce: normal },
    continue: ["write", "independent-review"], preserve: ["reviews", "rounds", "resources", "unknown-side-effects"], cancelExistingCi: false,
    repair: repair ? { requestId: repair.requestId, taskId: c.taskId, head: c.head, requires: ["review", "ui", "ci", "authorization"] } : null,
    notification: fault && h.mainSha && h.state !== "green" && !input.notificationClaims.includes(fault) ?
      { recipient: "project-pm", project: target.project, key: fault, mainSha: h.mainSha, state: h.state } : null,
  };
}
