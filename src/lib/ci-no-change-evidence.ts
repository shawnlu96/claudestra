/**
 * CINOOP1 · noChange 交付的外部证据：接收端自己读 GitHub，不信交付方的自述。
 * - out_of_scope_ci：原失败 run 必须跑在交付 head 上且确实失败；失败日志按 ci-failure-class.ts 对 PR 实际改动分类，只认 known_flaky / timeout，
 *   且分类出的失败文件与交付方报的逐个相等（不凭 fileGlobs 或自述认定范围外）；文件范围外不等于无依赖影响，再按交付 head 的源码
 *   保守地走失败测试的导入闭包（dependencyImpact）：闭包碰到 PR 改动、PR 改了全局输入或闭包过大都拒；最后看同 head 最新的 required 检查是否全绿。
 * - main_already_resolved：当前 main 的准确 head、同一 workflow 最新的那一个 run（不跳过还在跑 / 取消的）必须跑在这个 head 上、完成且 success，
 *   且就是交付方给的那个 run；卡上没记起点 head 时，交付 head 还要在当前 main 的历史里（没有新增改动）。
 * 读失败 / 不全 / pending 一律「未定」（unavailable），对不上的是 invalid；这里只读不写。端口可注入，测试进程不碰真实 gh。
 * tests/ci-no-change-recovery.test.ts。
 */
import { classifyFailedLog } from "./ci-failure-class.js";
import { posix } from "node:path";
import type { MainRedRun } from "./main-red-fix.js";
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
  /** 这个 commit 的完整文件树（路径列表；被截断就抛） */
  tree(repo: string, head: string): Promise<string[]>;
  /** 这个 commit 上一个文件的正文 */
  fileText(repo: string, head: string, path: string): Promise<string>;
  /** ancestor 是否就是 head 或在 head 的历史里 */
  isAncestor(repo: string, ancestor: string, head: string): Promise<boolean>;
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

export interface OutOfScopeFacts { run: string; runId: number; attempt: number; files: string[]; required: string[]; checks: CheckRow[]; dependencyFiles: number }
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
  const dep = await dependencyImpact(port, want.repo, want.head, nc.files, files);
  if (!dep.ok) return dep;
  const checks = await guarded("同 head 的 CI ", () => port.headChecks(want.repo, want.head));
  if (failed(checks)) return checks;
  const g = ciGreen(checks, want.required);
  if (!g.green) return pending(`同 head 最新 CI 未全绿：${g.why}`);
  return { ok: true, facts: { run: nc.run, runId: ref.runId, attempt: run.attempt, files: [...nc.files], required: [...want.required], checks,
    dependencyFiles: dep.facts.reached } };
}

/** 改了这些就可能影响任何测试（依赖、配置、测试公共件、CI 本身）：不再逐个追导入，直接证明不了 */
const DEP_GLOBAL = /^(?:package\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|\.github\/|web\/package\.json|tests\/(?:setup|helpers?|fixtures|support|_)[^/]*)/;
/** import / export from / 动态 import / require 的说明符，以及源码里写成字面量的仓库路径（spawn 子进程、读夹具） */
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'`]([^"'`\n]+)["'`]/g;
const PATH_LIT = /["'`]((?:\.{1,2}\/|(?:src|tests|web|scripts)\/)[^"'`\s$]+?\.(?:[cm]?[jt]sx?|json))["'`]/g;
const DEP_FILES_MAX = 400;
const DEP_BATCH = 8;

/** 说明符 → 文件树里实际的那个文件（.js 写法对应 .ts 源码）；包名 / 树外 = null（包由 DEP_GLOBAL 管） */
function resolveSpec(from: string, spec: string, have: ReadonlySet<string>): string | null {
  const rel = spec.startsWith("./") || spec.startsWith("../");
  if (!rel && !/^(?:src|tests|web|scripts)\//.test(spec)) return null;
  const base = posix.normalize(rel ? posix.join(posix.dirname(from), spec) : spec);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${base}/index.ts`].find((f) => have.has(f)) ?? null;
}

function depsOf(from: string, text: string, have: ReadonlySet<string>): string[] {
  const specs = [...text.matchAll(SPEC), ...text.matchAll(PATH_LIT)].map((m) => m[1]!);
  return specs.map((s) => resolveSpec(from, s, have)).filter((f): f is string => f !== null);
}

/**
 * 「文件范围外」之外的依赖证明（保守）：从失败的测试文件出发，按交付 head 的源码走导入闭包；闭包里有 PR 改动的文件、或任一闭包文件的正文
 * 提到了改动文件的文件名（spawn / 拼路径读到它）都算可能有影响；PR 改了全局输入、闭包超过上限都证明不了。读不到 = 未定。
 */
