/**
 * The read map's fuse (merge-arch-SELECT4), recovery key ciIoMapFuse (absent = observe): a merge train runs every test, a PR under
 * CI_IO_MAP=on runs only what the read map selects. When a failed train run names a failing test file F and a member of that car
 * has a successful PR run on its exact head whose frozen plan used the read map and did not select F, the map left a hole: the
 * trusted repository variable CI_IO_MAP goes from on back to observe and PM is told. Nothing else changes: not CI_RELATED_CHECKS,
 * not a plan or job already running, not the train (its re-run, bisect and bounce go on exactly as before), and never back to on.
 * This file is the pure half: what counts as evidence and how it is worded. A multi-member car only proves "a member's plan
 * left out a file the train saw fail"; it never names the card that broke the train (the failure may come from the combination).
 * Not evidence: a full plan, a plan that did not use the map (CI_IO_MAP not on, or the map fell back), a plan without the PR
 * head binding or with another head, a digest that is not the one the run's own `ci scope related` check printed, a log that does
 * not read as failed test files (install / typecheck / guard / network, or cut). The reads, the write and the ledger are in
 * ci-io-map-fuse-run.ts and ci-io-map-fuse-ledger.ts. tests/ci-io-map-fuse.test.ts.
 */
import { createHash } from "node:crypto";
import { parseFailedLog } from "./scheduler-merge-ci-rerun-log.js";
import type { JobLog } from "./train-ci-timeout-diag.js";

/** The only workflow whose runs count, on the train side and on the PR side. */
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
/** ci.yml's `scope` job: its name carries the plan's scope and its log the frozen digest (`scope=related plan=sha256:…`). */
const SCOPE_JOB = /^ci scope (full|related)$/;
const SCOPE_LINE = /scope=related plan=(sha256:[0-9a-f]{64})/g;
const SHA = /^[a-f0-9]{40}$/i;
const TEST_FILE = /^[\w@./-]+\.test\.[cm]?[jt]sx?$/;
export const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;
export const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const short = (s: string) => s.slice(0, 12);

/** One Actions run (or one attempt of it) as GitHub reports it. */
export interface FuseRun {
  id: number; attempt: number; status: string; conclusion: string; branch: string; head: string; path: string; event: string;
  repo: string; headRepo: string; prs: number[];
}
export interface FuseJob { id: number; name: string; status: string; conclusion: string }
/** GitHub calls of the fuse (scheduler-merge-train-gh.ts): reads by exact id / head, and the one write, fixed to CI_IO_MAP=observe. */
export interface CiIoMapFuseGh {
  /** The run's latest attempt, or the given one. */
  ciRun(repo: string, run: number, attempt?: number): Promise<FuseRun>;
  /** ci.yml's pull_request runs whose head is exactly `head`. */
  headRuns(repo: string, head: string): Promise<FuseRun[]>;
  attemptJobs(repo: string, run: number, attempt: number): Promise<FuseJob[]>;
  /** `gh run view --attempt --log-failed`, whole; throws when it may have been cut. */
  attemptFailedLog(repo: string, run: number, attempt: number): Promise<string>;
  jobLog(repo: string, job: number): Promise<JobLog>;
  /** plan.json of the run's `ci-related-plan` artifact, as text; never executed. */
  planArtifact(repo: string, run: number): Promise<string>;
  /** CI_IO_MAP as it is now; null = not set (the plan reads that as observe). */
  ioMapVar(repo: string): Promise<string | null>;
  lowerIoMapVar(repo: string): Promise<void>;
}

export interface FuseMember { taskId: string; prRef: string; head: string }
/** One failed attempt of one car's run: everything a later pass needs to read the same evidence again. */
export interface FuseCase { project: string; repo: string; train: string; car: string; branch: string; runId: number; attempt: number; members: FuseMember[] }
export const caseId = (c: Pick<FuseCase, "repo" | "runId" | "attempt">): string => `${c.repo.toLowerCase()}#${c.runId}#${c.attempt}`;

