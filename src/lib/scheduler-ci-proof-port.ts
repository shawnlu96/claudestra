/**
 * merge-arch-GATE1: the protected read-only GitHub port of the CI proof gate (scheduler-ci-proof-gate.ts). It reads one Actions
 * run back as CiRunEvidence (run → latest attempt → jobs → `ci-proof` artifact, plus the `ci-proof-reuse` receipts through
 * readCiRunReuse) and the Git facts the gate binds it to (main tip, PR head, a commit's tree and parents, a file at a commit).
 * Protected = GET only: `gh api` takes a path that must match API_PATH (no method flag, no field flag), archives are fetched from
 * api.github.com with the gh credential and their one redirect followed without it; nothing here can write to GitHub.
 * Each job's checkout is the run-wide commit the attempt's own proof report recorded, accepted only when the Git API reads that
 * commit back as this run's subject (push: the head itself; pull_request: a merge whose second parent is the head). The Actions API
 * exposes no per-job checkout, so a job is never read on its own.
 * Every read asks GitHub again for what can change under a run id: the run (a re-run adds an attempt), its artifact list (an archive
 * expires or is deleted) and the reuse receipts with the revocation list. Only content that cannot change is kept: a commit, a file
 * at a commit, one finished attempt's jobs, one artifact's bytes (checked against the digest listed for it on every read).
 * tests/scheduler-ci-proof-gate.test.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiRunEvidence } from "./ci-proof.js";
import { type CiReuseApi, ciReuseArtifactRow, ciReuseDigest, readCiRunReuse } from "./ci-proof-reuse.js";
import type { runBounded } from "./run-bounded.js";

export const CI_PROOF_WORKFLOW = ".github/workflows/ci.yml";
const CI_PROOF_ARTIFACT = "ci-proof";
const REVOKED_VARIABLE = "CI_PROOF_REUSE_REVOKED";
const API_ROOT = "https://api.github.com";
const API_PATH = /^\/repos\/[\w.-]+\/[\w.-]+\/(actions|git|pulls|contents)\/[\w./-]+(\?[\w=&.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const PER_PAGE = 100;
const CACHE_MAX = 300;
/** MAPSWEEP1: archives held in all (least recently used out first) and the most one download may be (more = a failed download, not kept). */
export const ARCHIVE_CACHE_BYTES = 64 * 1024 * 1024;
export const ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;

export interface CiProofCommit { sha: string; tree: string; parents: string[] }
/** `base` is the pulls API's base.sha (what a pull_request manifest records), not the main the test merge sits on. */
export interface CiProofPull {
  head: string; base: string; state: string;
  /** GitHub's test merge commit of the PR (merge_commit_sha); null / absent = none computed. What a SELECT1 full re-check is bound to. */
  merge?: string | null;
}
/** `title` = the run's display title (a SELECT1 dispatch names its request there). */
export interface CiProofRunRow { id: number; event: string; headSha: string; status: string; title?: string }
/** `checkout` = the commit every job of the attempt checked out, or null when the attempt left no usable record of it. */
export interface CiProofRead { evidence: CiRunEvidence; event: string; checkout: string | null }
export interface CiProofPort {
  mainHead(repo: string): Promise<string>;
  pull(repo: string, pr: number): Promise<CiProofPull>;
  commit(repo: string, sha: string): Promise<CiProofCommit>;
  /** A file's text at a commit. */
  file(repo: string, sha: string, path: string): Promise<string>;
  /** The CI workflow's runs triggered for this head, newest first. */
  runs(repo: string, headSha: string): Promise<CiProofRunRow[]>;
  /** The run as it is now: never an earlier answer for the same run id (see the header). */
  read(repo: string, runId: number): Promise<CiProofRead>;
}

type Command = typeof runBounded;
type Fetch = (url: string, init: { headers?: Record<string, string>; redirect?: "manual"; signal: AbortSignal }) => Promise<Response>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } }; // bad JSON reads null and is refused as a manifest / report

