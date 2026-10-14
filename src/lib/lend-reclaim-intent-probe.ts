/**
 * Production reads behind lend-reclaim-intent.ts: does the order branch exist on origin, and does any PR (open, closed or merged)
 * have it as head. Structured argv, no shell, no prompts, bounded time. Only a successful, complete, well-formed answer may say
 * "absent" / "none"; a failure, timeout, auth error, truncated or unparsable output is `unknown`, which keeps the intent unknown.
 * tests/lend-reclaim-intent-probe.test.ts drives it with a fake runner.
 */
import { REPO_RE } from "./lend-config.js";
import { LEND_BRANCH_RE, lendRepoUrl } from "./lend-git.js";
import type { BranchProbe, PrProbe, ReclaimIntentProbe } from "./lend-reclaim-intent.js";
import { ghEnv, type Command } from "./peer-pr-github.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";

const SHA40 = /^[0-9a-f]{40}$/;
/** gh lists at most this many; a full page could hide nothing that matters (any row already keeps unknown). */
const PR_LIMIT = 100;
const tail = (r: BoundedResult): string => (r.stderr || r.stdout).trim().split("\n").pop()?.slice(0, 200) ?? "";
/** runBounded cut the output at its cap: an empty or short-looking answer is then not the whole answer. */
const TRUNCATED = (what: string): string => `${what} 的输出被截断，结果不完整`;
const failed = (what: string, r: BoundedResult): string => r.timedOut ? `${what} 超时` : `${what} 失败（exit ${r.code}）：${tail(r)}`;

/** `git ls-remote --exit-code`: exit 2 with no output is git's own "no matching ref"; anything else unclear is unknown. */
export function parseBranchProbe(r: BoundedResult, branch: string): BranchProbe {
  if (r.timedOut) return { state: "unknown", why: "git ls-remote 超时" };
  if (r.truncated) return { state: "unknown", why: TRUNCATED("git ls-remote") };
  if (r.code === 2 && !r.stdout.trim()) return { state: "absent" };
  if (r.code !== 0) return { state: "unknown", why: failed("git ls-remote", r) };
  const rows = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/));
  const hit = rows.length === 1 && rows[0].length === 2 && rows[0][1] === `refs/heads/${branch}` && SHA40.test(rows[0][0]) ? rows[0][0] : null;
  return hit ? { state: "present", head: hit } : { state: "unknown", why: `git ls-remote 的输出看不懂（${rows.length} 行）` };
}

/** `gh pr list --state all --json number,headRefName`: an array of well-formed rows, every one naming this branch, or unknown. */
export function parsePrProbe(r: BoundedResult, branch: string): PrProbe {
  if (r.timedOut || r.code !== 0) return { state: "unknown", why: failed("gh pr list", r) };
  if (r.truncated) return { state: "unknown", why: TRUNCATED("gh pr list") };
  let rows: unknown;
  try { rows = JSON.parse(r.stdout); } catch { return { state: "unknown", why: "gh pr list 的输出不是 JSON" }; } // the reason is the result: unparsable = unknown
  if (!Array.isArray(rows)) return { state: "unknown", why: "gh pr list 的输出不是数组" };
  const ok = rows.every((x) => !!x && typeof x === "object" && Number.isInteger((x as { number?: unknown }).number) && (x as { headRefName?: unknown }).headRefName === branch);
  if (!ok) return { state: "unknown", why: "gh pr list 的输出字段缺失、类型不对或分支对不上" };
  return rows.length ? { state: "exists", numbers: rows.map((x) => (x as { number: number }).number) } : { state: "none" };
}

export function reclaimIntentProbe(run: Command = runBounded, env: Record<string, string | undefined> = process.env): ReclaimIntentProbe {
  const valid = (repo: string, branch: string): string | null =>
    !REPO_RE.test(repo) ? `仓库坐标 ${repo.slice(0, 80)} 不合格` : !LEND_BRANCH_RE.test(branch) ? `出借分支名 ${branch.slice(0, 80)} 不合格` : null;
  return {
    async branch(repo, branch) {
      const bad = valid(repo, branch);
      if (bad) return { state: "unknown", why: bad };
      const r = await run(["git", "ls-remote", "--exit-code", lendRepoUrl(repo, env), `refs/heads/${branch}`],
        { env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 15_000 });
      return parseBranchProbe(r, branch);
    },
    async prs(repo, branch) {
      const bad = valid(repo, branch);
      if (bad) return { state: "unknown", why: bad };
      const r = await run(["gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", String(PR_LIMIT),
        "--json", "number,headRefName"], { env: ghEnv(env), timeoutMs: 60_000 });
      return parsePrProbe(r, branch);
    },
  };
}