/** A member's plan that left out failing files, bound to the exact PR head, run, attempt and digest it was frozen under. */
export interface Omission {
  taskId: string; prRef: string; pr: number; head: string; runId: number; attempt: number; digest: string; mapSha: string;
  tests: string[]; testCount: number; omitted: string[];
}
export interface FuseEvidence {
  repo: string; project: string; train: string; car: string; members: string[];
  /** the train's own run: the head it tested, the attempt that failed, the test files that failed in it */
  run: { id: number; attempt: number; head: string }; files: string[]; omissions: Omission[];
}

/** Why this run is not the car's own ci.yml run, or null. */
export function trainRunProblem(run: FuseRun, c: FuseCase): string | null {
  if (run.id !== c.runId || !sameText(run.repo, c.repo)) return "run 不属于本仓";
  if (run.path !== CI_WORKFLOW_PATH || run.event !== "pull_request") return `不是 ${CI_WORKFLOW_PATH} 的 PR 运行（${run.path} ${run.event}）`;
  if (run.branch !== c.branch) return `run 不在车厢分支 ${c.branch} 上`;
  if (run.attempt !== c.attempt) return `读到的是第 ${run.attempt} 次，不是第 ${c.attempt} 次`;
  return SHA.test(run.head) ? null : "run 没有完整的 head";
}

