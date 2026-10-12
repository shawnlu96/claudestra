/**
 * Web production build in CI (merge-arch-FULL1): the one typed switch for the `web production build` job and what its result
 * means for the full coverage proof. off: the job is skipped and the build does not run. observe (default): it runs on its
 * own and a failure is only recorded as a would-reject. on: a failure fails the job and no full proof is written; a success
 * puts the check in the proof.
 * CI reads the mode from the repo variable CI_WEB_BUILD; the merge side reads the recovery key `ciWebBuild` and asks
 * ciWebBuildRequiredChecks, so the two disagreeing can only deny. scripts/ci-proof-artifact.ts, tests/ci-web-build-policy.test.ts.
 */
import type { RecoveryPolicyPort } from "./recovery-policy.js";

export type CiWebBuildMode = "off" | "observe" | "on";
const MODES: readonly CiWebBuildMode[] = ["off", "observe", "on"];

/** The job name in ci.yml, which is also the check name a full proof lists under on. */
export const CI_WEB_BUILD_CHECK = "web production build";

/**
 * First-phase budget, all finite (ci.yml must match, tests/ci-web-build-policy.test.ts). Measured once on a developer Mac with
 * nothing cached: install 6 s, build 19 s; no runner sample yet, so these are wide on purpose and get tightened from the observe
 * samples. A build that does not fit is a failure to look at, not a reason to lift the bound.
 * The two commands are bounded by the script itself so that a hang under observe is a recorded failure, not a red job.
 * stepMinutes bounds the build step and stays above their sum. jobMinutes is the job's own bound; every step of the job has a
 * step bound too and their sum stays below it, because a job that hits its own bound is a cancelled check whatever the mode
 * while a step that hits its bound is a failure the step's continue-on-error absorbs outside on.
 */
export const CI_WEB_BUILD_BUDGET = { installMinutes: 4, buildMinutes: 7, stepMinutes: 12, jobMinutes: 20 } as const;

/** The CI_WEB_BUILD value: absent or not one of off / observe / on reads observe. */
export function ciWebBuildMode(raw: unknown): CiWebBuildMode {
  const v = typeof raw === "string" ? raw.trim() : raw;
  return MODES.includes(v as CiWebBuildMode) ? v as CiWebBuildMode : "observe";
}

/** success = both commands exited 0 in time and the export is there; skipped = the build did not run (off). */
export type CiWebBuildOutcome = "success" | "failure" | "timeout" | "skipped";
export const CI_WEB_BUILD_OUTCOMES: readonly CiWebBuildOutcome[] = ["success", "failure", "timeout", "skipped"];

export interface CiWebBuildVerdict {
  /** The build's check name goes into the full proof's `checks`. */
  inProof: boolean;
  /** No full proof may be written. */
  blocksProof: boolean;
  /** What on would refuse; recorded only, the proof and every existing check stay as they are. */
  wouldReject: string | null;
}

/**
 * What one build result does to the full proof. `outcome` null = no trusted result from this attempt was read.
 * off never looks at the result. observe never blocks. on needs a success and nothing less.
 */
export function judgeCiWebBuild(mode: CiWebBuildMode, outcome: CiWebBuildOutcome | null): CiWebBuildVerdict {
  if (mode === "off") return { inProof: false, blocksProof: false, wouldReject: null };
  const problem = outcome === "success" ? null : `web 生产构建${outcome === null ? "没有本次运行的结果" : `结果 ${outcome}`}`;
  if (mode === "observe") return { inProof: false, blocksProof: false, wouldReject: problem };
  return { inProof: problem === null, blocksProof: problem !== null, wouldReject: null };
}

/** The required checks a full proof must list: under on the build's check joins them, otherwise they are as given. */
export function ciWebBuildRequiredChecks(mode: CiWebBuildMode, required: readonly string[]): string[] {
  return mode === "on" && !required.includes(CI_WEB_BUILD_CHECK) ? [...required, CI_WEB_BUILD_CHECK] : [...required];
}

/** The merge side's switch: the recovery key ciWebBuild (absent = observe; an unreadable policy file answers off). */
export const ciWebBuildPolicyMode = (project: string, policy: RecoveryPolicyPort): CiWebBuildMode => policy(project, "ciWebBuild").mode;
