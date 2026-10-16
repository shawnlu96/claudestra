/**
 * CINOOP1 · noChange 交付的外部证据：接收端自己读 GitHub，不信交付方的自述。
 * - out_of_scope_ci：原失败 run 必须跑在交付 head 上且确实失败；失败日志按 ci-failure-class.ts 对 PR 实际改动分类，只认 known_flaky / timeout，
 *   且分类出的失败文件与交付方报的逐个相等（不凭 fileGlobs 或自述认定范围外）；再看同 head 最新的 required 检查是否全绿。
 * - main_already_resolved：当前 main 的准确 head、同一 workflow 在这个 head 上最新一次有结论的 run 必须是 success 且就是交付方给的那个 run。
 * 读失败 / 不全 / pending 一律「未定」（unavailable），对不上的是 invalid；这里只读不写。端口可注入，测试进程不碰真实 gh。
 * tests/ci-no-change-recovery.test.ts。
 */
import { classifyFailedLog } from "./ci-failure-class.js";
import { latestDecided, type MainRedRun } from "./main-red-fix.js";
import { mainRedGh } from "./main-red-fix-gh.js";
import { runRef, type MainAlreadyResolved, type OutOfScopeCi } from "./order-no-change.js";
import { runBounded } from "./run-bounded.js";
import { ciRerunGh } from "./scheduler-merge-ci-rerun.js";
import { isTestProcess } from "./test-guard.js";

export interface CheckRow { name: string; status: string; conclusion: string | null }
export interface RunRead { headSha: string; attempt: number; status: string; conclusion: string; log: string | null }
/** 外部 CI 的读口；每个方法读不到就抛（调用方当作「未定」） */
export interface CiNoChangePort {
  /** 这个 commit 上每个检查最新的一次（GitHub check-runs 默认 filter=latest） */
  headChecks(repo: string, head: string): Promise<CheckRow[]>;
  /** run 的一次 attempt（null = 最新一次）与它失败 job 的日志（过长 = null） */
  run(repo: string, runId: number, attempt: number | null): Promise<RunRead>;
  prFiles(repo: string, pr: number): Promise<string[]>;
  mainHead(repo: string): Promise<string>;
  mainRuns(repo: string, file: string, event: string | null): Promise<MainRedRun[]>;
}

export type Evidence<T> = { ok: true; facts: T } | { ok: false; code: "unavailable" | "invalid"; why: string };
const pending = (why: string): Evidence<never> => ({ ok: false, code: "unavailable", why });
const invalid = (why: string): Evidence<never> => ({ ok: false, code: "invalid", why });
const SHA40 = /^[0-9a-f]{40}$/;

/** required 检查在这个 head 上：缺项 / 没跑完 / 红 / 取消都不是全绿；同名多条按最后一条（端口给的是最新） */
export function ciGreen(checks: readonly CheckRow[], required: readonly string[]): { green: true } | { green: false; why: string } {
  if (!required.length) return { green: false, why: "没有 required 检查清单，核不了" };
  const latest = new Map(checks.map((c) => [c.name, c] as const));
  for (const name of required) {
    const c = latest.get(name);
    if (!c) return { green: false, why: `required 检查 ${name} 在这个 head 上还没有结果（缺项）` };
    if (c.status !== "completed") return { green: false, why: `required 检查 ${name} 还在跑（${c.status}）` };
    if (c.conclusion !== "success") return { green: false, why: `required 检查 ${name} 的结论是 ${c.conclusion ?? "空"}${c.conclusion === "cancelled" ? "（被取消）" : ""}` };
  }
  return { green: true };
}

/** 失败日志按 PR 实际改动分类：只有范围外的断言失败 / 超时算；分类出的文件要与交付方报的逐个相等 */
export function failureFilesMatch(claimed: readonly string[], log: string, prFiles: readonly string[]): { ok: true } | { ok: false; why: string } {
  const c = classifyFailedLog(log, new Set(prFiles));
  if (c.kind !== "known_flaky" && c.kind !== "timeout") return { ok: false, why: `原 run 日志分类为 ${c.kind}：${"why" in c ? c.why : "不是范围外的测试失败"}` };
  const want = [...c.files].sort(), got = [...claimed].sort();
  if (want.join("\n") !== got.join("\n")) return { ok: false, why: `原 run 日志里失败的文件是 ${want.join("、")}，与交付报的 ${got.join("、")} 不一致` };
  return { ok: true };
}

export interface OutOfScopeFacts { run: string; runId: number; attempt: number; files: string[]; required: string[]; checks: CheckRow[] }
export interface OutOfScopeWant { repo: string; pr: number; head: string; required: readonly string[] }

async function guarded<T>(what: string, read: () => Promise<T>): Promise<T | Evidence<never>> {
  try { return await read(); } catch (e) { return pending(`${what}读不到：${(e as Error).message.slice(0, 200)}`); }
}
const failed = (v: unknown): v is Evidence<never> => !!v && typeof v === "object" && (v as { ok?: unknown }).ok === false;

