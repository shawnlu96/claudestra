/** Immutable, attempt-bound evidence for CI bounces. Only whitelisted test artifacts are retained, never whole job logs. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { ghCiSelectedPort, type CiSelectedRun, readCiSelectedArchiveRun } from "./ci-selected-receipt.js";
import { ciSelectedMode, type CiSelectedMode, type SelectedVerdict } from "./ci-selected-verdict.js";
import { acquireLock } from "./file-lock.js";
import { statePath } from "./paths.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { writeTextAtomicSync } from "./state-file.js";

export const REPLAY_POLICY = "ci-selected-replay-1";
export const replayDigest = (v: unknown): string => `sha256:${createHash("sha256").update(canonicalJson(v)).digest("hex")}`;
interface ReplayJob {
  name: string; status: string; conclusion: string | null; steps: { name: string; conclusion: string | null }[];
}
export interface ReplayEvidence {
  repo: string; run: CiSelectedRun; checkout: string; base: string; parents: string[];
  planText: string; diff: string; changed: string[]; jobs: ReplayJob[]; universe: string[]; slow: string[];
  /** Original artifact bytes, keyed by an allowlisted artifact name and its one necessary filename. */
  files: Record<string, string>; gaps: string[];
}
export interface ReplayReceipt {
  version: 1; policyVersion: string; project: string; taskId: string; intentId: string; mergeRev: number;
  head: string; round: number | null; specRev: number | null; capturedAt: number; effectiveMode: CiSelectedMode;
  subject?: { id: number; attempt: number };
  checks: { name: string; link: string }[]; failures: { file: string; name: string }[] | null; evidence: ReplayEvidence | null; gaps: string[]; verdict: SelectedVerdict | null;
}
export interface ReplayRef { file: string; digest: string }
export interface ReplayBinding { project: string; taskId: string; intentId: string; rev: number; reviewedHead: string }
export const replayRoot = (): string => statePath("ci-selected-replay");
const prefix = (b: ReplayBinding) => replayDigest([b.project, b.taskId, b.intentId, b.rev, b.reviewedHead]).slice(7);
const directory = (root: string, b: ReplayBinding) => join(root, prefix(b));
const bindingOf = (r: ReplayReceipt): ReplayBinding => ({ ...r, rev: r.mergeRev, reviewedHead: r.head });

/** First-wins writes share locking for both receipts and durable readiness deadlines. */
async function writeOnce(path: string, value: unknown): Promise<any> {
  const lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("回执文件锁不可用，未覆盖工件");
  try {
    if (!lock.held()) throw new Error("回执文件锁已失效");
    if (!existsSync(path)) writeTextAtomicSync(path, canonicalJson(value), { mode: 0o600 });
    return JSON.parse(readFileSync(path, "utf8"));
  } finally { lock.release(); }
}

/** Retries cannot overwrite earlier evidence, including explicit missing-evidence receipts. */
export async function saveReplayReceipt(r: ReplayReceipt, root = replayRoot()): Promise<ReplayRef> {
  const dir = directory(root, bindingOf(r));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const subject = r.subject ?? r.evidence?.run;
  const key = replayDigest([subject?.id, subject?.attempt, r.checks, r.effectiveMode]).slice(7);
  const file = `${prefix(bindingOf(r))}/${key}.json`;
  const old = await writeOnce(join(root, file), r);
  return { file, digest: replayDigest(old) };
}

/** The deadline survives scheduler restarts and is isolated by intent, revision, head, run and attempt. */
export async function replayWaitStarted(b: ReplayBinding, subject: CiSelectedRun, now: number, root = replayRoot()): Promise<number> {
  const dir = directory(root, b);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = replayDigest([subject.id, subject.attempt]).slice(7);
  const saved = await writeOnce(join(dir, `waiting.${key}.json`), { startedAt: now });
  if (!Number.isFinite(saved.startedAt)) throw new Error("证据等待起点损坏");
  return saved.startedAt;
}

