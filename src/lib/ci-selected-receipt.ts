/**
 * 责任选集放行回执的统一读口（merge-arch-CISEL2）：调度器合并路径（串行、mergeDirect、ci-full 补验）和 PM 预检只经这里读
 * CISEL1 的 `ci-selected-verdict` 工件，不各写一套。读到的回执要和这次 run 的最新 attempt、检出、PR head 都对得上，
 * 字段与 digest 形状都要对；任何一处对不上都读作 null（不放行）。`marked` = 这次 run 带放行标记（列出了 ci-selected-verdict 工件，
 * 过期的也算；列表里没有它时一律看最新 attempt 汇总作业日志里的 `ci-selected: allow=1`，verdict 可以单独丢）：带标记却读不出回执，调用方一律当红。只读 GitHub，不写任何东西。docs/architecture/ci-selected-gate.md，tests/ci-selected-receipt.test.ts。
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiSelectedMode } from "./ci-selected-verdict.js";
import type { runBounded } from "./run-bounded.js";
import { GATE } from "./scheduler-merge-ci-rerun-log.js";

const CI_SELECTED_VERDICT_ARTIFACT = "ci-selected-verdict";
const CI_SELECTED_VARIABLE = "CI_SELECTED_GATE";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const RELEASE_LINE = /^(?:.*\s)?ci-selected: allow=1\b/m;
const SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

interface CiSelectedFailure { file: string; name: string }
/** 读口的回答。allowed = CI 在 on 下放行了、且列出了范围外失败；放不放行合并由调用方按有效档定。 */
export interface CiSelectedReceipt {
  allowed: boolean; outOfScope: CiSelectedFailure[]; runUrl: string;
  runId: number; attempt: number; head: string; checkout: string; mode: CiSelectedMode; responsibilityDigest: string; digest: string;
}
/** marked = 这次 run 有 ci-selected-verdict 工件；receipt = 核过的回执（null = 没有或对不上，problem 说为什么）。 */
export interface CiSelectedRead { marked: boolean; receipt: CiSelectedReceipt | null; problem?: string; runId?: number; attempt?: number; runUrl?: string }
export interface CiSelectedRun { id: number; attempt: number; headSha: string; event: string; status: string; conclusion: string | null; url: string }
/** 受保护的只读端口；测试换假的。 */
export interface CiSelectedPort {
  /** CI 工作流给这个 head 跑的 pull_request run 里最新的一个；没有 = null */
  prRun(repo: string, head: string): Promise<CiSelectedRun | null>;
  runById(repo: string, runId: number): Promise<CiSelectedRun>;
  /**
   * present = 这次 run 放行过：列出了 ci-selected-verdict 工件（过期的也算），或没列出它、最新 attempt 的汇总作业日志里有放行行
   * （日志也读不到 = 证据没了，同样算）。text = 下载出的 verdict.json（过期 / 下载不下来 = null，problem 说为什么）
   */
  verdict(repo: string, runId: number): Promise<{ present: boolean; text: string | null; problem?: string }>;
  commitParents(repo: string, sha: string): Promise<string[]>;
  /** 仓库变量 CI_SELECTED_GATE 的原值；没设 = null，读不出抛错 */
  variable(repo: string): Promise<string | null>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const lower = (s: string) => s.toLowerCase();
const VERDICT_KEYS = ["version", "kind", "mode", "runId", "attempt", "head", "responsibilityDigest", "outOfScope", "shards"];

/** 严格读 verdict.json（scripts/ci-selected-verdict.ts gateVerdict 写的形状）；不认识的读作 null。 */
function parseVerdict(text: string): Obj | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; } // 读不懂的 JSON 就是没有回执，调用方按缺证据当红
  if (!isObj(v) || Object.keys(v).length !== VERDICT_KEYS.length || !VERDICT_KEYS.every((k) => k in v)) return null;
  if (v.version !== 1 || v.kind !== "ci-selected-verdict" || !["off", "observe", "on"].includes(String(v.mode))) return null;
  if (!posInt(v.runId) || !posInt(v.attempt) || typeof v.head !== "string" || !SHA.test(v.head)) return null;
  if (typeof v.responsibilityDigest !== "string" || !DIGEST.test(v.responsibilityDigest)) return null;
  if (!Array.isArray(v.outOfScope) || !v.outOfScope.every((f) => isObj(f) && typeof f.file === "string" && typeof f.name === "string")) return null;
  const shards = v.shards;
  if (!isObj(shards) || !Object.keys(shards).length || !Object.values(shards).every((d) => typeof d === "string" && DIGEST.test(d))) return null;
  return v;
}

