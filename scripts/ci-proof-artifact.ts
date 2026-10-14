// 全量 CI 的覆盖证明工件（merge-arch-FULL1，ci.yml）。三个用法，都由 workflow 调：
//   bun scripts/ci-proof-artifact.ts shard-facts <k> <shard.log> <输出>       分片作业末尾：记下这一片属于哪次 run / attempt、日志摘要、核心步骤结果
//   bun scripts/ci-proof-artifact.ts web-build <输出>                         按 CI_WEB_BUILD（off / observe / on）跑 web 生产构建并记结果
//   bun scripts/ci-proof-artifact.ts prove <分片目录> <事实目录> <输出目录>    汇总：全部成立才写 manifest.json（full 证明），否则只写 report.json
// 覆盖核对只调 scripts/ci-test-shard.ts 的 verifyShards，manifest 格式只用 src/lib/ci-proof-manifest.ts。除了 on 模式下构建失败都以 0 退出
// （新作业红了列车就退车）；脚本管不到的准备步骤与超时由 ci.yml 每一步的容错和时限兜住。tests/ci-proof-artifact.test.ts。
// 串行 / 人工队列的 full 补验（merge-arch-SELECT1 的 workflow_dispatch，在 main 上触发、检出请求绑定的测试合并提交）：只有请求的
// request_id 就是它绑定内容的摘要、且证明作业检出的正是 inputs.merge 与 inputs.tree 时，才按「被测的是那个合并提交」写证明
// （merge-arch-GATE1）；别的「检出 ≠ GITHUB_SHA」一律照旧拒绝。
// 责任选集放行（merge-arch-CISEL1，src/lib/ci-selected-verdict.ts）：分片事实带上本片的放行回执；有片按回执放行时，回执汇成带版本号的一节
// （输出目录的 selected.json），它的 digest 写进 manifest.policyVersion 的后缀，「实际覆盖全集」的证据照旧。成功结束却红过的片缺回执、
// 回执对不上就没有证明。没有放行的证明与改前逐字一致。tests/ci-proof-selected.test.ts。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../src/lib/canonical-json.ts";
import { type CiProofManifest, CI_PROOF_MANIFEST_VERSION, ciProofManifestDigest, parseCiProofManifest } from "../src/lib/ci-proof-manifest.ts";
import {
  CI_WEB_BUILD_BUDGET, CI_WEB_BUILD_CHECK, CI_WEB_BUILD_OUTCOMES, type CiWebBuildMode, type CiWebBuildOutcome, ciWebBuildMode, judgeCiWebBuild,
} from "../src/lib/ci-web-build-policy.ts";
import {
  hasBunFailures, parseReceipt, receiptDigest, receiptProblems, type SelectedSection, SELECTED_SECTION_VERSION, sectionDigest, selectedPolicyVersion,
  type ShardReceipt,
} from "../src/lib/ci-selected-verdict.ts";
import { fullRequestId } from "../src/lib/scheduler-ci-full-request.ts";
import { parseSlowList, testFiles, verifyShards, withoutSlow } from "./ci-test-shard.ts";

const SHARDS = 8;
const FACTS_VERSION = 1;
const FACTS_FILE = "job-facts.json";
const SLOW_LIST = "tests/slow-tests.txt";
/** 这份脚本判 full 的规则版本；规则变了改这里，合并侧按它认证明。 */
export const CI_PROOF_POLICY_VERSION = "ci-full-1";
/** ci.yml 里证明要等的作业（id → GitHub 上的检查名）；全部 success 才可能有 full 证明，名字写进 manifest.checks。 */
export const PROOF_JOBS: Readonly<Record<string, readonly string[]>> = {
  tests: Array.from({ length: SHARDS }, (_, i) => `test shard ${i + 1} of ${SHARDS}`),
  check: ["typecheck + test + guard"],
  web: ["web typecheck + lint"],
  desktop: ["desktop typecheck + cargo test"],
};
/** web 生产构建的作业 id；它的检查名是 CI_WEB_BUILD_CHECK。 */
export const WEB_BUILD_JOB = "web-build";
const CORE_STEPS = ["typecheck", "guard", "build"] as const;
const CORE_LABEL: Record<(typeof CORE_STEPS)[number], string> = { typecheck: "typecheck", guard: "guard", build: "入口构建" };
const shardFactsName = (k: number) => `ci-facts-shard-${k}`;
const WEB_FACTS_NAME = "ci-facts-web-build";