/** The failing test files of a whole `--log-failed`; null when the log does not read as failed test files only. */
export function failedTestFiles(log: string): string[] | null {
  const found = parseFailedLog(log);
  if (!found?.length) return null;
  const files = [...new Set(found.map((f) => f.file.replace(/^\.\//, "")))].sort();
  return files.every((f) => TEST_FILE.test(f)) ? files : null;
}

/** A successful ci.yml pull_request run of this repo, on exactly this head, that GitHub ties to this PR. */
export const isMemberRun = (run: FuseRun, repo: string, head: string, pr: number): boolean =>
  sameText(run.repo, repo) && sameText(run.headRepo, repo) && run.path === CI_WORKFLOW_PATH && run.event === "pull_request" && sameText(run.head, head) &&
  run.prs.includes(pr) && run.status === "completed" && run.conclusion === "success";

/** The run's one scope check: the job to read the digest from (related), "full", or what is wrong. */
export function scopeJob(jobs: readonly FuseJob[]): { job: FuseJob } | { full: true } | { bad: string } {
  const scope = jobs.filter((j) => SCOPE_JOB.test(j.name));
  if (scope.length !== 1) return { bad: `ci scope 检查有 ${scope.length} 个` };
  const job = scope[0]!;
  if (job.status !== "completed" || job.conclusion !== "success") return { bad: `${job.name} 没有成功` };
  return job.name === "ci scope full" ? { full: true } : { job };
}

/** The one digest the scope job printed; null when there is none or more than one. */
export function scopeDigest(log: string): string | null {
  const found = new Set([...log.matchAll(SCOPE_LINE)].map((m) => m[1]!));
  return found.size === 1 ? [...found][0]! : null;
}

export type PlanVerdict = { kind: "omits"; omitted: string[]; tests: string[]; mapSha: string } | { kind: "clean"; why: string } | { kind: "bad"; why: string };
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * A plan artifact against the digest its run froze and the member's exact head. bad = it cannot be trusted as that head's plan;
 * clean = it is, and it is no read-map omission; omits = the read map's own selection left out `omitted`.
 * The digest is ci-related-plan.ts planDigest: sha256 of the plan as written.
 */
export function judgePlan(text: string, digest: string, head: string, files: readonly string[]): PlanVerdict {
  let p: Record<string, unknown> | null;
  try { p = JSON.parse(text) as Record<string, unknown> | null; } catch { return { kind: "bad", why: "plan.json 读不懂" }; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return { kind: "bad", why: "plan.json 不是对象" };
  const own = `sha256:${createHash("sha256").update(JSON.stringify(p)).digest("hex")}`;
  if (own !== digest) return { kind: "bad", why: `计划工件的 digest ${short(own.slice(7))} 不是该次运行冻结的 ${short(digest.slice(7))}` };
  if (p.version !== 1 || p.event !== "pull_request" || !strings(p.tests)) return { kind: "bad", why: "计划不是 v1 的 PR 计划" };
  if (typeof p.prHead !== "string") return { kind: "bad", why: "计划没有绑定 PR head" };
  if (!sameText(p.prHead, head)) return { kind: "bad", why: `计划绑定的 PR head ${short(p.prHead)} 不是成员的 head` };
  if (p.scope !== "related") return { kind: "clean", why: "计划是全量" };
  const io = p.ioMap as { mode?: unknown; used?: unknown; sha?: unknown } | null | undefined;
  if (!io || io.mode !== "on" || io.used !== true) return { kind: "clean", why: "计划没有实际使用读取图" };
  if (typeof io.sha !== "string" || !SHA.test(io.sha)) return { kind: "bad", why: "计划用了读取图但没有图的来源 sha" };
  const omitted = files.filter((f) => !(p.tests as string[]).includes(f));
  return omitted.length ? { kind: "omits", omitted, tests: p.tests, mapSha: io.sha } : { kind: "clean", why: "失败文件都在计划里" };
}

/** What one fuse is bound to: the repo, the train run and attempt, the omitting plans and the failed files. */
export const evidenceKey = (e: FuseEvidence): string => createHash("sha256").update(JSON.stringify([e.repo.toLowerCase(), e.run.id, e.run.attempt,
  e.omissions.map((o) => o.digest).sort(), e.files])).digest("hex").slice(0, 40);

const runUrl = (repo: string, run: number, attempt: number) => `https://github.com/${repo}/actions/runs/${run}/attempts/${attempt}`;
const listed = (xs: readonly string[], max: number) => xs.slice(0, max).join("、") + (xs.length > max ? ` 等 ${xs.length} 个` : "");

/** The evidence chain, the same in every notice and record: what failed where, and which frozen plans left it out. */
function evidenceText(e: FuseEvidence): string {
  const plans = e.omissions.map((o) => `- ${o.taskId} ${o.prRef} head ${short(o.head)}，PR CI ${runUrl(e.repo, o.runId, o.attempt)}，计划 ${o.digest.slice(0, 19)}，` +
    `读取图 ${short(o.mapSha)}，实跑 ${o.testCount} 个测试，漏 ${listed(o.omitted, 4)}`);
  return [`列车 ${e.train} 车厢 ${e.car}（${e.members.join("、")}）测试 head ${short(e.run.head)}，${runUrl(e.repo, e.run.id, e.run.attempt)} 失败的测试文件：${listed(e.files, 6)}`,
    "成员 PR 在同一 head 上冻结的读取图计划没有选它：", ...plans.slice(0, 6),
    "这只证明成员的计划漏选了列车失败的文件；集成失败可能来自组合，不指认是哪张卡造成的。"].join("\n");
}

const at = (ms: number) => new Date(ms).toISOString();
const NO_MORE = "没有改 CI_RELATED_CHECKS，在跑的计划 / 作业照已冻结的跑完，下一个计划读 observe；不会自动再开 on，读取图 / 规则修好后由 PM 人工重开。";
/** The PM notice of a confirmed step down; `settled` = an earlier pass sent the write and this one found observe. */
export const loweredText = (e: FuseEvidence, when: number, settled: boolean): string =>
  [`[CI_IO_MAP 熔断] ${e.repo} 的 CI_IO_MAP 已从 on 退回 observe（${at(when)}，前值 on，后值 observe，` +
    `${settled ? "此前已发出写入，这次读到 observe 结清" : "写后读回确认"}）。`, evidenceText(e), NO_MORE].join("\n").slice(0, 3500);
/** The PM notice of a step down that could not be confirmed: never worded as done. */
export const unconfirmedText = (e: FuseEvidence, when: number, why: string, after: string): string =>
  [`[CI_IO_MAP 熔断] 未确认：要把 ${e.repo} 的 CI_IO_MAP 从 on 退回 observe，但${why}（${at(when)}，前值 on，写后读到 ${after}）。` +
    `请 PM 核对并手动处理：gh variable set CI_IO_MAP -R ${e.repo} --body observe`, evidenceText(e)].join("\n").slice(0, 3500);
/** observe: what on would have done. */
export const wouldText = (e: FuseEvidence): string =>
  `把 ${e.repo} 的 CI_IO_MAP 从 on 退回 observe：列车 ${e.train} 车厢 ${e.car} 的 run ${e.run.id}（第 ${e.run.attempt} 次）失败文件 ${listed(e.files, 4)}，` +
  `${e.omissions.map((o) => o.taskId).join("、")} 同 head 的读取图计划没选`;