/** 回执绑定：run id、最新 attempt、检出；checkout 判定由调用方给（PR 路径是 head 或以 head 为第二父的测试合并，补验是请求的合并提交）。 */
async function bind(port: CiSelectedPort, repo: string, run: CiSelectedRun, checkoutOk: (sha: string) => Promise<boolean>): Promise<CiSelectedRead> {
  const at = { runId: run.id, attempt: run.attempt, runUrl: run.url };
  const art = await port.verdict(repo, run.id);
  if (!art.present) return { marked: false, receipt: null, ...at };
  const no = (problem: string): CiSelectedRead => ({ marked: true, receipt: null, problem, ...at });
  if (art.text === null) return no(art.problem ?? `${CI_SELECTED_VERDICT_ARTIFACT} 下载不下来`);
  const v = parseVerdict(art.text);
  if (!v) return no(`${CI_SELECTED_VERDICT_ARTIFACT} 不是合法回执`);
  if (v.runId !== run.id) return no(`回执来自 run ${String(v.runId)}，不是 run ${run.id}`);
  if (v.attempt !== run.attempt) return no(`回执来自 attempt ${String(v.attempt)}，不是最新 attempt ${run.attempt}`);
  if (!await checkoutOk(v.head as string)) return no(`回执的检出 ${(v.head as string).slice(0, 12)} 对不上这次 run 的 head`);
  const outOfScope = (v.outOfScope as CiSelectedFailure[]).map((f) => ({ file: f.file, name: f.name }));
  return { marked: true, ...at, receipt: {
    allowed: v.mode === "on" && outOfScope.length > 0, outOfScope, runUrl: run.url, runId: run.id, attempt: run.attempt, head: run.headSha,
    checkout: lower(v.head as string), mode: v.mode as CiSelectedMode, responsibilityDigest: v.responsibilityDigest as string,
    digest: `sha256:${createHash("sha256").update(art.text).digest("hex")}` } };
}

/** PR 路径：按 PR head 取 CI 最新的 pull_request run 的最新 attempt；回执的检出要是 head 本身或以它为第二父的测试合并。 */
export async function readCiSelectedReceipt(port: CiSelectedPort, repo: string, head: string): Promise<CiSelectedRead> {
  const run = await port.prRun(repo, head);
  if (!run) return { marked: false, receipt: null };
  if (lower(run.headSha) !== lower(head)) return { marked: false, receipt: null };
  return bind(port, repo, run, async (sha) => lower(sha) === lower(head) || lower((await port.commitParents(repo, sha))[1] ?? "") === lower(head));
}

/** ci-full 补验路径：给定的 run，回执的检出要恰好是请求绑定的合并提交。 */
export async function readCiSelectedRunReceipt(port: CiSelectedPort, repo: string, runId: number, checkout: string): Promise<CiSelectedRead> {
  return bind(port, repo, await port.runById(repo, runId), async (sha) => lower(sha) === lower(checkout));
}

/** Archive reads must pin a completed PR run and attempt on both sides of downloading mutable artifact names. */
export async function readCiSelectedArchiveRun(port: CiSelectedPort, repo: string, id: number, head: string, attempt: number): Promise<CiSelectedRun> {
  const run = await port.runById(repo, id);
  if (run.id !== id || run.attempt !== attempt || lower(run.headSha) !== lower(head) || run.event !== "pull_request" || run.status !== "completed") {
    throw new Error("归档期间 run / attempt / head 改变，或 CI 尚未结束");
  }
  return run;
}

type Command = typeof runBounded;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const runRow = (r: Obj): CiSelectedRun => ({ id: Number(r.id), attempt: Number(r.run_attempt), headSha: text(r.head_sha), event: text(r.event),
  status: text(r.status), conclusion: text(r.conclusion) || null, url: text(r.html_url) });