export async function dependencyImpact(port: CiNoChangePort, repo: string, head: string, roots: readonly string[], changed: readonly string[]):
  Promise<Evidence<{ reached: number }>> {
  const global = changed.find((f) => DEP_GLOBAL.test(f));
  if (global) return invalid(`PR 改了全局输入 ${global}（依赖 / 配置 / 测试公共件），证明不了失败与改动无关`);
  const tree = await guarded("交付 head 的文件树", () => port.tree(repo, head));
  if (failed(tree)) return tree;
  const have = new Set(tree), touched = new Set(changed);
  const missing = roots.find((f) => !have.has(f));
  if (missing) return invalid(`失败文件 ${missing} 不在交付 head 的文件树里`);
  const seen = new Set<string>(), queue = [...roots], texts: string[] = [];
  while (queue.length) {
    const batch: string[] = [];
    while (queue.length && batch.length < DEP_BATCH) {
      const f = queue.shift()!;
      if (!seen.has(f)) { seen.add(f); batch.push(f); }
    }
    if (seen.size > DEP_FILES_MAX) return invalid(`失败测试的依赖闭包超过 ${DEP_FILES_MAX} 个文件，证明不了无依赖影响`);
    const read = await guarded("依赖文件", () => Promise.all(batch.map((f) => port.fileText(repo, head, f))));
    if (failed(read)) return read;
    batch.forEach((f, i) => { texts.push(read[i]!); queue.push(...depsOf(f, read[i]!, have)); });
  }
  const hit = [...seen].find((f) => touched.has(f));
  if (hit) return invalid(`失败测试的导入闭包包含 PR 改动的 ${hit}：可能是改动引起的，不算范围外`);
  const named = changed.find((c) => { const b = posix.basename(c); return texts.some((t) => t.includes(b) || t.includes(b.replace(/\.tsx?$/, ".js"))); });
  if (named) return invalid(`失败测试的依赖里提到了 PR 改动的 ${named}（子进程 / 拼路径），证明不了无依赖影响`);
  return { ok: true, facts: { reached: seen.size } };
}

export interface MainResolvedFacts { mainHead: string; mainRunId: number; mainRun: string; workflow: string }
/** start = 卡 / 订单记下的起点 head；null（没记）时交付 head 必须在当前 main 的历史里 */
export interface MainResolvedWant { repo: string; workflowFile: string; event: string | null; sourceRunId: number; head: string; start: string | null }
/** 最新的那一个 run（按创建时间，同时刻按 id）：还在跑 / 取消 / 跳过的也算，不往回找更旧的绿 */
const newestRun = (runs: readonly MainRedRun[]): MainRedRun | null => [...runs].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)[0] ?? null;

export async function readMainResolved(port: CiNoChangePort, want: MainResolvedWant, nc: MainAlreadyResolved): Promise<Evidence<MainResolvedFacts>> {
  const src = runRef(nc.sourceRun)!, green = runRef(nc.mainRun)!;
  if (src.repo !== want.repo.toLowerCase()) return invalid(`run 链接的仓库 ${src.repo} 不是这张卡的 ${want.repo}`);
  if (src.runId !== want.sourceRunId) return invalid(`sourceRun 是 run ${src.runId}，这张卡的 MAINRED1 来源是 run ${want.sourceRunId}`);
  const head = await guarded("当前 main head ", () => port.mainHead(want.repo));
  if (failed(head)) return head;
  if (!SHA40.test(head) || head !== nc.mainHead) return invalid(`当前 main 是 ${String(head).slice(0, 12)}，不是交付给的 ${nc.mainHead.slice(0, 12)}：按最新 main 重交`);
  const runs = await guarded("main 的 run 列表", () => port.mainRuns(want.repo, want.workflowFile, want.event));
  if (failed(runs)) return runs;
  const latest = newestRun(runs);
  if (!latest || latest.headSha !== head) return pending(`${want.workflowFile} 在当前 main ${head.slice(0, 12)} 上还没有结论`);
  if (latest.status !== "completed") return pending(`${want.workflowFile} 最新的 run ${latest.id} 还没有结论（${latest.status}）`);
  if (latest.conclusion === "failure") return invalid(`${want.workflowFile} 在当前 main 上最新的结论是 failure`);
  if (latest.conclusion !== "success") return pending(`${want.workflowFile} 最新的 run ${latest.id} 结论是 ${latest.conclusion ?? "空"}，不是绿`);
  if (latest.id !== green.runId) return invalid(`当前 main 上最新的绿 run 是 ${latest.id}，不是交付给的 ${green.runId}`);
  if (want.start === null) {
    const inMain = await guarded("交付 head 与 main 的关系", () => port.isAncestor(want.repo, want.head, head));
    if (failed(inMain)) return inMain;
    if (!inMain) return invalid(`交付 head ${want.head.slice(0, 12)} 不在当前 main 的历史里：有新增改动，不是无需改码`);
  } else if (want.start !== want.head) return invalid("交付 head 不是订单起点");
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
    async tree(repo, head) {
      const raw = await json(["api", `repos/${repo}/git/trees/${head}?recursive=1`]);
      if (!Array.isArray(raw.tree) || raw.truncated !== false) throw new Error("文件树被截断或格式不对");
      return (raw.tree as Record<string, unknown>[]).filter((e) => e.type === "blob").map((e) => String(e.path));
    },
    async fileText(repo, head, path) {
      const r = await command(["gh", "api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path}?ref=${head}`], { env: ENV(), timeoutMs: 60_000 });
      if (r.code !== 0 || r.timedOut || r.truncated) throw new Error(`读不到 ${path}：${r.stderr.trim().split("\n")[0]?.slice(0, 200) ?? ""}`);
      return r.stdout;
    },
    async isAncestor(repo, ancestor, head) {
      const raw = await json(["api", `repos/${repo}/compare/${ancestor}...${head}`]);
      if (typeof raw.status !== "string") throw new Error("gh api compare 没给出 status");
      return raw.status === "identical" || raw.status === "ahead";
    },
  };
}

/** 生产缺省；测试进程没注入就读不到（每个方法都抛 = 未定），永远不碰真实 GitHub */
export function defaultNoChangePort(): CiNoChangePort {
  if (!isTestProcess()) return ghNoChangePort();
  const no = async (): Promise<never> => { throw new Error("测试进程没有注入 CI 读口"); };
  return { headChecks: no, run: no, prFiles: no, mainHead: no, mainRuns: no, tree: no, fileText: no, isAncestor: no };
}