const SHA = /^[0-9a-f]{40}$/;
export const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** 一个作业自己写下的事实：哪次 run、第几次 attempt、检出的 head、到这一步为止的作业状态。 */
interface JobFacts { version: number; job: string; runId: number; attempt: number; head: string; status: string }
export interface ShardFacts extends JobFacts { logDigest: string; core?: Record<(typeof CORE_STEPS)[number], string>; selected?: unknown }
export interface WebBuildFacts extends JobFacts { webBuild: { mode: CiWebBuildMode; outcome: CiWebBuildOutcome; seconds: number; depsCacheHit: boolean } }

/** 每个作业都在 Actions 里读同一组环境变量；读不出合法值就抛，调用方记警告、不写事实（之后证明因缺事实而拒）。 */
function jobFacts(env: Obj, job: string, status: string): JobFacts {
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT), head = String(env.GITHUB_SHA ?? "");
  if (!posInt(runId) || !posInt(attempt) || !SHA.test(head)) throw new Error("GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT / GITHUB_SHA 不是合法值");
  return { version: FACTS_VERSION, job, runId, attempt, head, status };
}

/** receipt：本片的放行回执（scripts/ci-selected-verdict.ts 写的 receipt.json 解出来的值）；没有就不带这个字段，事实与改前一致。 */
export function shardFacts(env: Obj, k: number, log: string, receipt?: unknown): ShardFacts {
  const core = k === 1 ? { core: { typecheck: String(env.CORE_TYPECHECK ?? ""), guard: String(env.CORE_GUARD ?? ""), build: String(env.CORE_BUILD ?? "") } } : {};
  return { ...jobFacts(env, `test-shard-${k}`, String(env.JOB_STATUS ?? "")), logDigest: sha256(log), ...core, ...(receipt === undefined ? {} : { selected: receipt }) };
}

/** 事实工件的公共字段是否属于这次 run 的这次 attempt；返回问题（空 = 是）。重跑前留下的工件 attempt 对不上，在这里被拒。 */
function factsProblems(name: string, raw: unknown, job: string, run: ProofRun): string[] {
  if (raw === undefined) return [`缺少工件 ${name}`];
  if (!isObj(raw) || raw.version !== FACTS_VERSION || raw.job !== job) return [`${name} 不是 ${job} 的事实（版本 ${FACTS_VERSION}）`];
  if (!posInt(raw.runId) || !posInt(raw.attempt) || typeof raw.head !== "string") return [`${name} 的 runId / attempt / head 非法`];
  const out: string[] = [];
  if (raw.runId !== run.runId || raw.attempt !== run.attempt) out.push(`${name} 来自 run ${raw.runId} attempt ${raw.attempt}，不是本次 run ${run.runId} attempt ${run.attempt}`);
  if (raw.head !== run.sha) out.push(`${name} 的 head ${raw.head.slice(0, 12)} ≠ 本次检出 ${run.sha.slice(0, 12)}`);
  if (raw.status !== "success") out.push(`${name} 记录的作业状态 ${String(raw.status)} 不是 success`);
  return out;
}

/** 受信的运行元数据：全部来自 runner 给作业的环境与事件，不取自任何工件。 */
export interface ProofRun {
  repo: string; runId: number; attempt: number;
  /** 作业检出的提交（GITHUB_SHA：PR 是 merge ref，push 是推上来的提交）。 */
  sha: string;
  workflowRef: string; workflowSha: string;
  /** 合并对象：PR 的 head / base，push 的提交与推送前的 before；补验是请求里的 PR head 与 main。 */
  head: string; base: string;
  /** 只有绑定核得上的 SELECT1 补验才有：各作业按请求检出的测试合并提交与它的 tree（此时 sha 是触发补验的 main，不是被测内容）。 */
  tested?: { sha: string; tree: string };
}

