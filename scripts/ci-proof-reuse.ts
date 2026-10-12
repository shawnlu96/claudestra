// CI 证明复用（merge-arch-REUSE1，ci.yml 第 1 片的 typecheck 与入口打包两步）。用法：
//   bun scripts/ci-proof-reuse.ts run <检查> <输出目录>     按 CI_PROOF_REUSE（off / observe / on）决定这一步是实际执行还是复用
// 要跑的命令取自 src/lib/ci-proof-reuse.ts 的 CI_REUSE_CHECKS（不从参数拿，命令本身进 key）。off：不查，直接执行。observe（缺省）：查候选、
// 照常执行，只在固定的一行 notice 里记拟命中。on：候选核过（lib 的 decideCiReuse）才跳过执行，并在 <输出目录>/receipts 写指向原 run 的回执。
// 查询 / 下载 / 解包 / 算输入任何一步出错都只是未命中，回到实际执行；实际执行成功后在 <输出目录>/record-<检查> 写本次的记录供以后复用，
// 失败、取消、跳过都不留记录。退出码只来自实际执行的命令。tests/ci-proof-reuse.test.ts。
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../src/lib/canonical-json.ts";
import {
  CI_PROOF_REUSE_WORKFLOW, CI_REUSE_CHECKS, CI_REUSE_GUARD_BASELINE, CI_REUSE_LOCKFILES, type CiProofReuseMode, type CiReuseDecision, type CiReuseInputs,
  type CiReuseOrigin, type CiReuseRecord, CI_PROOF_REUSE_POLICY, ciProofReuseMode, ciReuseArtifactName, ciReuseCommandDigest, ciReuseDigest, ciReuseKey,
  decideCiReuse, parseCiReuseRecord,
} from "../src/lib/ci-proof-reuse.ts";

/** 一次查询最多核这么多个同名工件（新的在前）；再多说明有人在刷同一个 key，不值得为它花 runner 时间。 */
const MAX_CANDIDATES = 3;
const API_TIMEOUT_MS = 20_000;
const RECORD_FILE = "record.json";
/** 回执目录里的标记文件：写这个目录的 run / attempt。 */
export const RUN_FILE = "run.json";
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export interface InputFacts {
  env: Record<string, string | undefined>;
  git(...args: string[]): string;
  /** 工作区里的文件内容；读不到就抛。 */
  read(path: string): string;
  bun: string;
  node: string;
}

/** 本次运行这一项检查的全部输入；任何一项读不出就抛（调用方按未命中处理，不留记录）。 */
export function localInputs(check: string, f: InputFacts): CiReuseInputs {
  const def = Object.hasOwn(CI_REUSE_CHECKS, check) ? CI_REUSE_CHECKS[check]! : null;
  if (!def) throw new Error(`检查 ${check} 不在批准的复用范围`);
  const need = (name: string) => { const v = f.env[name]; if (!v) throw new Error(`缺环境变量 ${name}`); return v; };
  const digest = (path: string) => ({ path, digest: ciReuseDigest(f.read(path)) });
  return {
    policy: CI_PROOF_REUSE_POLICY, repo: need("GITHUB_REPOSITORY"), tree: f.git("rev-parse", "HEAD^{tree}").trim(), base: need("REUSE_BASE"),
    guardBaseline: digest(CI_REUSE_GUARD_BASELINE).digest, workflow: digest(CI_PROOF_REUSE_WORKFLOW),
    check: { id: check, scope: def.scope, command: ciReuseCommandDigest(def) }, toolchain: { bun: f.bun, node: f.node },
    lockfiles: CI_REUSE_LOCKFILES.map(digest), platform: { os: need("RUNNER_OS"), arch: need("RUNNER_ARCH"), image: `${need("ImageOS")}:${need("ImageVersion")}` },
    generated: def.generated.map(digest),
  };
}

export interface OriginDeps {
  /** GET <api>/<path> 的 JSON；非 2xx / 超时 / 读不懂都抛。 */
  api(path: string): Promise<unknown>;
  /** 工件压缩包的原始字节。 */
  download(artifactId: number): Promise<Uint8Array>;
  /** 压缩包里 record.json 的文本。 */
  unzip(zip: Uint8Array): Promise<string>;
}