/** Immutable content only (see the header): commit, file at a commit, a finished attempt's job rows, an artifact's archive bytes. */
const commits = new Map<string, CiProofCommit>(), files = new Map<string, string>(), jobLists = new Map<string, Obj[]>(), archives = new Map<string, Uint8Array>();
const keep = <V>(cache: Map<string, V>, key: string, value: V): V => {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, value);
  return value;
};
let archiveBytes = 0;
/** Archives: at most CACHE_MAX and ARCHIVE_CACHE_BYTES in all, a hit moves to the newest end (archiveHit). */
function keepArchive(key: string, zip: Uint8Array): Uint8Array {
  const prev = archives.get(key);
  if (prev) { archives.delete(key); archiveBytes -= prev.byteLength; }
  archives.set(key, zip);
  archiveBytes += zip.byteLength;
  for (const [k, v] of archives) {
    if (archives.size <= CACHE_MAX && archiveBytes <= ARCHIVE_CACHE_BYTES) break;
    archives.delete(k);
    archiveBytes -= v.byteLength;
  }
  return zip;
}
function archiveHit(key: string): Uint8Array | undefined {
  const hit = archives.get(key);
  if (hit) { archives.delete(key); archives.set(key, hit); }
  return hit;
}
/** One response body, refused past ARCHIVE_MAX_BYTES (by its declared length first, then as it streams). */
async function boundedBody(res: Response, id: number): Promise<Uint8Array> {
  const tooBig = () => new Error(`工件 ${id} 下载失败：超过 ${ARCHIVE_MAX_BYTES} 字节`);
  if (Number(res.headers.get("content-length") ?? 0) > ARCHIVE_MAX_BYTES) { await res.body?.cancel().catch(() => { /* 已按超限判失败：取消读流出错不改结论 */ }); throw tooBig(); }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > ARCHIVE_MAX_BYTES) { await reader.cancel().catch(() => { /* 已按超限判失败：取消读流出错不改结论 */ }); throw tooBig(); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
/** Tests only. */
export const resetCiProofPortCache = (): void => { commits.clear(); files.clear(); jobLists.clear(); archives.clear(); archiveBytes = 0; };
/** Tests only. */
export const ciProofArchiveMemory = (): { count: number; bytes: number } => ({ count: archives.size, bytes: archiveBytes });

function slug(repo: string): string {
  if (!REPO.test(repo)) throw new Error(`仓库名不合法：${repo.slice(0, 80)}`);
  return repo;
}
function fullSha(sha: string, what: string): string {
  if (!SHA.test(sha)) throw new Error(`${what} 不是完整 SHA`);
  return sha.toLowerCase();
}

/** The run-wide checkout an attempt recorded is this run's subject: the head itself (push) or a merge of it (pull_request / dispatch). */
function isRunCheckout(event: string, headSha: string, c: CiProofCommit): boolean {
  const eq = (a: string | undefined) => !!a && a.toLowerCase() === headSha.toLowerCase();
  if (event === "push") return eq(c.sha);
  if (event === "pull_request") return c.parents.length === 2 && eq(c.parents[1]);
  return event === "workflow_dispatch" && c.parents.length === 2 && eq(c.parents[0]);
}

interface PortOpts { cwd?: string; fetch?: Fetch }
type Reads = ReturnType<typeof ghReads>;

/** The raw reads every port method is built from: the guarded GET, an artifact archive, a commit, the reuse reader's API. */
function ghReads(command: Command, opts: PortOpts) {
  const env = { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };
  const http: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const run = async (argv: string[], timeoutMs = 30_000): Promise<string> => {
    const r = await command(argv, { cwd: opts.cwd, env, timeoutMs });
    if (r.code !== 0 || r.timedOut) throw new Error(`${argv.slice(0, 2).join(" ")} 失败：${oneLine(r.stderr) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
  const get = async (path: string, raw = false): Promise<string> => {
    if (!API_PATH.test(path)) throw new Error(`证明端口只读固定的 GET 路径，拒绝 ${path.slice(0, 120)}`);
    return run(["gh", "api", "-H", `Accept: application/vnd.github${raw ? ".raw" : "+json"}`, path.slice(1)]);
  };
  const api = async (path: string): Promise<unknown> => JSON.parse(await get(path));
  /** One artifact archive: the token is asked right before the request (a guarded spawn), the signed redirect is followed without it. */
  const download = async (id: number): Promise<Uint8Array> => {
    if (!posInt(id)) throw new Error("工件 id 不合法");
    const key = `${repoOf(id).toLowerCase()}#${id}`, hit = archiveHit(key);
    if (hit) return hit; // an artifact id never gets other bytes; whether it still exists is the caller's live list
    const token = (await run(["gh", "auth", "token"])).trim(), signal = () => AbortSignal.timeout(60_000);
    const first = await http(`${API_ROOT}/repos/${repoOf(id)}/actions/artifacts/${id}/zip`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, redirect: "manual", signal: signal() });
    const to = first.headers.get("location"), res = to ? await http(to, { signal: signal() }) : first;
    if (!res.ok) throw new Error(`工件 ${id} 下载失败：HTTP ${res.status}`);
    return keepArchive(key, await boundedBody(res, id));
  };
  const owners = new Map<number, string>(); // artifact id → the repository it was listed under: download never takes a repo from a caller
  const repoOf = (id: number): string => {
    const repo = owners.get(id);
    if (!repo) throw new Error(`工件 ${id} 不是本端口列出来的`);
    return repo;
  };
  /** unzip reads a file, so the bytes are stashed in a private temp directory for the one call. */
  const unzipWith = async (zip: Uint8Array, args: string[]): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "ci-proof-"));
    try {
      writeFileSync(join(dir, "a.zip"), zip);
      return await run(["unzip", ...args.slice(0, 1), join(dir, "a.zip"), ...args.slice(1)]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const reuseApi = (repo: string): CiReuseApi => ({
    api: async (path) => {
      const value = await api(path);
      for (const a of [value, ...list(obj(value).artifacts)]) if (posInt(obj(a).id) && obj(a).archive_download_url) owners.set(obj(a).id as number, repo);
      return value;
    },
    download,
    entries: async (zip) => (await unzipWith(zip, ["-Z1"])).split("\n").filter(Boolean),
    unzip: (zip, name) => unzipWith(zip, ["-p", name]),
  });
  const commit = async (repo: string, sha: string): Promise<CiProofCommit> => {
    const key = `${slug(repo).toLowerCase()}@${fullSha(sha, "commit")}`, hit = commits.get(key);
    if (hit) return hit;
    const c = obj(await api(`/repos/${repo}/git/commits/${fullSha(sha, "commit")}`));
    const out = { sha: fullSha(text(c.sha), "commit.sha"), tree: fullSha(text(obj(c.tree).sha), "commit.tree"), parents: list(c.parents).map((p) => fullSha(text(p.sha), "parent")) };
    return keep(commits, key, out);
  };
  /** The verifier's own revocation list (a repository variable); a variable that does not exist is an empty list, any other failure throws. */
  const revoked = async (repo: string): Promise<number[]> => {
    const r = await command(["gh", "api", `repos/${repo}/actions/variables/${REVOKED_VARIABLE}`], { cwd: opts.cwd, env, timeoutMs: 30_000 });
    if (r.code !== 0 && /HTTP 404/.test(r.stderr)) return [];
    if (r.code !== 0 || r.timedOut) throw new Error(`撤销名单读不出：${oneLine(r.stderr) || "timeout"}`);
    return text(obj(parse(r.stdout)).value).split(/[\s,]+/).map(Number).filter(posInt);
  };
  return { get, api, download, commit, reuseApi, revoked };
}

/** The jobs of one attempt; kept once the run read back as completed on that attempt (a later attempt is another key). */
async function attemptJobs(api: Reads["api"], repo: string, runId: number, attempt: number, done: boolean): Promise<Obj[]> {
  const key = `${repo.toLowerCase()}#${runId}#${attempt}`, hit = jobLists.get(key);
  if (hit) return hit;
  const page = obj(await api(`/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PER_PAGE}`)), rows = list(page.jobs);
  if (page.total_count !== rows.length) throw new Error(`run ${runId} 的作业列表不完整`);
  return done ? keep(jobLists, key, rows) : rows;
}

/**
 * One run as evidence, as GitHub has it now: its latest attempt, that attempt's jobs, its `ci-proof` archive (still listed, not
 * expired, digest-checked) and its reuse receipts against the current revocation list.
 */
async function readRun({ api, download, commit, reuseApi, revoked }: Reads, repo: string, runId: number): Promise<CiProofRead> {
  const base = `/repos/${repo}/actions/runs/${runId}`, raw = obj(await api(base));
  const attempt = Number(raw.run_attempt), event = text(raw.event), headSha = text(raw.head_sha);
  if (!posInt(attempt)) throw new Error(`run ${runId} 没有 attempt`);
  const jobRows = await attemptJobs(api, repo, runId, attempt, text(raw.status) === "completed");
  const rapi = reuseApi(repo), arts = obj(await rapi.api(`${base}/artifacts?name=${CI_PROOF_ARTIFACT}&per_page=${PER_PAGE}`)).artifacts;
  if (!Array.isArray(arts)) throw new Error(`run ${runId} 的工件列表读不懂`);
  const row = arts.map(ciReuseArtifactRow).filter((a) => a.name === CI_PROOF_ARTIFACT && a.runId === runId && !a.expired).sort((a, b) => b.id - a.id)[0];
  let artifact: CiRunEvidence["artifact"] = null, checkout: string | null = null, tree: string | null = null;
  if (row) {
    const zip = await download(row.id);
    if (row.digest === null || row.digest.toLowerCase() !== ciReuseDigest(zip)) throw new Error(`工件 ${row.id} 下载内容的摘要与登记的不符或缺失`);
    const names = await rapi.entries(zip), member = async (n: string) => (names.includes(n) ? parse(await rapi.unzip(zip, n)) : null);
    const report = obj(await member("report.json")), manifest = await member("manifest.json");
    // The report says which attempt wrote this archive (the upload overwrites): an archive left by an earlier attempt is not this attempt's.
    const mine = report.runId === runId && report.attempt === attempt;
    if (manifest !== null) artifact = { runId: row.runId, attempt: posInt(report.attempt) ? report.attempt : 0, digest: text(report.manifestDigest), content: manifest };
    if (mine && SHA.test(text(report.checkout))) {
      const c = await commit(repo, text(report.checkout));
      if (isRunCheckout(event, headSha, c)) { checkout = c.sha; tree = c.tree; }
    }
  }
  const evidence: CiRunEvidence = {
    origin: "actions-api", repo: text(obj(raw.repository).full_name), runId, attempt, latestAttempt: attempt,
    // pull_request loads the workflow from the merge ref it checks out; push and dispatch from the commit the API names
    workflow: { path: text(raw.path).split("@")[0]!, sha: event === "pull_request" ? checkout ?? "" : headSha },
    headSha, status: text(raw.status), conclusion: text(raw.conclusion) || null,
    jobs: jobRows.map((j) => ({ name: text(j.name), attempt: Number(j.run_attempt), conclusion: text(j.conclusion) || null, checkoutSha: checkout, checkoutTree: tree })),
    artifact,
    reuse: await readCiRunReuse(repo, { runId, attempt }, rapi, await revoked(repo)),
  };
  return { evidence, event, checkout };
}

/** The gh-backed port. `command` is the pass's guarded runner (checked before each spawn and after its exit); the CLI passes runBounded. */
export function ghCiProofPort(command: Command, opts: PortOpts = {}): CiProofPort {
  const g = ghReads(command, opts), { get, api, commit } = g;
  return {
    async mainHead(repo) { return fullSha(text(obj(obj(await api(`/repos/${slug(repo)}/git/ref/heads/main`)).object).sha), "main"); },
    async pull(repo, pr) {
      if (!posInt(pr)) throw new Error("PR 号不合法");
      const p = obj(await api(`/repos/${slug(repo)}/pulls/${pr}`));
      const merge = text(p.merge_commit_sha);
      return { head: fullSha(text(obj(p.head).sha), "PR head"), base: fullSha(text(obj(p.base).sha), "PR base"), state: text(p.state), merge: SHA.test(merge) ? merge.toLowerCase() : null };
    },
    commit,
    async file(repo, sha, path) {
      if (!/^[\w./-]+$/.test(path) || path.includes("..")) throw new Error(`文件路径不合法：${path.slice(0, 80)}`);
      const key = `${slug(repo).toLowerCase()}@${fullSha(sha, "commit")}:${path}`;
      return files.get(key) ?? keep(files, key, await get(`/repos/${repo}/contents/${path}?ref=${fullSha(sha, "commit")}`, true));
    },
    async runs(repo, headSha) {
      const page = obj(await api(`/repos/${slug(repo)}/actions/runs?head_sha=${fullSha(headSha, "head")}&per_page=${PER_PAGE}`)), rows = list(page.workflow_runs);
      if (page.total_count !== rows.length) throw new Error("这个 head 的 run 列表不完整");
      return rows.filter((r) => text(r.path).split("@")[0] === CI_PROOF_WORKFLOW && posInt(r.id))
        .map((r) => ({ id: r.id as number, event: text(r.event), headSha: text(r.head_sha), status: text(r.status), title: text(r.display_title) })).sort((a, b) => b.id - a.id);
    },
    async read(repo, runId) {
      if (!posInt(runId)) throw new Error("run id 不合法");
      return readRun(g, slug(repo), runId);
    },
  };
}