export interface ProofInput {
  run: ProofRun;
  /** 证明作业自己检出后读到的提交与 tree。 */
  checkout: { sha: string; tree: string };
  bunVersion: string;
  /** bun.lock 的内容。 */
  lockfile: string;
  /** 入库的测试文件（testFiles(git ls-files)）。 */
  files: string[];
  /** 慢清单（tests/slow-tests.txt，夜间跑）；不给 = 空。证明的测试全集 = files 减去它，与分片覆盖核对同一口径。 */
  slow?: string[];
  /** 作业 id → needs.<id>.result。 */
  needs: Readonly<Record<string, string>>;
  /** 工件名 → shard.log。 */
  shardLogs: Map<string, string>;
  /** 工件名 → job-facts.json 解出来的值。 */
  facts: Map<string, unknown>;
  webBuildMode: CiWebBuildMode;
}

export interface ProofReport {
  version: number; runId: number; attempt: number; checkout: string;
  verdict: "full" | "refused";
  manifestDigest: string | null;
  /** 为什么没有 full 证明（空 = 有）。 */
  refusals: string[];
  webBuild: { mode: CiWebBuildMode; outcome: CiWebBuildOutcome | null; seconds: number | null; depsCacheHit: boolean | null; wouldReject: string | null };
  /** 只在有片按回执放行时出现：一节的版本与 digest（内容在 selected.json，digest 同 manifest.policyVersion 的后缀） */
  selected?: { version: string; digest: string };
}

const GROUP = /^::group::(.+):$/;
/** 各片日志里跑过的测试文件，去重排序（verifyShards 已核不漏不重，这里只取实际跑过的集合给 selectedDigest）。 */
const ranFiles = (logs: Map<string, string>): string[] =>
  [...new Set([...logs.values()].flatMap((log) => log.split("\n").flatMap((l) => GROUP.exec(l)?.[1] ?? [])))].sort();
const listDigest = (files: string[]) => sha256(files.join("\n"));

/** 每片的事实属于本次 attempt、日志就是那份事实记下的日志；第 1 片另核 typecheck / guard / 入口构建三步都 success。 */
function shardProblems(input: ProofInput): string[] {
  const out: string[] = [];
  for (let k = 1; k <= SHARDS; k++) {
    const name = shardFactsName(k), raw = input.facts.get(name);
    const problems = factsProblems(name, raw, `test-shard-${k}`, input.run);
    out.push(...problems);
    if (problems.length && !isObj(raw)) continue;
    const f = raw as Obj, log = input.shardLogs.get(`test-shard-${k}`);
    if (log === undefined || f.logDigest !== sha256(log)) out.push(`${name} 记录的日志摘要与工件 test-shard-${k} 不符（日志不是这次 attempt 的）`);
    if (k !== 1) continue;
    for (const step of CORE_STEPS) {
      const got = isObj(f.core) ? f.core[step] : undefined;
      if (got !== "success") out.push(`${CORE_LABEL[step]} 步骤结果 ${typeof got === "string" && got ? got : "未知"}，不是 success`);
    }
  }
  return out;
}

/** web 构建这次 attempt 的结果；事实缺了、不属于本次或值不认识都读作 null（on 下即拒）。 */
function readWebBuild(input: ProofInput): { facts: WebBuildFacts["webBuild"] | null; problems: string[] } {
  const raw = input.facts.get(WEB_FACTS_NAME);
  const problems = factsProblems(WEB_FACTS_NAME, raw, WEB_BUILD_JOB, input.run);
  const w = isObj(raw) && isObj(raw.webBuild) ? raw.webBuild : null;
  if (!w || !CI_WEB_BUILD_OUTCOMES.includes(w.outcome as CiWebBuildOutcome) || typeof w.seconds !== "number" || typeof w.depsCacheHit !== "boolean") {
    return { facts: null, problems: problems.length ? problems : [`${WEB_FACTS_NAME} 的 webBuild 字段非法`] };
  }
  if (w.mode !== input.webBuildMode) problems.push(`${WEB_FACTS_NAME} 按 ${String(w.mode)} 模式跑的，证明作业读到的是 ${input.webBuildMode}`);
  const facts = { mode: ciWebBuildMode(w.mode), outcome: w.outcome as CiWebBuildOutcome, seconds: w.seconds, depsCacheHit: w.depsCacheHit };
  return { facts: problems.length ? null : facts, problems };
}

/** workflow 文件路径：GITHUB_WORKFLOW_REF 是 `<owner>/<repo>/<路径>@<ref>`。 */
const workflowPath = (run: ProofRun) => (run.workflowRef.startsWith(`${run.repo}/`) ? run.workflowRef.slice(run.repo.length + 1) : run.workflowRef).split("@")[0]!;