interface ArtifactRow { id: number; name: string; runId: number; expired: boolean; digest: string | null }
const artifactRow = (v: unknown): ArtifactRow => {
  const a = obj(v);
  return { id: Number(a.id), name: text(a.name), runId: Number(obj(a.workflow_run).id), expired: a.expired === true, digest: text(a.digest) || null };
};

/** 一个工件对应的原 run 证据：工件内容、run、记录所指 attempt 的作业与步骤、记录所指的检出提交，全部经 API 读回。 */
export async function readOrigin(inputs: CiReuseInputs, row: ArtifactRow, deps: OriginDeps): Promise<CiReuseOrigin> {
  const repo = `/repos/${inputs.repo}`, def = CI_REUSE_CHECKS[inputs.check.id];
  const run = obj(await deps.api(`${repo}/actions/runs/${row.runId}`));
  const ev: CiReuseOrigin = {
    source: "actions-api", repo: text(obj(run.repository).full_name), headRepo: text(obj(run.head_repository).full_name) || null, runId: row.runId,
    workflowPath: text(run.path).split("@")[0]!, event: text(run.event), headSha: text(run.head_sha), attempt: 0, job: null,
    artifact: { ...row, contentDigest: null, record: null }, commit: null,
  };
  if (row.expired) return ev;
  const zip = await deps.download(row.id);
  let record: unknown = null;
  try { record = JSON.parse(await deps.unzip(zip)); } catch { /* 解不开或不是 JSON 的工件按内容非法处理：record 留 null，lib 拒绝它 */ }
  ev.artifact = { ...row, contentDigest: ciReuseDigest(zip), record };
  const parsed = parseCiReuseRecord(record);
  if (!parsed.ok || !def) return ev;
  ev.attempt = parsed.value.run.attempt;
  const jobs = obj(await deps.api(`${repo}/actions/runs/${row.runId}/attempts/${ev.attempt}/jobs?per_page=100`)).jobs;
  const job = (Array.isArray(jobs) ? jobs : []).map(obj).find((j) => j.name === def.job);
  if (job) {
    const steps = (Array.isArray(job.steps) ? job.steps : []).map(obj).map((s) => ({ name: text(s.name), conclusion: text(s.conclusion) || null }));
    ev.job = { name: def.job, conclusion: text(job.conclusion) || null, steps };
  }
  const c = obj(await deps.api(`${repo}/git/commits/${parsed.value.run.checkout}`));
  ev.commit = { sha: text(c.sha), tree: text(obj(c.tree).sha), parents: (Array.isArray(c.parents) ? c.parents : []).map((p) => text(obj(p).sha)) };
  return ev;
}

/** 按 key 列出的候选原 run（不含本次运行自己），最多 MAX_CANDIDATES 个，新的在前。 */
export async function lookupOrigins(inputs: CiReuseInputs, selfRunId: number, deps: OriginDeps): Promise<CiReuseOrigin[]> {
  const name = ciReuseArtifactName(inputs);
  const list = obj(await deps.api(`/repos/${inputs.repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=20`)).artifacts;
  const rows = (Array.isArray(list) ? list : []).map(artifactRow).filter((r) => r.runId !== selfRunId && Number.isSafeInteger(r.id) && Number.isSafeInteger(r.runId));
  const out: CiReuseOrigin[] = [];
  for (const row of rows.sort((a, b) => b.id - a.id).slice(0, MAX_CANDIDATES)) out.push(await readOrigin(inputs, row, deps));
  return out;
}

export interface RunDeps {
  mode: CiProofReuseMode;
  run: { runId: number; attempt: number; checkout: string };
  revokedRuns: number[];
  inputs(): CiReuseInputs;
  lookup(inputs: CiReuseInputs): Promise<CiReuseOrigin[]>;
  /** 跑一条命令，返回退出码。 */
  exec(cmd: readonly string[]): Promise<number>;
  now(): number;
  writeJson(path: string, value: unknown): void;
  /** 写一行 `name=value` 到 $GITHUB_OUTPUT（reuse_record：实际执行成功后要上传的记录工件名）。 */
  output(line: string): void;
  log(line: string): void;
}

