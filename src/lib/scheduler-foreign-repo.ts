/**
 * i28-SECPOOL4: a card whose repository is not the project's own is never merged or deployed here. The project's merge,
 * required checks and deploy all belong to one repository (repoDir's origin; remote.repo only when that cannot be read); a card
 * elsewhere (a private repository in the shared pool) goes to PM, who merges and deploys it by that repository's own process.
 * - planner: before a merge intent is planned, escalate `foreign_repo` (scheduler-plan.ts stageStep);
 * - merge driver: inspect's repository mismatch is a marked refusal; the run ends cancelled through the same `foreign_repo`
 *   manual, never unknown, never a queue freeze (scheduler-merge-driver.ts);
 * - merge train (i28-TRAINREPO1): mergeCandidates never picks a foreign card, for the train or the manual queue's fairness check;
 *   the planner's foreign_repo hands it to PM (scheduler-merge-train-tick.ts);
 * - deploy tick: a merged foreign card is not claimed or submitted, one note per card; a claimed row is never submitted
 *   (scheduler-deploy-tick.ts).
 * A repository that cannot be read (no config, no origin, no PR link) is no verdict: the old path runs unchanged.
 * tests/scheduler-foreign-repo*.test.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
const warned = new Set<string>();
/** A lookup that failed (not one that found nothing) is logged once per message, so a broken config does not flood every tick. */
function warnLookup(what: string, e: unknown): void {
  const msg = `[scheduler-foreign-repo] ${what}: ${e instanceof Error ? e.message : String(e)}`;
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/** repoDir's origin, read with git (bounded, cached a few minutes). No origin configured (git exits 1) = null; git failing
 *  any other way throws, so the caller logs it. A repoDir that does not exist is also null, silently and without running git:
 *  the merge intent's own inspect already fails and reports it there, a warning here would only repeat it, and null is the
 *  "no verdict, old path" this lookup gives whenever the origin cannot be read. */
function gitOrigin(repoDir: string): string | null {
  if (!existsSync(repoDir)) return null;
  const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: repoDir, encoding: "utf8", timeout: 5_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status === 0 && typeof r.stdout === "string") return githubRepoOf(r.stdout);
  if (r.status === 1 && !r.error) return null;
  throw new Error(r.error?.message ?? `git config 退出 ${r.status}：${String(r.stderr ?? "").trim().slice(0, 200)}`);
}

let readOrigin: (repoDir: string) => string | null = gitOrigin;

/** `fresh` skips the cache (and refills it): a deploy is authorized only by the origin as it is now, never a planner-time value. */
function originOf(repoDir: string, fresh: boolean, now = Date.now()): string | null {
  const hit = origins.get(repoDir);
  if (!fresh && hit && now - hit.at < ORIGIN_TTL_MS) return hit.repo;
  let repo: string | null = null;
  // Unreadable falls back to remote.repo (projectRepo); a merge is still refused by inspect's own `gh repo view` check.
  try { repo = readOrigin(repoDir); } catch (e) { warnLookup(`读 ${repoDir} 的 origin 失败`, e); }
  origins.set(repoDir, { repo, at: now });
  return repo;
}

/**
 * The project's one repository (lowercased): repoDir's origin, which inspect, merge and deploy all run in; remote.repo only when
 * the origin cannot be read. Never both: a remote.repo unlike the origin would let a card of it be merged / deployed in repoDir.
 * null = unknown. `fresh` reads the origin now instead of the few-minute cache: the deploy tick's checks, right before a claim or
 * a submit, so a repoDir moved in place is never deployed by a stale verdict (review stale-origin).
 */
export function projectRepo(policy: Pick<ProjectPolicy, "repoDir" | "remote"> | undefined, opts: { fresh?: boolean } = {}): string | null {
  if (!policy) return null;
  const origin = policy.repoDir ? originOf(policy.repoDir, opts.fresh === true) : null;
  if (origin) return origin;
  const remote = policy.remote?.repo;
  return typeof remote === "string" && OWNER_REPO.test(remote) ? remote.toLowerCase() : null;
}

function configRepo(project: string): string | null {
  let config: SchedulerConfig;
  // A config that cannot be read is no verdict here: the merge intent's inspect still refuses another repository's PR as
  // ForeignRepoError, which ends the run cancelled via foreign_repo (scheduler-merge-driver.ts), so nothing merges by mistake.
  try { config = readSchedulerConfig(); } catch (e) { warnLookup("读 scheduler.json 失败", e); return null; }
  return projectRepo(config.projects[project]);
}

let projectRepoOf: (project: string) => string | null = configRepo;

/** The project's repository by name (config + git, injectable in tests); null = unknown. The merge train's candidate filter. */
export const projectRepoFor = (project: string): string | null => projectRepoOf(project);

/** The card's repository when it is known and not the project's (known) repository; else null (no verdict). */
export function foreignRepoOf(task: Pick<LedgerTask, "pr" | "extra">, repo: string | null): string | null {
  const own = cardRepo(task);
  if (!own || !repo) return null;
  return repo.toLowerCase() === own ? null : own;
}

/** Planner: a merge-stage card in another repository gets no merge intent, it goes to PM. */
export function foreignRepoEscalation(s: Pick<PlannerSnapshot, "task">): PlannerDecision | null {
  const repo = foreignRepoOf(s.task, projectRepoOf(s.task.project));
  return repo ? { kind: "escalate", code: FOREIGN_REPO_CODE, reason: foreignRepoText(repo) } : null;
}

/** Tests only: replace the project-repository lookup (null = config + git) and drop the origin cache. */
export function setForeignRepoLookupForTest(lookup: { project?: ((project: string) => string | null) | null; origin?: ((repoDir: string) => string | null) | null }): void {
  if (lookup.project !== undefined) projectRepoOf = lookup.project ?? configRepo;
  if (lookup.origin !== undefined) readOrigin = lookup.origin ?? gitOrigin;
  origins.clear();
  warned.clear();
}
