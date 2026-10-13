/** Main health provenance is complete only after every Actions page, and filtering must not hide a truncated check response. */
import { expect, test } from "bun:test";
import { readMainCiNow } from "../src/lib/scheduler-main-ci-wiring-gh.js";
import type { runBounded } from "../src/lib/run-bounded.js";

const sha = "a".repeat(40), target = { project: "p", repo: "example/p", requiredChecks: ["check"] };
async function readPages(incompleteActions = false, incompleteChecks = false) {
  const seen: string[] = [];
  const command = async (argv: string[]) => {
    const path = argv.at(-1)!;
    seen.push(path);
    let data: unknown;
    if (path.endsWith("/git/ref/heads/main")) data = { ref: "refs/heads/main", object: { type: "commit", sha } };
    else if (path.includes("/check-runs?")) data = { total_count: incompleteChecks ? 3 : 2, check_runs: [
      { id: 1, name: "check", head_sha: sha, status: "completed", conclusion: "success", app: { slug: "github-actions" }, check_suite: { id: 101 } },
      { id: 2, name: "check", head_sha: sha, status: "completed", conclusion: "failure", app: { slug: "github-actions" }, check_suite: { id: 202 } },
    ] };
    else if (path.includes("/actions/runs?")) data = { total_count: 101, workflow_runs: path.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, n) => ({ event: "push", check_suite_id: 1000 + n }))
      : incompleteActions ? [] : [{ event: "workflow_dispatch", check_suite_id: 202 }] };
    else data = { sha, total_count: 0, statuses: [] };
    return { code: 0, stdout: JSON.stringify(data), stderr: "", timedOut: false };
  };
  return { result: await readMainCiNow(target, command as typeof runBounded, undefined, () => 1), seen };
}
test("[验收线 3] non-push provenance on page two is found; the push check remains green", async () => {
  const { result, seen } = await readPages();
  expect(result.health.state).toBe("green");
  expect(seen.filter((p) => p.includes("/actions/runs?"))).toHaveLength(2);
  expect(seen.find((p) => p.includes("/actions/runs?"))).toContain(`head_sha=${sha}`);
});
test("[验收线 5] incomplete Actions pages remain read_error, not green", async () => {
  expect((await readPages(true)).result.health).toMatchObject({ state: "unknown", reasons: [{ code: "read_error", phase: "checks" }] });
});
test("[验收线 3] exclusion cannot erase incomplete check-runs evidence", async () => {
  expect((await readPages(false, true)).result.health).toMatchObject({ state: "unknown", reasons: [{ code: "invalid_checks" }] });
});
