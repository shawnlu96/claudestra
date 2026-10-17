/**
 * GitHub calls of the merge train, all server-side through `gh` argv (never a shell string, never a local fetch or worktree):
 * refs + merges API build the train branch, a draft PR triggers CI (ci.yml runs on any pull_request).
 * Branch writes refuse anything outside `train/` here as well as in the engine. tests/scheduler-merge-train-gh.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiIoMapFuseGh, FuseJob, FuseRun } from "./ci-io-map-fuse.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { aliasPick, sameRepo } from "./repo-alias.js";
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

export function trainGh(command: typeof runBounded = runBounded): TrainGh & TrainRerunGh & CiIoMapFuseGh {
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
    ...fuseApi(raw),
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

const RUN_FIELDS = "{id, status, conclusion, head_branch, head_sha, run_attempt, path, event, repo: .repository.full_name, " +
  "head_repo: .head_repository.full_name, prs: [.pull_requests[]?.number]}";
/** One run as RUN_FIELDS printed it; anything missing is an error, never a default. */
function fuseRun(x: unknown): FuseRun {
  const r = x as Record<string, unknown> | null, text = (v: unknown) => (typeof v === "string" ? v : "");
  if (!r || !Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.run_attempt) || (r.run_attempt as number) < 1 || typeof r.status !== "string" ||
    typeof r.head_sha !== "string" || typeof r.path !== "string" || typeof r.repo !== "string" || !Array.isArray(r.prs)) throw new Error("run 输出无效");
  return { id: r.id as number, attempt: r.run_attempt as number, status: r.status, conclusion: text(r.conclusion), branch: text(r.head_branch), head: r.head_sha,
    path: r.path, event: text(r.event), repo: r.repo, headRepo: text(r.head_repo), prs: r.prs.filter((n) => Number.isSafeInteger(n)) as number[] };
}
/** REPOMERGE1: a run GitHub reports under the renamed repository's other name (old ↔ new) reads as the repository asked for when
 *  repoAlias is on, so an old-name train claims its new-name runs; any other repository (a fork's head repo included) stays as read. */
function asAsked(run: FuseRun, repo: string): FuseRun {
  const name = (got: string) => aliasPick("scheduler-merge-train-gh.runRepo", got,
    got.toLowerCase() !== repo.toLowerCase() && sameRepo(got, repo) ? repo : got);
  return { ...run, repo: name(run.repo), headRepo: name(run.headRepo) };
}
/** The only variable this port reads or writes, and the only value it ever writes. */
const IO_MAP_VAR = "CI_IO_MAP", SAFE_VALUE = "observe", PLAN_ARTIFACT = "ci-related-plan", PLAN_MAX_BYTES = 8 * 1024 * 1024;
const ownRepo = (repo: string): string => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("仓库名不合法");
  return repo;
};
/**
 * The read map fuse's calls (ci-io-map-fuse.ts): runs are read by exact id or exact head sha, the plan artifact is only read as
 * text (never run), and the one write sets CI_IO_MAP to observe: neither the name nor the value is an argument.
 */
function fuseApi(raw: Raw): Omit<CiIoMapFuseGh, "jobLog"> {
  // its own short timeouts: these calls sit inside a train step, and none of them may hold the pass for long
  const gh: Gh = async (...args) => {
    const r = await raw(args, args[1] === "download" ? 60_000 : 30_000);
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args[0]} ${args[1] ?? ""} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  return {
    async ciRun(repo, run, attempt) {
      const at = attempt === undefined ? "" : `/attempts/${id(attempt, "attempt")}`;
      return asAsked(fuseRun(JSON.parse(await gh("api", `repos/${ownRepo(repo)}/actions/runs/${id(run, "run")}${at}`, "--jq", RUN_FIELDS) || "null")), repo);
    },
    async headRuns(repo, head) {
      const list = JSON.parse(await gh("api", `repos/${ownRepo(repo)}/actions/workflows/ci.yml/runs?head_sha=${sha(head, "成员 head")}&event=pull_request&per_page=100`,
        "--jq", `[.workflow_runs[] | ${RUN_FIELDS}]`) || "null") as unknown;
      if (!Array.isArray(list)) throw new Error("run 列表输出无效");
      return list.map((r) => asAsked(fuseRun(r), repo));
    },
    async attemptJobs(repo, run, attempt) {
      const out = JSON.parse(await gh("api", `repos/${ownRepo(repo)}/actions/runs/${id(run, "run")}/attempts/${id(attempt, "attempt")}/jobs?per_page=100`, "--jq",
        "{total: .total_count, jobs: [.jobs[] | {id, name, status, conclusion}]}") || "null") as { total?: unknown; jobs?: unknown } | null;
      const jobs = out?.jobs;
      if (!Array.isArray(jobs) || out?.total !== jobs.length || jobs.some((j) => !j || !Number.isSafeInteger(j.id) || typeof j.name !== "string" || typeof j.status !== "string")) {
        throw new Error("attempt 的 job 列表输出无效或没列全");
      }
      return jobs.map((j): FuseJob => ({ id: j.id, name: j.name, status: j.status, conclusion: typeof j.conclusion === "string" ? j.conclusion : "" }));
    },
    async attemptFailedLog(repo, run, attempt) {
      const log = await gh("run", "view", String(id(run, "run")), "--attempt", String(id(attempt, "attempt")), "-R", ownRepo(repo), "--log-failed");
      if (Buffer.byteLength(log) >= FAILED_LOG_LIMIT) throw new Error("失败日志太长，可能被截断");
      return log;
    },
    async planArtifact(repo, run) {
      const dir = mkdtempSync(join(tmpdir(), "ci-io-map-fuse-"));
      try {
        await gh("run", "download", String(id(run, "run")), "-R", ownRepo(repo), "-n", PLAN_ARTIFACT, "-D", dir);
        const file = join(dir, "plan.json");
        if (statSync(file).size > PLAN_MAX_BYTES) throw new Error("计划工件过大");
        return readFileSync(file, "utf8");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    async ioMapVar(repo) {
      const r = await raw(["api", `repos/${ownRepo(repo)}/actions/variables/${IO_MAP_VAR}`, "--jq", ".value"], 30_000);
      if (r.code === 0 && !r.timedOut) return r.stdout.replace(/\r?\n$/, "");
      if (!r.timedOut && /\b404\b|Not Found/i.test(r.stderr)) return null;
      throw new Error(`读 ${IO_MAP_VAR} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    },
    async lowerIoMapVar(repo) { await gh("variable", "set", IO_MAP_VAR, "-R", ownRepo(repo), "--body", SAFE_VALUE); },
  };
}
