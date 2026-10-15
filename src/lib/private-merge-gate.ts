/**
 * merge-arch-MERGEAUTO1 · which private-repo cards the scheduler merges itself (docs/architecture/private-merge.md).
 * A private card (fileGlobs `repo:<owner>/<name>/…`, card-repo.ts privateCardRepo) whose PR is in that repository and that has a
 * checkout in the project's dirs (repoDirFor: origin is the same repository) goes through the merge pipeline; any other goes to PM
 * through the old `foreign_repo`, word for word. Recovery key `privateRepoMerge`:
 * - off: nothing read, nothing recorded, both foreign_repo paths unchanged;
 * - observe: foreign_repo unchanged, one recordObserved per (card, head): 「本会自动合并」 or 「不能自动合并：<原因>」;
 * - on: the planner plans the merge intent instead of escalating (scheduler-plan.ts stageStep) and private-merge.ts drives it.
 * Every attempt (merged, wait, bounce, PM) is one ledger note under the same key, by card + head, for agents-OBSAUTO1.
 * Reasons name the repository only, never a local path. tests/private-merge*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { LOCAL_REPO_DIRS, prCoordinates, privateCardRepo, repoDirFor, type RepoDirIO } from "./card-repo.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, openLedger } from "./ledger-store.js";
import { observeDedupKey, recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { isTestProcess } from "./test-guard.js";

const PRIVATE_MERGE_KEY = "privateRepoMerge" as const;

export interface PrivateMergePorts {
  policy: RecoveryPolicyPort;
  repoDirs: RepoDirIO;
  command: typeof runBounded;
  /** The ledger the records, the serial check and the narrowing use; null = none (a test process without one): nothing is recorded and the driver path stays off. */
  ledger(): Database | null;
  /** The project's merge belongs to the repository owner (mergeHandoff): never merged here. Throws when the config cannot be read. */
  handoff(project: string): boolean;
  now(): number;
}
const LOCAL: PrivateMergePorts = {
  policy: recoveryPolicy, repoDirs: LOCAL_REPO_DIRS, command: runBounded, now: () => Date.now(),
  ledger: () => (isTestProcess() ? null : openLedger()),
  handoff: (project) => readSchedulerConfig().projects[project]?.mergeHandoff === true,
};
let ports = LOCAL;
export const privateMergePorts = (): PrivateMergePorts => ports;

const CHECKOUT_TTL_MS = 5 * 60_000;
const checkouts = new Map<string, { dir: string | null; at: number }>();
/** Tests only: replace some ports (null puts the real ones back) and drop the checkout cache. */
export function setPrivateMergePortsForTest(over: Partial<PrivateMergePorts> | null): void {
  ports = over ? { ...LOCAL, ...over } : LOCAL;
  checkouts.clear();
}

/** The effective mode; a policy that cannot be read is off (recoveryPolicy already says off for a bad file). */
export function privateMergeMode(project: string): RecoveryMode {
  try { return ports.policy(project, PRIVATE_MERGE_KEY).mode; } catch { return "off"; }
}

const noCheckoutReason = (repo: string): string => `本机没有 ${repo} 的检出`;

/** repoDirFor through the ports, cached a few minutes per (project, repository): the planner asks it every pass. */
function checkoutOf(project: string, repo: string): string | null {
  const key = `${project}\0${repo}`, now = ports.now(), hit = checkouts.get(key);
  if (hit && now - hit.at < CHECKOUT_TTL_MS) return hit.dir;
  const dir = repoDirFor(project, repo, ports.repoDirs);
  checkouts.set(key, { dir, at: now });
  return dir;
}

export type PrivateMergeVerdict = { repo: string; dir: string } | { repo: string; refused: string };
/** null = not a private card (the old path, nothing recorded); else the checkout to merge in, or why not (repository named, no path). */
export function privateMergeVerdict(task: Pick<LedgerTask, "project" | "pr" | "extra">): PrivateMergeVerdict | null {
  const declared = privateCardRepo(task)?.toLowerCase();
  if (!declared) return null;
  const repo = prCoordinates(task.pr)?.repo.toLowerCase();
  if (!repo) return { repo: declared, refused: "卡上没有完整的 PR 链接" };
  if (repo !== declared) return { repo, refused: `PR 不在卡的私仓 ${declared}` };
  try {
    if (ports.handoff(task.project)) return { repo, refused: "项目的合并交仓库方（mergeHandoff）" };
  } catch { return { repo, refused: "读不到调度配置" }; }
  let dir: string | null;
  try { dir = checkoutOf(task.project, repo); } catch { dir = null; }
  return dir ? { repo, dir } : { repo, refused: noCheckoutReason(repo) };
}

/**
 * One ledger note per (card, actionKey) through recordObserved, in every mode; returns the note's time (the first one's, when it
 * was already there), or null when there is no ledger or the write failed (logged, never thrown: a record never holds a merge up).
 */
export function recordPrivateMerge(project: string, taskId: string, actionKey: string, action: string, data: Record<string, unknown> = {}): number | null {
  try {
    const db = ports.ledger();
    if (!db) return null;
    const a = { project, mechanism: PRIVATE_MERGE_KEY, target: taskId, actionKey, action, data };
    const key = observeDedupKey(a);
    const prev = getEventByDedup(db, key);
    if (prev) return prev.ts;
    recordObserved(db, a, ports.now());
    return getEventByDedup(db, key)?.ts ?? ports.now();
  } catch (e) {
    console.error(`⚠️ [private-merge] ${taskId} 记台账失败（合并照常）：${(e as Error).message}`);
    return null;
  }
}

/**
 * Planner (scheduler-plan.ts, at the foreignRepoEscalation call): true = do not escalate this foreign card, plan its merge. Only on
 * with a checkout says true; observe records what on would do; a refusal under on is recorded too. Not a private card = false.
 */
export function privateRepoMergeAdmits(s: Pick<PlannerSnapshot, "task">): boolean {
  const { task } = s, mode = privateMergeMode(task.project);
  if (mode === "off") return false;
  const v = privateMergeVerdict(task);
  if (!v) return false;
  const head = task.headSHA ?? "none", data = { head, repo: v.repo, mode };
  if (mode === "observe") {
    recordPrivateMerge(task.project, task.id, `h-${head}`, "refused" in v ? `不能自动合并：${v.refused}` : "自动合并", data);
    return false;
  }
  if ("refused" in v) {
    recordPrivateMerge(task.project, task.id, `${head}:pm`, `交 PM：${v.refused}`, { ...data, outcome: "pm" });
    return false;
  }
  return true;
}
