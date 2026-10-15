/**
 * main-red-fix's GitHub port: structured gh argv only, each call bounded in time (and the log in bytes). The repo always comes
 * from scheduler.json's project config, never from a card, PR or log text. The one external write is `gh run rerun --failed`,
 * which only the tick calls after the ledger claimed the run's single rerun. tests/main-red-fix-gh.test.ts.
 */
import { runBounded } from "./run-bounded.js";
import { LOG_LIMIT } from "./scheduler-merge-ci-log-read.js";
import type { MainRedRun } from "./main-red-fix.js";

type Command = typeof runBounded;
type Obj = Record<string, unknown>;
const TIMEOUT_MS = 30_000;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const SHA = /^[0-9a-f]{40}$/i;

export interface MainRedGh {
  /** Latest runs of one workflow file on main, newest first (at most 20). */
  runs(repo: string, file: string, event: string | null): Promise<MainRedRun[]>;
  /** Names of the failed jobs (= check names) of one attempt. */
  failedJobs(repo: string, runId: number, attempt: number): Promise<string[]>;
  /** The failed jobs' log; null when it is too long to judge (never re-run on a truncated log). */
  failedLog(repo: string, runId: number, attempt: number): Promise<string | null>;
  /** PR numbers merged into main by this commit. */
  commitPulls(repo: string, sha: string): Promise<number[]>;
  rerunFailed(repo: string, runId: number): Promise<void>;
}

function parseRun(raw: unknown): MainRedRun | null {
  if (!obj(raw) || raw.head_branch !== "main" || !Number.isSafeInteger(raw.id) || !Number.isSafeInteger(raw.run_attempt) ||
    typeof raw.status !== "string" || typeof raw.head_sha !== "string" || !SHA.test(raw.head_sha) || typeof raw.html_url !== "string" ||
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/.test(raw.html_url)) return null;
  const createdAt = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
  if (!Number.isFinite(createdAt)) return null;
  return { id: raw.id as number, attempt: raw.run_attempt as number, status: raw.status, conclusion: typeof raw.conclusion === "string" ? raw.conclusion : null,
    headSha: raw.head_sha.toLowerCase(), url: raw.html_url, createdAt };
}

export function mainRedGh(command: Command = runBounded, cwd?: string): MainRedGh {
  const gh = async (args: string[], maxBytes?: number) => {
    const r = await command(["gh", ...args], { cwd, timeoutMs: TIMEOUT_MS, maxBytes,
      env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" } });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args[0]} ${args[1] ?? ""} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r;
  };
  const json = async (args: string[]): Promise<unknown> => JSON.parse((await gh(args)).stdout) as unknown;
  return {
    async runs(repo, file, event) {
      const raw = await json(["api", "-H", "Accept: application/vnd.github+json",
        `repos/${repo}/actions/workflows/${file}/runs?branch=main&per_page=20${event ? `&event=${event}` : ""}`]);
      if (!obj(raw) || !Array.isArray(raw.workflow_runs)) throw new Error("gh api workflow runs 不是列表");
      return raw.workflow_runs.map(parseRun).filter((r): r is MainRedRun => r !== null).sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    },
    async failedJobs(repo, runId, attempt) {
      const raw = await json(["run", "view", String(runId), "--repo", repo, "--attempt", String(attempt), "--json", "jobs"]);
      if (!obj(raw) || !Array.isArray(raw.jobs)) throw new Error("gh run view 没给出 jobs");
      return raw.jobs.filter((j): j is Obj => obj(j) && j.conclusion === "failure" && typeof j.name === "string").map((j) => j.name as string);
    },
    async failedLog(repo, runId, attempt) {
      const r = await gh(["run", "view", String(runId), "--repo", repo, "--attempt", String(attempt), "--log-failed"], LOG_LIMIT);
      return r.truncated || Buffer.byteLength(r.stdout) >= LOG_LIMIT ? null : r.stdout;
    },
    async commitPulls(repo, sha) {
      const raw = await json(["api", "-H", "Accept: application/vnd.github+json", `repos/${repo}/commits/${sha}/pulls`]);
      if (!Array.isArray(raw)) throw new Error("gh api commit pulls 不是列表");
      return raw.filter((p): p is Obj => obj(p) && Number.isSafeInteger(p.number) && typeof p.merged_at === "string" && obj(p.base) && p.base.ref === "main")
        .map((p) => p.number as number);
    },
    async rerunFailed(repo, runId) { await gh(["run", "rerun", String(runId), "--failed", "--repo", repo]); },
  };
}