/** PM 核 observe 样本、算净节省认的固定一行：命中与否、原 run、查询成本、实际耗时或省下的耗时。 */
export function reuseNotice(check: string, d: CiReuseDecision, origin: CiReuseOrigin | null,
  cost: { lookupMs: number; execSeconds: number | null; code: number | null; saved: number | null }): string {
  const from = d.candidate && origin ? `${origin.runId}/${origin.attempt}` : "none";
  const actual = cost.code === null ? "reused" : cost.code === 0 ? "success" : "failure";
  return `::notice title=ci-proof-reuse::check=${check} mode=${d.mode} candidate=${d.candidate ? 1 : 0} reused=${d.execute ? 0 : 1} origin=${from}`
    + ` lookup-ms=${cost.lookupMs} exec-s=${cost.execSeconds ?? 0} saved-s=${cost.saved ?? 0} actual=${actual}`;
}

async function executeAll(check: string, deps: RunDeps): Promise<number> {
  for (const cmd of CI_REUSE_CHECKS[check]!.commands) {
    deps.log(`── ${cmd.join(" ")}`);
    const code = await deps.exec(cmd);
    if (code !== 0) return code;
  }
  return 0;
}

/** 查候选并判定；查询或算输入出错只记一行，按未命中返回。 */
async function decide(check: string, deps: RunDeps): Promise<{ decision: CiReuseDecision; origin: CiReuseOrigin | null; inputs: CiReuseInputs | null }> {
  let inputs: CiReuseInputs | null = null, origins: CiReuseOrigin[] = [];
  try {
    inputs = deps.inputs();
    origins = await deps.lookup(inputs);
  } catch (e) {
    deps.log(`ci-proof-reuse: ${check} ${inputs ? "查询候选失败" : "输入没算出来"}，照常执行：${(e as Error).message}`);
  }
  const judge = (origin: CiReuseOrigin | null) => decideCiReuse({ mode: deps.mode, inputs, evidence: origin, run: deps.run, revokedRuns: deps.revokedRuns });
  const judged = (origins.length ? origins : [null]).map((origin) => ({ origin, decision: judge(origin) }));
  return { ...(judged.find((j) => j.decision.candidate) ?? judged[0]!), inputs };
}

/** 一项检查的完整流程；返回这一步的退出码（复用命中为 0，否则是实际执行的结果）。 */
export async function runCheck(check: string, outDir: string, deps: RunDeps): Promise<number> {
  // 哪个模式下都先记下是哪次 run / attempt 在写这个目录：工件每次 attempt 覆盖上传，核对端据此认出上一次 attempt 留下的回执
  try { deps.writeJson(join(outDir, "receipts", RUN_FILE), { runId: deps.run.runId, attempt: deps.run.attempt }); }
  catch (e) { deps.log(`ci-proof-reuse: ${RUN_FILE} 没写成（${(e as Error).message}）；有回执时核对端会因缺它而拒`); }
  if (deps.mode === "off") return executeAll(check, deps);
  const started = deps.now();
  const { decision: d, origin, inputs } = await decide(check, deps);
  const lookupMs = deps.now() - started;
  if (!d.candidate) deps.log(`ci-proof-reuse: ${check} 未命中：${d.reasons.join("；") || "没有候选"}`);
  if (!d.execute && d.receipt) {
    try {
      deps.writeJson(join(outDir, "receipts", `receipt-${check}.json`), d.receipt);
      deps.log(reuseNotice(check, d, origin, { lookupMs, execSeconds: null, code: null, saved: d.receipt.origin.seconds }));
      return 0;
    } catch (e) {
      // 回执写不出就不能算复用过：没有回执的跳过在证明里无从核对，改为实际执行
      deps.log(`ci-proof-reuse: ${check} 回执没写成，改为实际执行：${(e as Error).message}`);
    }
  }
  const t0 = deps.now(), code = await executeAll(check, deps), execSeconds = Math.round((deps.now() - t0) / 1000);
  const ran: CiReuseDecision = { ...d, execute: true, receipt: null };
  deps.log(reuseNotice(check, ran, origin, { lookupMs, execSeconds, code, saved: null }));
  if (code !== 0 || !inputs) return code;
  try {
    const record: CiReuseRecord = { version: 1, kind: "record", key: ciReuseKey(inputs), inputs, run: deps.run, seconds: execSeconds };
    deps.writeJson(join(outDir, `record-${check}`, RECORD_FILE), record);
    deps.output(`reuse_record=${ciReuseArtifactName(inputs)}`);
  } catch (e) {
    // 记录没留下只是以后少一个可复用的来源，这一步的结果照旧
    deps.log(`ci-proof-reuse: ${check} 的记录没写成：${(e as Error).message}`);
  }
  return code;
}