/**
 * 放行了的片 = 日志里 bun 红过（「N fail」，N > 0）的片，加上事实里带 applied 回执的片。每片都要有本次 run / attempt / 检出 / 这份日志的回执，
 * 全部出自同一份责任选集；都成立才汇成一节。没有放行的片：section 为 null、没有问题。
 */
export function selectedSectionOf(input: ProofInput, tested: string): { section: SelectedSection | null; problems: string[] } {
  const problems: string[] = [], ok: ShardReceipt[] = [];
  for (let k = 1; k <= SHARDS; k++) {
    const f = input.facts.get(shardFactsName(k)), log = input.shardLogs.get(`test-shard-${k}`), raw = isObj(f) ? f.selected : undefined;
    if (!(log !== undefined && hasBunFailures(log)) && !parseReceipt(raw)?.applied) continue;
    const bad = receiptProblems(raw, { shard: k, runId: input.run.runId, attempt: input.run.attempt, head: tested, log });
    if (bad.length) problems.push(...bad);
    else ok.push(parseReceipt(raw)!);
  }
  const digests = [...new Set(ok.map((r) => r.responsibilityDigest))];
  if (digests.length > 1) problems.push(`各片放行回执的责任选集不一致：${digests.join(", ")}`);
  if (problems.length || !ok.length || !digests[0]) return { section: null, problems };
  return { section: { version: SELECTED_SECTION_VERSION, runId: input.run.runId, attempt: input.run.attempt, head: tested, responsibilityDigest: digests[0],
    receipts: ok.map((r) => ({ shard: r.shard, digest: receiptDigest(r), receipt: r })) }, problems };
}

function manifestOf(input: ProofInput, checks: string[], policyVersion: string): CiProofManifest {
  const covered = withoutSlow(input.files, input.slow ?? []).sort(), universe = listDigest(covered);
  return {
    version: CI_PROOF_MANIFEST_VERSION, repo: input.run.repo, head: input.run.head, base: input.run.base,
    checkout: { ...input.checkout }, workflow: { path: workflowPath(input.run), sha: input.run.workflowSha },
    policyVersion, toolchain: { bun: input.bunVersion, lockfileDigest: sha256(input.lockfile) },
    tests: { universeDigest: universe, selectedDigest: listDigest(ranFiles(input.shardLogs)), count: covered.length },
    scope: "full", checks,
  };
}

/**
 * 汇总判定（纯函数）。任何一条不成立都没有 manifest：必需作业没全 success、分片覆盖核对不过（verifyShards）、某片或核心步骤的事实
 * 不属于本次 attempt、检出不是这次 run 的提交、on 模式下 web 构建没成功。observe 下 web 构建失败只进 webBuild.wouldReject。
 */
