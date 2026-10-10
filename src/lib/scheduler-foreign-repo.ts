/**
 * i28-SECPOOL4: a card whose repository is not the project's own is never merged or deployed here. The project's merge,
 * required checks and deploy all belong to one repository (repoDir's origin, or remote.repo); a card elsewhere (a private
 * repository in the shared pool) goes to PM, who merges and deploys it by that repository's own process.
 * - planner: before a merge intent is planned, escalate `foreign_repo` (scheduler-plan.ts stageStep);
 * - merge driver: inspect's repository mismatch is a marked refusal; the run ends cancelled through the same `foreign_repo`
 *   manual, never unknown, never a queue freeze (scheduler-merge-driver.ts);
 * - deploy tick: a merged foreign card is not claimed or submitted, one note per card (scheduler-deploy-tick.ts).
 * A repository that cannot be read (no config, no origin, no PR link) is no verdict: the old path runs unchanged.
 * tests/scheduler-foreign-repo*.test.ts.
 */
import { spawnSync } from "node:child_process";
import type { LedgerTask } from "./ledger-stages.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";

type ProjectPolicy = SchedulerConfig["projects"][string];

const FOREIGN_REPO_CODE = "foreign_repo";

/** inspect's refusal when the PR is not in repoDir's repository: a fixed code the driver keys on, never a plain error. */
export class ForeignRepoError extends Error {
  readonly code = FOREIGN_REPO_CODE;
  constructor(readonly prRepo: string, readonly localRepo: string) {
    super("repoDir 仓库与 PR 仓库不一致");
    this.name = "ForeignRepoError";
  }
}

export const isForeignRepoError = (e: unknown): e is { code: string; prRepo: string; message: string } =>
  !!e && typeof e === "object" && (e as { code?: unknown }).code === FOREIGN_REPO_CODE && typeof (e as { prRepo?: unknown }).prRepo === "string";

/** The text after the code; the manual reason is `foreign_repo：<this>`. */
const foreignRepoText = (repo: string): string => `卡在 ${repo}，不是项目自动合并的仓库：由 PM 按该仓库的流程手动合并和部署`;
export const foreignRepoReason = (repo: string): string => `${FOREIGN_REPO_CODE}：${foreignRepoText(repo)}`;
export const FOREIGN_DEPLOY_NOTE = "不是项目仓库，不走自动部署";

const PR_REPO = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/;
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/** `owner/repo` (lowercased) of a full PR URL, else null. */
const prRepoOf = (pr: string | null | undefined): string | null => (pr ? PR_REPO.exec(pr)?.[1]?.toLowerCase() ?? null : null);

/** The card's repository: its PR link's, else a well-formed extra.repo; null = unknown. */
export function cardRepo(task: Pick<LedgerTask, "pr" | "extra">): string | null {
  const fromPr = prRepoOf(task.pr);
  if (fromPr) return fromPr;
  const raw = task.extra?.repo;
  return typeof raw === "string" && OWNER_REPO.test(raw.trim()) && !/\.git$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

/** `owner/repo` (lowercased) of an origin on github.com — scp form, `https://` or `ssh://` — else null. */
export function githubRepoOf(url: string): string | null {
  const repo = /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
  const scp = /^git@github\.com:(.+)$/i.exec(url.trim());
  if (scp) return repo.exec(scp[1]!)?.[1]?.toLowerCase() ?? null;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (!["https:", "ssh:"].includes(u.protocol) || u.hostname.toLowerCase() !== "github.com" || u.port) return null;
  return repo.exec(u.pathname.slice(1))?.[1]?.toLowerCase() ?? null;
}

const ORIGIN_TTL_MS = 5 * 60_000;
const origins = new Map<string, { repo: string | null; at: number }>();

/** repoDir's origin, read with git (bounded, cached a few minutes); unreadable = null. */
function gitOrigin(repoDir: string): string | null {
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: repoDir, encoding: "utf8", timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return r.status === 0 && typeof r.stdout === "string" ? githubRepoOf(r.stdout) : null;
}

let readOrigin: (repoDir: string) => string | null = gitOrigin;

function originOf(repoDir: string, now = Date.now()): string | null {
  const hit = origins.get(repoDir);
  if (hit && now - hit.at < ORIGIN_TTL_MS) return hit.repo;
  let repo: string | null = null;
  try { repo = readOrigin(repoDir); } catch { repo = null; }
  origins.set(repoDir, { repo, at: now });
  return repo;
}

/** The project's own repositories (repoDir's origin and remote.repo, lowercased); empty = unknown. */
export function policyRepos(policy: Pick<ProjectPolicy, "repoDir" | "remote"> | undefined): string[] {
  if (!policy) return [];
  const out = new Set<string>();
  const origin = policy.repoDir ? originOf(policy.repoDir) : null;
  if (origin) out.add(origin);
  const remote = policy.remote?.repo;
  if (typeof remote === "string" && OWNER_REPO.test(remote)) out.add(remote.toLowerCase());
  return [...out];
}

function configRepos(project: string): string[] {
  try { return policyRepos(readSchedulerConfig().projects[project]); } catch { return []; }
}

let projectRepos: (project: string) => readonly string[] = configRepos;

/** The card's repository when it is known and none of the project's (known) repositories; else null (no verdict). */
export function foreignRepoOf(task: Pick<LedgerTask, "pr" | "extra">, repos: readonly string[]): string | null {
  const repo = cardRepo(task);
  if (!repo || !repos.length) return null;
  return repos.some((r) => r.toLowerCase() === repo) ? null : repo;
}

/** Planner: a merge-stage card in another repository gets no merge intent, it goes to PM. */
export function foreignRepoEscalation(s: Pick<PlannerSnapshot, "task">): PlannerDecision | null {
  const repo = foreignRepoOf(s.task, projectRepos(s.task.project));
  return repo ? { kind: "escalate", code: FOREIGN_REPO_CODE, reason: foreignRepoText(repo) } : null;
}

/** Tests only: replace the project-repository lookup (null = config + git) and drop the origin cache. */
export function setForeignRepoLookupForTest(lookup: { project?: ((project: string) => readonly string[]) | null; origin?: ((repoDir: string) => string | null) | null }): void {
  if (lookup.project !== undefined) projectRepos = lookup.project ?? configRepos;
  if (lookup.origin !== undefined) readOrigin = lookup.origin ?? gitOrigin;
  origins.clear();
}