/** gh 端口：结构化 argv，只读（GET 与 run download）。 */
export function ghCiSelectedPort(command: Command, cwd?: string): CiSelectedPort {
  const env = { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };
  const exec = (argv: string[], timeoutMs = 30_000) => command(argv, { cwd, env, timeoutMs });
  const api = async (path: string): Promise<unknown> => {
    const r = await exec(["gh", "api", path]);
    if (r.code !== 0 || r.timedOut) throw new Error(`gh api ${path.split("?")[0]} 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    return JSON.parse(r.stdout) as unknown;
  };
  const slug = (repo: string) => { if (!REPO.test(repo)) throw new Error(`仓库名不合法：${repo.slice(0, 80)}`); return repo; };
  /** 结束了的汇总作业（job id 每个 attempt 各一个）日志不会再变：判过的结论记下，普通绿每轮只多一次 jobs 列表 */
  const logSaid = new Map<string, string | null>();
  /**
   * 没列出 verdict 工件（没放行，或它单独被删 / 丢了、过期清掉）：看最新 attempt 汇总作业日志有没有放行行；日志也没了 = 证不了没放行。
   * 别的工件还在不算证据（verdict 可以单独丢）。null = 没放行
   */
  const releasedByLog = async (repo: string, runId: number): Promise<string | null> => {
    const page = await api(`repos/${slug(repo)}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    const job = (isObj(page) && Array.isArray(page.jobs) ? page.jobs.filter(isObj) : []).find((j) => j.name === GATE.job && posInt(j.id));
    if (!job) return null; // 没有汇总作业就没有放行（放行只在它里面成立）
    const key = `${repo}#${Number(job.id)}`;
    if (logSaid.has(key)) return logSaid.get(key)!;
    const r = await exec(["gh", "api", `repos/${slug(repo)}/actions/jobs/${Number(job.id)}/logs`], 60_000);
    if (r.code !== 0 && !r.timedOut && /HTTP 4(04|10)/.test(r.stderr)) return `${CI_SELECTED_VERDICT_ARTIFACT} 工件没列出、汇总作业日志也没了，证不了没放行`;
    if (r.code !== 0 || r.timedOut) throw new Error(`汇总作业日志读不出：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    const said = RELEASE_LINE.test(r.stdout) ? `${CI_SELECTED_VERDICT_ARTIFACT} 工件没列出，汇总作业日志显示放行过` : null;
    if (job.status === "completed") {
      if (logSaid.size >= 500) logSaid.clear();
      logSaid.set(key, said);
    }
    return said;
  };
  return {
    async prRun(repo, head) {
      if (!SHA.test(head)) throw new Error("head 不是完整 SHA");
      const page = await api(`repos/${slug(repo)}/actions/runs?head_sha=${lower(head)}&event=pull_request&per_page=100`);
      const rows = isObj(page) && Array.isArray(page.workflow_runs) ? page.workflow_runs.filter(isObj) : [];
      const mine = rows.filter((r) => text(r.path).split("@")[0] === CI_WORKFLOW && posInt(r.id)).sort((a, b) => Number(b.id) - Number(a.id));
      return mine[0] ? runRow(mine[0]) : null;
    },
    async runById(repo, runId) {
      if (!posInt(runId)) throw new Error("run id 不合法");
      const r = await api(`repos/${slug(repo)}/actions/runs/${runId}`);
      if (!isObj(r) || !posInt(r.run_attempt)) throw new Error(`run ${runId} 没有 attempt`);
      return runRow(r);
    },
    async verdict(repo, runId) {
      const page = await api(`repos/${slug(repo)}/actions/runs/${runId}/artifacts?per_page=100`);
      const rows = isObj(page) && Array.isArray(page.artifacts) ? page.artifacts.filter(isObj) : [];
      const mine = rows.filter((a) => a.name === CI_SELECTED_VERDICT_ARTIFACT);
      if (!mine.length) {
        const problem = await releasedByLog(repo, runId);
        return problem ? { present: true, text: null, problem } : { present: false, text: null };
      }
      if (!mine.some((a) => a.expired !== true)) return { present: true, text: null, problem: `${CI_SELECTED_VERDICT_ARTIFACT} 已过期，回执读不到` };
      const dir = mkdtempSync(join(tmpdir(), "ci-selected-"));
      try {
        const r = await exec(["gh", "run", "download", String(runId), "-R", repo, "-n", CI_SELECTED_VERDICT_ARTIFACT, "-D", dir], 60_000);
        if (r.code !== 0 || r.timedOut) return { present: true, text: null };
        try { return { present: true, text: readFileSync(join(dir, "verdict.json"), "utf8") }; }
        catch { return { present: true, text: null }; } // 工件里没有 verdict.json：带标记却缺回执，调用方当红
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    async commitParents(repo, sha) {
      if (!SHA.test(sha)) throw new Error("commit 不是完整 SHA");
      const c = await api(`repos/${slug(repo)}/commits/${lower(sha)}`);
      return isObj(c) && Array.isArray(c.parents) ? c.parents.filter(isObj).map((p) => text(p.sha)) : [];
    },
    async variable(repo) {
      const r = await exec(["gh", "api", `repos/${slug(repo)}/actions/variables/${CI_SELECTED_VARIABLE}`]);
      if (r.code !== 0 && /HTTP 404/.test(r.stderr)) return null;
      if (r.code !== 0 || r.timedOut) throw new Error(`仓库变量 ${CI_SELECTED_VARIABLE} 读不出：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || "timeout"}`);
      const v = JSON.parse(r.stdout) as unknown;
      return isObj(v) && typeof v.value === "string" ? v.value : null;
    },
  };
}