export function buildCiProof(input: ProofInput): { manifest: CiProofManifest | null; report: ProofReport; selected: SelectedSection | null } {
  const { run } = input, refusals: string[] = [], tested = run.tested?.sha ?? run.sha;
  for (const [job, names] of Object.entries(PROOF_JOBS)) {
    if (input.needs[job] !== "success") refusals.push(`作业 ${names.length > 1 ? job : names[0]} 结果 ${input.needs[job] ?? "未知"}，不是 success`);
  }
  if (input.checkout.sha !== tested) refusals.push(`证明作业检出 ${input.checkout.sha.slice(0, 12)} ≠ 本次 run 的 ${tested.slice(0, 12)}`);
  if (run.tested && input.checkout.tree !== run.tested.tree) refusals.push(`证明作业检出的 tree ${input.checkout.tree.slice(0, 12)} ≠ 补验请求绑定的 ${run.tested.tree.slice(0, 12)}`);
  refusals.push(...verifyShards(input.shardLogs, { n: SHARDS, head: tested, bunVersion: input.bunVersion, files: input.files, slow: input.slow }));
  refusals.push(...shardProblems(input));
  const selected = selectedSectionOf(input, tested);
  refusals.push(...selected.problems);
  const known = [WEB_FACTS_NAME, ...Array.from({ length: SHARDS }, (_, i) => shardFactsName(i + 1))];
  const extra = [...input.facts.keys()].filter((n) => !known.includes(n));
  if (extra.length) refusals.push(`多出来的事实工件：${extra.join(", ")}`);

  const web = input.webBuildMode === "off" ? { facts: null, problems: [] } : readWebBuild(input);
  // 事实说成功而作业本身不是 success 的，不算有结果
  const jobOk = input.needs[WEB_BUILD_JOB] === "success";
  const outcome = !web.facts || (web.facts.outcome === "success" && !jobOk) ? null : web.facts.outcome;
  const verdict = judgeCiWebBuild(input.webBuildMode, outcome);
  const detail = web.problems.length ? web.problems.join("；") : jobOk ? "" : `作业结果 ${input.needs[WEB_BUILD_JOB] ?? "未知"}`;
  if (verdict.blocksProof) refusals.push(`${CI_WEB_BUILD_CHECK}（on）：${[outcome ? `结果 ${outcome}` : "没有本次运行的成功结果", detail].filter(Boolean).join("；")}`);
  const wouldReject = verdict.wouldReject === null ? null : [verdict.wouldReject, detail].filter(Boolean).join("；");

  let manifest: CiProofManifest | null = null;
  if (!refusals.length) {
    const checks = [...Object.values(PROOF_JOBS).flat(), ...(verdict.inProof ? [CI_WEB_BUILD_CHECK] : [])];
    const policy = selected.section ? selectedPolicyVersion(CI_PROOF_POLICY_VERSION, sectionDigest(selected.section)) : CI_PROOF_POLICY_VERSION;
    const parsed = parseCiProofManifest(manifestOf(input, checks, policy));
    if (parsed.ok) manifest = parsed.manifest;
    else refusals.push(parsed.reason);
  }
  const report: ProofReport = {
    version: FACTS_VERSION, runId: run.runId, attempt: run.attempt, checkout: tested, verdict: manifest ? "full" : "refused",
    manifestDigest: manifest ? ciProofManifestDigest(manifest) : null, refusals,
    webBuild: { mode: input.webBuildMode, outcome: web.facts?.outcome ?? null, seconds: web.facts?.seconds ?? null, depsCacheHit: web.facts?.depsCacheHit ?? null, wouldReject },
    ...(manifest && selected.section ? { selected: { version: SELECTED_SECTION_VERSION, digest: sectionDigest(selected.section) } } : {}),
  };
  return { manifest, report, selected: manifest ? selected.section : null };
}

export type RunCommand = (cmd: string[], cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean }>;
/** 用户装网页走的同一组命令（setup.ts：npm install、npm run build），各自有限时。 */
const WEB_BUILD_COMMANDS: readonly { cmd: string[]; minutes: number }[] = [
  { cmd: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], minutes: CI_WEB_BUILD_BUDGET.installMinutes },
  { cmd: ["npm", "run", "build"], minutes: CI_WEB_BUILD_BUDGET.buildMinutes },
];

/** off 不跑；否则依次跑两条命令，任一条非 0 / 超时即止；都过了还要导出目录里真有 index.html。 */
export async function runWebBuild(mode: CiWebBuildMode, deps: { run: RunCommand; now(): number; exported(): boolean; webDir: string }):
  Promise<{ outcome: CiWebBuildOutcome; seconds: number; failed: string | null }> {
  if (mode === "off") return { outcome: "skipped", seconds: 0, failed: null };
  const start = deps.now(), seconds = () => Math.round((deps.now() - start) / 1000);
  for (const { cmd, minutes } of WEB_BUILD_COMMANDS) {
    const r = await deps.run(cmd, deps.webDir, minutes * 60_000);
    if (r.timedOut) return { outcome: "timeout", seconds: seconds(), failed: `${cmd.join(" ")} 超过 ${minutes} 分钟` };
    if (r.code !== 0) return { outcome: "failure", seconds: seconds(), failed: `${cmd.join(" ")} 退出码 ${r.code ?? "无"}` };
  }
  return deps.exported() ? { outcome: "success", seconds: seconds(), failed: null } : { outcome: "failure", seconds: seconds(), failed: "构建后没有 web/out/index.html" };
}

/** 日志解析认的固定一行（PM 看 observe 样本用）：模式、结果、耗时、依赖缓存是否命中、observe 下是否拟拒绝。 */
export function webBuildNotice(mode: CiWebBuildMode, r: { outcome: CiWebBuildOutcome; seconds: number }, depsCacheHit: boolean): string {
  const would = judgeCiWebBuild(mode, r.outcome).wouldReject ? 1 : 0;
  return `::notice title=ci-web-build::mode=${mode} outcome=${r.outcome} seconds=${r.seconds} deps-cache=${depsCacheHit ? "hit" : "miss"} would-reject=${would}`;
}