function spawnText(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}：${r.stderr.toString().trim().slice(0, 200)}`);
  return r.stdout.toString();
}

/** Actions API 的只读客户端：token 来自作业的 GH_TOKEN，每个请求有限时。 */
export function githubDeps(env: Record<string, string | undefined>, tmp: string): OriginDeps {
  const root = env.GITHUB_API_URL || "https://api.github.com";
  const headers = { authorization: `Bearer ${env.GH_TOKEN ?? ""}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  const get = async (url: string, init: RequestInit) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!res.ok && res.status !== 302) throw new Error(`GET ${url.split("?")[0]} → ${res.status}`);
    return res;
  };
  return {
    api: async (path) => (await get(`${root}${path}`, { headers })).json(),
    // 压缩包地址是一次跳转到存储服务的签名链接；自己跟跳转，第二个请求不带 token（带了会被存储服务拒绝）
    download: async (id) => {
      const first = await get(`${root}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`, { headers, redirect: "manual" });
      const to = first.headers.get("location");
      return new Uint8Array(await (to ? await get(to, {}) : first).arrayBuffer());
    },
    unzip: async (zip) => {
      const file = join(tmp, `ci-reuse-${process.pid}-${zip.length}.zip`);
      mkdirSync(tmp, { recursive: true });
      writeFileSync(file, zip);
      return spawnText(["unzip", "-p", file, RECORD_FILE]);
    },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${canonicalJson(value)}\n`);
}

export const revokedRuns = (raw: string | undefined): number[] => (raw ?? "").split(/[\s,]+/).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);

async function main(args: string[]): Promise<number> {
  const [cmd, check, outDir] = args, env = process.env;
  if (cmd !== "run" || !check || !outDir || !Object.hasOwn(CI_REUSE_CHECKS, check)) {
    console.error(`用法：bun scripts/ci-proof-reuse.ts run <${Object.keys(CI_REUSE_CHECKS).join(" | ")}> <输出目录>`);
    return 2;
  }
  const api = githubDeps(env, env.RUNNER_TEMP || outDir);
  const run = { runId: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), checkout: "" };
  return runCheck(check, outDir, {
    mode: ciProofReuseMode(env.CI_PROOF_REUSE), run, revokedRuns: revokedRuns(env.CI_PROOF_REUSE_REVOKED),
    inputs: () => {
      run.checkout = spawnText(["git", "rev-parse", "HEAD"]).trim();
      if (!(run.runId > 0) || !(run.attempt > 0)) throw new Error("GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT 不是合法值");
      return localInputs(check, { env, git: (...a) => spawnText(["git", ...a]), read: (p) => readFileSync(p, "utf8"), bun: Bun.version, node: spawnText(["node", "--version"]).trim() });
    },
    lookup: (inputs) => lookupOrigins(inputs, run.runId, api),
    // 被包装的命令用不到 API token，不传给它
    exec: async (c) => Bun.spawn([...c], { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: { ...env, GH_TOKEN: undefined } }).exited,
    now: Date.now, writeJson, log: (l) => console.log(l),
    output: (line) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${line}\n`); },
  });
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