export async function readOutOfScope(port: CiNoChangePort, want: OutOfScopeWant, nc: OutOfScopeCi): Promise<Evidence<OutOfScopeFacts>> {
  const ref = runRef(nc.run)!;
  if (ref.repo !== want.repo.toLowerCase()) return invalid(`run 链接的仓库 ${ref.repo} 不是这张卡的 ${want.repo}`);
  const run = await guarded("原失败 run ", () => port.run(want.repo, ref.runId, ref.attempt));
  if (failed(run)) return run;
  if (run.headSha.toLowerCase() !== want.head) return invalid(`原 run 跑在 ${run.headSha.slice(0, 12)} 上，不是交付 head`);
  if (run.status !== "completed" || run.conclusion !== "failure") return invalid(`原 run 这一次的结论是 ${run.status}/${run.conclusion}，不是失败`);
  if (run.log === null) return pending("原 run 的失败日志太长或读不全，不判");
  const files = await guarded("PR 改动文件", () => port.prFiles(want.repo, want.pr));
  if (failed(files)) return files;
  const match = failureFilesMatch(nc.files, run.log, files);
  if (!match.ok) return invalid(match.why);
  const checks = await guarded("同 head 的 CI ", () => port.headChecks(want.repo, want.head));
  if (failed(checks)) return checks;
  const g = ciGreen(checks, want.required);
  if (!g.green) return pending(`同 head 最新 CI 未全绿：${g.why}`);
  return { ok: true, facts: { run: nc.run, runId: ref.runId, attempt: run.attempt, files: [...nc.files], required: [...want.required], checks } };
}

export interface MainResolvedFacts { mainHead: string; mainRunId: number; mainRun: string; workflow: string }
export interface MainResolvedWant { repo: string; workflowFile: string; event: string | null; sourceRunId: number }

export async function readMainResolved(port: CiNoChangePort, want: MainResolvedWant, nc: MainAlreadyResolved): Promise<Evidence<MainResolvedFacts>> {
  const src = runRef(nc.sourceRun)!, green = runRef(nc.mainRun)!;
  if (src.repo !== want.repo.toLowerCase()) return invalid(`run 链接的仓库 ${src.repo} 不是这张卡的 ${want.repo}`);
  if (src.runId !== want.sourceRunId) return invalid(`sourceRun 是 run ${src.runId}，这张卡的 MAINRED1 来源是 run ${want.sourceRunId}`);
  const head = await guarded("当前 main head ", () => port.mainHead(want.repo));
  if (failed(head)) return head;
  if (!SHA40.test(head) || head !== nc.mainHead) return invalid(`当前 main 是 ${String(head).slice(0, 12)}，不是交付给的 ${nc.mainHead.slice(0, 12)}：按最新 main 重交`);
  const runs = await guarded("main 的 run 列表", () => port.mainRuns(want.repo, want.workflowFile, want.event));
  if (failed(runs)) return runs;
  const latest = latestDecided(runs);
  if (!latest || latest.headSha !== head) return pending(`${want.workflowFile} 在当前 main ${head.slice(0, 12)} 上还没有结论`);
  if (latest.conclusion !== "success") return invalid(`${want.workflowFile} 在当前 main 上最新的结论是 ${latest.conclusion}`);
  if (latest.id !== green.runId) return invalid(`当前 main 上最新的绿 run 是 ${latest.id}，不是交付给的 ${green.runId}`);
  return { ok: true, facts: { mainHead: head, mainRunId: latest.id, mainRun: latest.url, workflow: want.workflowFile } };
}

type Command = typeof runBounded;
const ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" });

/** 真实读口：结构化 gh argv，仓库坐标由调用方从台账给；run / main runs / PR 文件复用 MAINRED1、CIF1 已有的读法 */
function ghNoChangePort(command: Command = runBounded): CiNoChangePort {
  const main = mainRedGh(command), rerun = ciRerunGh(command);
  const json = async (args: string[]): Promise<Record<string, unknown>> => {
    const r = await command(["gh", ...args], { env: ENV(), timeoutMs: 60_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh ${args.slice(0, 2).join(" ")} 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
    const v = JSON.parse(r.stdout) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("gh 输出不是对象");
    return v as Record<string, unknown>;
  };
  return {
    async headChecks(repo, head) {
      const raw = await json(["api", `repos/${repo}/commits/${head}/check-runs?per_page=100`]);
      if (!Array.isArray(raw.check_runs) || Number(raw.total_count) > raw.check_runs.length) throw new Error("check-runs 不全");
      return (raw.check_runs as Record<string, unknown>[]).map((c) => ({ name: String(c.name), status: String(c.status),
        conclusion: typeof c.conclusion === "string" ? c.conclusion : null }));
    },
    async run(repo, runId, attempt) {
      const raw = await json(["run", "view", String(runId), "--repo", repo, ...(attempt ? ["--attempt", String(attempt)] : []), "--json", "attempt,status,conclusion,headSha"]);
      if (!Number.isSafeInteger(raw.attempt) || typeof raw.headSha !== "string") throw new Error("gh run view 没给出 attempt / headSha");
      const n = raw.attempt as number;
      return { headSha: raw.headSha, attempt: n, status: String(raw.status), conclusion: String(raw.conclusion ?? ""),
        log: raw.conclusion === "failure" ? await main.failedLog(repo, runId, n) : null };
    },
    prFiles: (repo, pr) => rerun.prFiles(`https://github.com/${repo}/pull/${pr}`),
    async mainHead(repo) {
      const raw = await json(["api", `repos/${repo}/commits/main`]);
      if (typeof raw.sha !== "string") throw new Error("gh api 没给出 main 的 sha");
      return raw.sha.toLowerCase();
    },
    mainRuns: (repo, file, event) => main.runs(repo, file, event),
  };
}

/** 生产缺省；测试进程没注入就读不到（每个方法都抛 = 未定），永远不碰真实 GitHub */
export function defaultNoChangePort(): CiNoChangePort {
  if (!isTestProcess()) return ghNoChangePort();
  const no = async (): Promise<never> => { throw new Error("测试进程没有注入 CI 读口"); };
  return { headChecks: no, run: no, prFiles: no, mainHead: no, mainRuns: no };
}