const spawnCommand: RunCommand = async (cmd, cwd, timeoutMs) => {
  let timedOut = false;
  try {
    const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, timedOut };
  } catch (e) {
    // 命令起不来（没有 npm 等）就是一次构建失败，由模式决定红不红
    console.log(`::warning title=ci-web-build::${cmd.join(" ")} 起不来：${(e as Error).message}`);
    return { code: null, timedOut };
  }
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

async function webBuildMain(out: string, env: Obj): Promise<number> {
  const mode = ciWebBuildMode(env.CI_WEB_BUILD), depsCacheHit = env.DEPS_CACHE_HIT === "true", webDir = join(process.cwd(), "web");
  const r = await runWebBuild(mode, { run: spawnCommand, now: Date.now, exported: () => existsSync(join(webDir, "out", "index.html")), webDir });
  const blocked = judgeCiWebBuild(mode, r.outcome).blocksProof;
  console.log(webBuildNotice(mode, r, depsCacheHit));
  if (r.failed) console.log(`::${blocked ? "error" : "warning"} title=ci-web-build::${r.failed}${blocked ? "" : "（observe：只记录，不影响合并）"}`);
  try {
    const facts: WebBuildFacts = { ...jobFacts(env, WEB_BUILD_JOB, blocked ? "failure" : "success"), webBuild: { mode, outcome: r.outcome, seconds: r.seconds, depsCacheHit } };
    writeJson(out, facts);
  } catch (e) {
    // 事实写不出只少一份结果（on 下证明因缺它而拒），退出码照旧只看构建本身
    console.log(`::warning title=ci-web-build::构建结果没记下：${(e as Error).message}`);
  }
  return blocked ? 1 : 0;
}

/** 下载目录里每个工件一个子目录，各取其中一个文件；没有那个文件的工件不进结果（之后按缺工件拒）。 */
function readArtifacts(dir: string, file: string): Map<string, string> {
  if (!existsSync(dir)) return new Map();
  return new Map(readdirSync(dir).flatMap((name) => {
    const path = join(dir, name, file);
    return existsSync(path) ? [[name, readFileSync(path, "utf8")] as const] : [];
  }));
}