/** Paths are generated hashes; references from ledger data cannot escape the archive root. */
export function readReplayReceipt(root: string, ref: ReplayRef, verify = true): ReplayReceipt {
  if (!/^[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(ref.file)) throw new Error("回执路径非法");
  const r = JSON.parse(readFileSync(join(root, ref.file), "utf8")) as ReplayReceipt;
  if (r.version !== 1 || r.policyVersion !== REPLAY_POLICY || !Array.isArray(r.gaps) || !Array.isArray(r.checks)) throw new Error("回执版本或结构不支持");
  if (verify && replayDigest(r) !== ref.digest) throw new Error("回执摘要不符");
  if (!ref.file.startsWith(`${prefix(bindingOf(r))}/`)) throw new Error("回执绑定不符");
  return r;
}

/** Called inside the bounce transaction: pin every captured attempt to the exact event, round and spec revision. */
export function replayRefs(b: ReplayBinding, root = replayRoot()): ReplayRef[] {
  const dir = directory(root, b);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).sort().map((f) => {
    const ref = { file: `${prefix(b)}/${f}`, digest: "" };
    return { ...ref, digest: replayDigest(readReplayReceipt(root, ref, false)) };
  });
}

const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const SHA = /^[a-f0-9]{40}$/;
const ARTIFACT = /^(ci-related-plan|test-shard-[1-8]|ci-selected-shard-[1-8]|ci-facts-shard-[1-8])$/;
const fileOf = (name: string) => name === "ci-related-plan" ? "plan.json" : name.startsWith("test-shard-") ? "shard.log"
  : name.startsWith("ci-selected-") ? "receipt.json" : "job-facts.json";

/** Bounded GET pagination; an incomplete listing is an explicit gap, never a smaller successful evidence set. */
async function pages(api: (path: string) => Promise<any>, path: string, field: string): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const raw = obj(await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
    if (!Array.isArray(raw[field])) throw new Error(`${field} 列表缺失`);
    rows.push(...raw[field]);
    if (rows.length >= raw.total_count) return rows;
    if (!raw[field].length) throw new Error(`${field} 列表不完整`);
  }
  throw new Error(`${field} 列表超出采集上限`);
}

async function downloadFiles(command: typeof runBounded, repo: string, runId: number, names: string[], cwd?: string): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "ci-replay-")), files: Record<string, string> = {};
  try {
    if (!names.length) return files;
    const r = await command(["gh", "run", "download", String(runId), "-R", repo, ...names.flatMap((n) => ["-n", n]), "-D", dir],
      { cwd, timeoutMs: 60_000 });
    if (r.code !== 0 || r.timedOut || r.truncated) throw new Error("必要工件批量下载失败");
    for (const name of names) files[`${name}/${fileOf(name)}`] = readFileSync(join(dir, ...(names.length > 1 ? [name] : []), fileOf(name)), "utf8");
    return files;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export class ReplayEvidencePending extends Error {
  constructor(public readonly run: CiSelectedRun, names: string[]) { super(`必要作业尚未结束：${names.join("、")}`); }
}

/** Proof only checks artifacts already produced by these jobs; waiting for it would discard otherwise complete first-red evidence. */
export function pendingReplayJobs(jobs: ReplayJob[]): string[] {
  const scope = jobs.find((j) => /^ci scope (full|related|light)$/.test(j.name));
  const n = scope?.name === "ci scope light" ? 1 : 8;
  const names = ["ci related plan", scope?.name ?? "ci scope", "typecheck + test + guard", "web typecheck + lint", "web production build",
    "desktop scope", "desktop typecheck + cargo test", ...Array.from({ length: n }, (_, i) => `test shard ${i + 1} of 8`)];
  return names.filter((name) => !jobs.some((j) => j.name === name && j.status === "completed"));
}

export interface ReplayCollectOptions { reuse?: (run: CiSelectedRun) => ReplayEvidence | null; now?: () => number; budgetMs?: number }

/** One wall-clock budget covers every command, including pagination and the single artifact batch. */
function budgetCommand(command: typeof runBounded, options: ReplayCollectOptions): typeof runBounded {
  const now = options.now ?? Date.now, deadline = now() + (options.budgetMs ?? 90_000);
  return (argv, opts) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("证据采集总时间预算已耗尽");
    return command(argv, { ...opts, timeoutMs: Math.min(opts.timeoutMs, remaining) });
  };
}

