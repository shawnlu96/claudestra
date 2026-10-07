/**
 * Red CI on the run's own head before the required gate has a verdict (i28-CIF3, FLK2 10-07). The sharded workflow reports a
 * shard (not a required check) as failed minutes before its required gate (`typecheck + test + guard`, needs: tests) has run,
 * and GitHub already says UNSTABLE. The bounce / CIF1 / CIF2 path keys on required checks only, so that window used to fall
 * through to unknown and freeze the queue. Now the run keeps waiting there; once a required check fails, bounceStep takes it
 * (CIF1 rerun once per head, else back to fix). Red with every required check settled and none failed stays unknown.
 * tests/scheduler-merge-ci-carried*.test.ts.
 */
import type { PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";

type Check = PrSnapshot["checks"][number];
const red = (c: Check): boolean => c.bucket === "fail" || c.bucket === "cancel";

/**
 * `required`: a required check failed or was cancelled (bounceStep's ci_fail). `unsettled`: only other checks are red and some
 * required check has not reported yet (absent or pending). null: nothing red, or red only outside required checks that all settled.
 */
export function ciRed(run: Pick<MergeRun, "requiredChecks">, checks: PrSnapshot["checks"]): "required" | "unsettled" | null {
  const names = run.requiredChecks.split(",");
  if (checks.some((c) => names.includes(c.name) && red(c))) return "required";
  if (!checks.some(red)) return null;
  return names.some((n) => !checks.some((c) => c.name === n) || checks.some((c) => c.name === n && c.bucket === "pending")) ? "unsettled" : null;
}