/** 坏 JSON 读作 null：factsProblems 按「不是事实」拒，不会被当成缺省值放行。 */
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function git(args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败`);
  return r.stdout.toString().trim();
}

/**
 * SELECT1 补验请求（workflow_dispatch 的 inputs）绑定的内容；request_id 不是这组内容的摘要（scheduler-ci-full-request.ts fullRequestId，
 * 调度器派发时算的同一个）、或哪个 SHA 不完整，就不是补验请求，读作 null。
 */
function fullRequest(repo: string, inputs: unknown): { head: string; base: string; merge: string; tree: string } | null {
  if (!isObj(inputs)) return null;
  const [head, base, merge, tree] = ["head", "base", "merge", "tree"].map((k) => String(inputs[k] ?? ""));
  if (![head, base, merge, tree].every((x) => SHA.test(x!)) || !/^[1-9]\d*$/.test(String(inputs.pr ?? ""))) return null;
  const subject = { repo, pr: Number(inputs.pr), head: head!, base: base!, merge: merge!, tree: tree! };
  return fullRequestId(subject) === inputs.request_id ? subject : null;
}

/**
 * 合并对象取自触发事件：pull_request 用事件里的 PR head / base，push 用推上来的提交与 before；绑定核得上的 SELECT1 补验用请求里的
 * PR head 与 main，并记下被测的合并提交。其余 workflow_dispatch 与 push 同样处理（检出 ≠ GITHUB_SHA 时照旧被拒）。
 */
export function proofRun(env: Obj, event: unknown): ProofRun {
  const e = isObj(event) ? event : {}, pr = isObj(e.pull_request) ? e.pull_request : null;
  const shaOf = (v: unknown) => (isObj(v) && typeof v.sha === "string" ? v.sha : "");
  const sha = String(env.GITHUB_SHA ?? ""), repo = String(env.GITHUB_REPOSITORY ?? "");
  const req = pr || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ? null : fullRequest(repo, e.inputs);
  return {
    repo, runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), sha,
    workflowRef: String(env.GITHUB_WORKFLOW_REF ?? ""), workflowSha: String(env.GITHUB_WORKFLOW_SHA ?? ""),
    head: req ? req.head : pr ? shaOf(pr.head) : sha, base: req ? req.base : pr ? shaOf(pr.base) : typeof e.before === "string" ? e.before : "",
    ...(req ? { tested: { sha: req.merge, tree: req.tree } } : {}),
  };
}

/** desktop 作业按范围没有真跑（merge-arch-CIDESK1：结论是 success，但没写 ran=true）时的结果；不是 success，证明照常拒。 */
export const DESKTOP_NOT_RUN = "无需运行";

/**
 * `toJSON(needs)` → 作业 id → 结果。desktop 的 success 只有在它导出 ran="true"（真在 macOS 上跑完）时才算数；按范围跳过的那条
 * success 记成「无需运行」，buildCiProof 因它不是 success 而拒。其他作业照原样。
 */
export function proofNeeds(raw: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(isObj(raw) ? raw : {}).map(([job, v]) => {
    const result = isObj(v) ? String(v.result) : "";
    const ran = isObj(v) && isObj(v.outputs) ? v.outputs.ran : undefined;
    return [job, job === "desktop" && result === "success" && ran !== "true" ? DESKTOP_NOT_RUN : result];
  }));
}

function proveMain(shardsDir: string, factsDir: string, outDir: string, env: Obj): void {
  const event = typeof env.GITHUB_EVENT_PATH === "string" && existsSync(env.GITHUB_EVENT_PATH) ? parseJson(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : null;
  const { manifest, report, selected } = buildCiProof({
    run: proofRun(env, event), checkout: { sha: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) },
    bunVersion: Bun.version, lockfile: readFileSync("bun.lock", "utf8"), files: testFiles(git(["ls-files"])), needs: proofNeeds(parseJson(String(env.NEEDS ?? ""))),
    slow: existsSync(SLOW_LIST) ? parseSlowList(readFileSync(SLOW_LIST, "utf8")) : [],
    shardLogs: readArtifacts(shardsDir, "shard.log"),
    facts: new Map([...readArtifacts(factsDir, FACTS_FILE)].map(([name, text]) => [name, parseJson(text)])),
    webBuildMode: ciWebBuildMode(env.CI_WEB_BUILD),
  });
  writeJson(join(outDir, "report.json"), report);
  if (manifest) writeJson(join(outDir, "manifest.json"), manifest);
  if (selected) writeJson(join(outDir, "selected.json"), selected);
  report.refusals.forEach((r) => console.log(`::warning title=ci-proof::${r}`));
  if (report.webBuild.wouldReject) console.log(`::warning title=ci-web-build::拟拒绝（observe，不影响合并）：${report.webBuild.wouldReject}`);
  console.log(manifest ? `::notice title=ci-proof::full ${report.manifestDigest} run ${report.runId} attempt ${report.attempt}`
    : `::notice title=ci-proof::refused run ${report.runId} attempt ${report.attempt}：没有 full 证明（${report.refusals.length} 条原因）`);
}

async function main(args: string[]): Promise<number> {
  const [cmd, a, b, c] = args;
  if (cmd === "web-build" && a) return webBuildMain(a, process.env);
  try {
    if (cmd === "shard-facts" && new RegExp(`^[1-${SHARDS}]$`).test(a ?? "") && b && c) {
      const receipt = process.env.SELECTED_RECEIPT && existsSync(process.env.SELECTED_RECEIPT) ? parseJson(readFileSync(process.env.SELECTED_RECEIPT, "utf8")) : undefined;
      writeJson(c, shardFacts(process.env, Number(a), existsSync(b) ? readFileSync(b, "utf8") : "", receipt));
    }
    else if (cmd === "prove" && a && b && c) proveMain(a, b, c, process.env);
    else console.log("::warning title=ci-proof::用法：shard-facts <k> <shard.log> <输出> | web-build <输出> | prove <分片目录> <事实目录> <输出目录>");
  } catch (e) {
    // 记事实 / 汇总出错只少一份证明（之后按缺工件拒），不能把本来绿的作业变红
    console.log(`::warning title=ci-proof::${cmd} 没完成，不产出证明：${(e as Error).message}`);
  }
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