/** Fetches immutable subjects only. The before/after run read rejects a rerun started during artifact collection. */
export async function collectReplayEvidence(repo: string, head: string, links: string[], command = runBounded,
  cwd?: string, options: ReplayCollectOptions = {}): Promise<ReplayEvidence> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !SHA.test(head)) throw new Error("仓库或 head 非法");
  command = budgetCommand(command, options);
  const port = ghCiSelectedPort(command, cwd);
  const run = await port.prRun(repo, head);
  if (!run) throw new Error("没有当前 head 的 PR CI run");
  await readCiSelectedArchiveRun(port, repo, run.id, head, run.attempt);
  const gaps: string[] = [];
  if (links.some((link) => !link.startsWith(`https://github.com/${repo}/actions/runs/${run.id}/`)
    && link !== `https://github.com/${repo}/actions/runs/${run.id}`)) gaps.push("失败检查未全部绑定当前 CI run");
  const reused = options.reuse?.(run);
  if (reused && !gaps.length && !reused.gaps.length && reused.repo === repo
    && reused.run.id === run.id && reused.run.attempt === run.attempt && reused.run.headSha === head) {
    await readCiSelectedArchiveRun(port, repo, run.id, head, run.attempt);
    return reused;
  }
  // This repo’s recursive GitHub tree exceeds the command runner’s 1 MiB default; larger evidence still has a hard cap.
  const api = async (path: string, diff = false): Promise<any> => {
    const r = await command(["gh", "api", path, ...(diff ? ["-H", "Accept: application/vnd.github.diff"] : [])],
      { cwd, timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 });
    if (r.code !== 0 || r.timedOut || r.truncated) throw new Error("GitHub 证据读取失败");
    return diff ? r.stdout : JSON.parse(r.stdout);
  };
  const jobsRaw = await pages(api, `repos/${repo}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`, "jobs");
  const jobs: ReplayJob[] = jobsRaw.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion,
    steps: (j.steps ?? []).map((s: any) => ({ name: s.name, conclusion: s.conclusion })) }));
  const pending = pendingReplayJobs(jobs);
  if (pending.length) throw new ReplayEvidencePending(run, pending);
  const artifacts = await pages(api, `repos/${repo}/actions/runs/${run.id}/artifacts`, "artifacts");
  const selected = artifacts.filter((a) => ARTIFACT.test(a.name));
  if (selected.some((a) => a.expired)) gaps.push("必要工件已过期");
  if (new Set(selected.map((a) => a.name)).size !== selected.length) gaps.push("工件名重复，不能确定 attempt");
  const files = await downloadFiles(command, repo, run.id, [...new Set<string>(selected.filter((a) => !a.expired).map((a) => a.name))], cwd);
  const planText = files["ci-related-plan/plan.json"] ?? "";
  const plan = obj(JSON.parse(planText || "{}")), checkout = String(plan.sha ?? "");
  if (!SHA.test(checkout) || plan.prHead !== head || plan.event !== "pull_request") throw new Error("计划未绑定 PR head / 检出");
  const parents = await port.commitParents(repo, checkout), base = parents[0] ?? "";
  if (parents.length !== 2 || parents[1] !== head) throw new Error("检出不是当前 PR 的测试合并");
  const comparison = obj(await api(`repos/${repo}/compare/${base}...${checkout}`));
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300) gaps.push("PR diff 文件清单可能截断");
  const changed: string[] = (comparison.files ?? []).flatMap((f: any) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]);
  const diff = await api(`repos/${repo}/compare/${base}...${checkout}`, true) as string;
  if (!diff.trim() && changed.length) gaps.push("PR diff 缺失");
  const tree = obj(await api(`repos/${repo}/git/trees/${checkout}?recursive=1`));
  if (tree.truncated || !Array.isArray(tree.tree)) gaps.push("检出文件树不完整");
  const universe: string[] = (tree.tree ?? []).filter((f: any) => f.type === "blob" && /(\.|_)(test|spec)\.(c|m)?[jt]sx?$/.test(f.path))
    .map((f: any) => f.path).sort();
  const slowRaw = obj(await api(`repos/${repo}/contents/tests/slow-tests.txt?ref=${checkout}`));
  if (slowRaw.encoding !== "base64" || typeof slowRaw.content !== "string") throw new Error("慢测试清单缺失");
  const slow = Buffer.from(slowRaw.content, "base64").toString("utf8").split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  await readCiSelectedArchiveRun(port, repo, run.id, head, run.attempt);
  return { repo, run, checkout, base, parents, planText, diff, changed, jobs, universe, slow, files, gaps };
}

/** Freeze the effective gate mode for explanation only; this read never accepts a selected release. */
export async function archiveSelectedMode(repo: string, project: string): Promise<CiSelectedMode> {
  const key = recoveryPolicy(project, "ciSelectedGate");
  if (key.source === "error" || key.mode === "off") return "off";
  try {
    const mode = ciSelectedMode(await ghCiSelectedPort(runBounded).variable(repo));
    return mode === "off" ? "off" : mode === "on" && key.mode === "on" ? "on" : "observe";
  } catch { return "off"; } // unreadable variable is recorded as the conservative effective mode, never used to authorize a merge
}
