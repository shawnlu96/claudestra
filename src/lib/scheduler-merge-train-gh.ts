/**
 * GitHub calls of the merge train, all server-side through `gh` argv (never a shell string, never a local fetch or worktree):
 * refs + merges API build the train branch, a draft PR triggers CI (ci.yml runs on any pull_request).
 * Branch writes refuse anything outside `train/` here as well as in the engine. tests/scheduler-merge-train-gh.test.ts.
 */
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { repoOfPr, TRAIN_BRANCH, type TrainCheck, type TrainGh } from "./scheduler-merge-train.js";
import type { TrainJob, TrainRun, TrainRunsGh } from "./train-ci-timeout.js";
import type { TrainRerunGh } from "./scheduler-train-ci-rerun.js";

const SHA = /^[a-f0-9]{40}$/i;
/** GitHub lists at most 3000 files per PR; at the cap the list may be cut, and a cut list could hide an overlap. */
export const PR_FILES_CAP = 3000;
const oneLine = (s: string) => s.trim().split("\n")[0]?.slice(0, 300) ?? "";
const prNumber = (prRef: string): string => {
  const n = /\/pull\/(\d+)\/?$/.exec(prRef)?.[1];
  if (!n) throw new Error("PR URL 不合法");
  return n;
};
const ownBranch = (branch: string): string => {
  if (!TRAIN_BRANCH.test(branch)) throw new Error(`拒绝操作非列车分支：${branch}`);
  return branch;
};
/** run-bounded.ts keeps at most 1 MiB of output (stdout + stderr): a job log that reaches it lost its tail, the part that matters. */
const OUTPUT_CAP = 1024 * 1024;
const id = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what} 不是有效 id`);
  return n;
};
/** `[{id, name|url, status}]` from gh --jq; anything else is an error, never an empty list (empty would read as "nothing runs"). */
function idList<T extends { id: number; status: string }>(out: string, key: "url" | "name", what: string): T[] {
  const list = JSON.parse(out || "null") as unknown;
  if (!Array.isArray(list) || list.some((x) => !x || !Number.isSafeInteger(x.id) || typeof x.status !== "string" || typeof x[key] !== "string")) {
    throw new Error(`${what} 输出无效`);
  }
  return list as T[];
}
const sha = (out: string, what: string): string => {
  const v = out.trim();
  if (!SHA.test(v)) throw new Error(`${what} 没给出完整 SHA`);
  return v;
};

export function trainGh(command: typeof runBounded = runBounded): TrainGh & TrainRerunGh {
  const env = { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };
  const raw = (args: string[], timeoutMs = 120_000) => command(["gh", ...args], { env, timeoutMs });
  const gh = async (...args: string[]) => {
    const r = await raw(args);
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args[0]} ${args[1] ?? ""} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const missing = (stderr: string) => /\b(404|422)\b|Not Found|Reference does not exist/i.test(stderr);
  return {
    async mainHead(repo) { return sha(await gh("api", `repos/${repo}/git/ref/heads/main`, "--jq", ".object.sha"), "main"); },
    async prFiles(prRef) {
      const out = await gh("api", "--paginate", `repos/${repoOfPr(prRef)}/pulls/${prNumber(prRef)}/files`, "--jq",
        ".[] | .filename, (.previous_filename // empty)");
      const files = out.split("\n").map((l) => l.trim()).filter(Boolean);
      return files.length >= PR_FILES_CAP ? null : files;
    },
    async prHead(prRef) { return sha(await gh("api", `repos/${repoOfPr(prRef)}/pulls/${prNumber(prRef)}`, "--jq", ".head.sha"), "PR head"); },
    async createBranch(repo, branch, at) {
      ownBranch(branch);
      const r = await raw(["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha(at, "起点")}`]);
      if (r.code === 0 && !r.timedOut) return;
      if (!/already exists/i.test(r.stderr)) throw new Error(`建列车分支失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
      await gh("api", "-X", "PATCH", `repos/${repo}/git/refs/heads/${branch}`, "-f", `sha=${at}`, "-F", "force=true");
    },
    async mergeInto(repo, branch, head, message) {
      const r = await raw(["api", "-X", "POST", `repos/${repo}/merges`, "-f", `base=${ownBranch(branch)}`, "-f", `head=${sha(head, "成员 head")}`,
        "-f", `commit_message=${message}`]);
      if (r.code === 0 && !r.timedOut) return "merged"; // 201 merged, 204 already contained
      if (/\b409\b|merge conflict/i.test(r.stderr)) return "conflict";
      throw new Error(`拼车合并失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    },
    async openDraft(repo, branch, title, body) {
      const owner = repo.split("/")[0];
      const found = (await gh("api", `repos/${repo}/pulls?head=${owner}:${ownBranch(branch)}&state=open`, "--jq", ".[0].number // empty")).trim();
      const n = found || (await gh("api", "-X", "POST", `repos/${repo}/pulls`, "-f", `head=${branch}`, "-f", "base=main", "-f", `title=${title}`,
        "-f", `body=${body}`, "-F", "draft=true", "--jq", ".number")).trim();
      if (!/^\d+$/.test(n)) throw new Error("开列车 draft PR 没拿到 PR 号");
      return Number(n);
    },
    async checks(repo, pr) {
      const r = await raw(["pr", "checks", String(pr), "-R", repo, "--json", "bucket,name,link"], 30_000);
      if (r.timedOut) throw new Error("gh pr checks 超时");
      if (!r.stdout.trim()) {
        if (/no checks reported/i.test(r.stderr)) return []; // CI not registered yet: pending, the CI timeout bounds the wait
        throw new Error(`gh pr checks 无结果：${oneLine(r.stderr)}`);
      }
      const list = JSON.parse(r.stdout) as unknown; // exit 8 = pending, still valid JSON
      if (!Array.isArray(list) || list.some((c) => !c || typeof c.name !== "string" ||
        !["pass", "fail", "pending", "skipping", "cancel"].includes(String(c.bucket)))) throw new Error("gh pr checks 输出无效");
      return list as TrainCheck[];
    },
    async failLog(repo, link) {
      const run = /\/actions\/runs\/(\d+)/.exec(link)?.[1];
      if (!run) return "";
      const out = await gh("run", "view", run, "-R", repo, "--log-failed");
      // Lines are "<job>\t<step>\t<timestamp> <text>"; the tail is where the failure is.
      return out.split("\n").map((l) => l.split("\t").at(-1)!.replace(/^\S+Z\s/, "").trim()).filter(Boolean).slice(-6).join(" | ");
    },
    async parents(repo, at) {
      const list = JSON.parse(await gh("api", `repos/${repo}/commits/${sha(at, "提交")}`, "--jq", "[.parents[].sha]")) as unknown;
      if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !SHA.test(p))) throw new Error("提交父节点无效");
      return list as string[];
    },
    async mergeMatchHead(prRef, head) {
      repoOfPr(prRef);
      await gh("pr", "merge", prRef, "--merge", "--match-head-commit", sha(head, "审查 head"));
      return sha(await gh("pr", "view", prRef, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"), "合并提交");
    },
    ...runsApi(gh, raw),
    ...rerunApi(gh),
    async closePr(repo, pr) { await gh("api", "-X", "PATCH", `repos/${repo}/pulls/${pr}`, "-f", "state=closed"); },
    async deleteBranch(repo, branch) {
      const r = await raw(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${ownBranch(branch)}`]);
      if ((r.code !== 0 || r.timedOut) && !missing(r.stderr)) throw new Error(`删列车分支失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    },
  };
}

type Gh = (...args: string[]) => Promise<string>;
type Raw = (args: string[], timeoutMs?: number) => Promise<BoundedResult>;
/** trainCiTimeout's Actions calls (train-ci-timeout.ts): runs are looked up by the train's own branch only, so an author PR or main is never touched. */
function runsApi(gh: Gh, raw: Raw): TrainRunsGh {
  return {
    async branchRuns(repo, branch): Promise<TrainRun[]> {
      const out = await gh("api", `repos/${repo}/actions/runs?branch=${ownBranch(branch)}&per_page=50`, "--jq",
        `[.workflow_runs[] | select(.head_branch == "${branch}") | {id, url: .html_url, status}]`);
      return idList<TrainRun>(out, "url", "列车 run 列表");
    },
    async runStatus(repo, run, branch) { // one run by id: a run missing from a branch listing is never read as stopped
      const out = await gh("api", `repos/${repo}/actions/runs/${id(run, "run")}`, "--jq", "{id, status, head_branch}");
      const r = JSON.parse(out || "null") as { id?: unknown; status?: unknown; head_branch?: unknown } | null;
      if (r?.id !== run || typeof r.status !== "string" || r.head_branch !== ownBranch(branch)) throw new Error(`run ${run} 状态输出无效`);
      return r.status;
    },
    async runJobs(repo, run): Promise<TrainJob[]> {
      return idList<TrainJob>(await gh("api", `repos/${repo}/actions/runs/${id(run, "run")}/jobs?per_page=100`, "--jq",
        "[.jobs[] | {id, name, status}]"), "name", "run 的 job 列表");
    },
    async cancelRun(repo, run) {
      const r = await raw(["api", "-X", "POST", `repos/${repo}/actions/runs/${id(run, "run")}/cancel`]);
      if (r.code === 0 && !r.timedOut) return "requested";
      if (!r.timedOut && /\b409\b|completed/i.test(r.stderr)) return "finished"; // GitHub refuses to cancel a run that already finished
      throw new Error(`取消 run 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    },
    async jobLog(repo, job) {
      const r = await raw(["api", `repos/${repo}/actions/jobs/${id(job, "job")}/logs`], 60_000);
      if (r.code !== 0 || r.timedOut) throw new Error(`job 日志取不到：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
      return { text: r.stdout, truncated: Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr) >= OUTPUT_CAP };
    },
  };
}

/** A cut failed log could hide a failure of another kind (same margin under run-bounded's cap as scheduler-merge-ci-rerun.ts). */
const FAILED_LOG_LIMIT = 900 * 1024;
/** The red-car re-run's calls (scheduler-train-ci-rerun.ts): the run is read by id and must sit on the car's own `train/` branch. */
function rerunApi(gh: Gh): TrainRerunGh {
  return {
    async runAttempt(repo, run, branch) {
      const out = await gh("api", `repos/${repo}/actions/runs/${id(run, "run")}`, "--jq", "{id, status, conclusion, head_branch, run_attempt}");
      const r = JSON.parse(out || "null") as { id?: unknown; status?: unknown; conclusion?: unknown; head_branch?: unknown; run_attempt?: unknown } | null;
      if (r?.id !== run || typeof r.status !== "string" || r.head_branch !== ownBranch(branch) || !Number.isSafeInteger(r.run_attempt) || (r.run_attempt as number) < 1) {
        throw new Error(`run ${run} 不在 ${branch} 上，或 attempt / 状态输出无效`);
      }
      return { attempt: r.run_attempt as number, status: r.status, conclusion: typeof r.conclusion === "string" ? r.conclusion : "" };
    },
    async failedLog(repo, run) {
      const log = await gh("run", "view", String(id(run, "run")), "-R", repo, "--log-failed");
      if (Buffer.byteLength(log) >= FAILED_LOG_LIMIT) throw new Error("失败日志太长，可能被截断");
      return log;
    },
    async rerunFailed(repo, run) { await gh("run", "rerun", String(id(run, "run")), "--failed", "-R", repo); },
  };
}
