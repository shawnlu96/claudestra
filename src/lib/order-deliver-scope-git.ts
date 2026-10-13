/**
 * Read the PR's base and exact delivered head. argv only; fetch fills objects without checking out another branch.
 * Async on purpose: callers (bridge deliver, scheduler dispatch, lend offer) await it outside any ledger transaction —
 * a sync spawn here froze the bridge event loop and held BEGIN IMMEDIATE across a network fetch (i28-ASK2 r1 P1-3).
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { readRegistryAgentsSync } from "./registry.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { ghEnv } from "./peer-pr-github.js";

export interface ScopeFile { path: string; added: number | null; deleted: number | null }
/**
 * Exact-object source reads for the delivered PR (skip-effects-auto-scope.ts): blobs by commit + path, tree listing, the PR's
 * merge base and its head re-read for drift. Read only; the text is data, never imported or run.
 */
interface ScopeObjects {
  /** utf8 text of path at commit; rejects when the object is missing */
  show(commit: string, path: string): Promise<string>;
  /** every file path under dir (no trailing slash) at commit */
  list(commit: string, dir: string): Promise<string[]>;
  mergeBase(base: string, head: string): Promise<string>;
  /** the PR's head now (gh), to spot a push after the scope was read */
  prHead(): Promise<string>;
}
export interface ScopeDiff { base: string; files: ScopeFile[]; objects?: ScopeObjects }
/** Resolves stdout, rejects on non-zero exit / timeout. */
export type ScopeRun = (cmd: string, args: string[]) => Promise<string>;

const SCOPE_TIMEOUT_MS = 15_000;
/** source reads walk a few hundred blobs one by one; only run when the inventory file is out of scope */
const SCOPE_OBJECTS_TIMEOUT_MS = 90_000;

/** 在 dir 里跑 gh / git，整次共 timeoutMs（缺省 15 秒，deadline 在调用本工厂时起算）；scopeDiff 和私仓 cardScopeDiff 共用 */
export function scopeRunIn(dir: string, timeoutMs = SCOPE_TIMEOUT_MS): ScopeRun {
  const deadline = Date.now() + timeoutMs;
  return async (cmd, args) => {
    const r = await runBounded([cmd, ...args], { cwd: dir, env: ghEnv(), timeoutMs: Math.max(1, deadline - Date.now()) });
    if (r.timedOut) throw new Error(`${cmd} ${args[0]} 超时`);
    if (r.code !== 0) throw new Error(`${cmd} ${args[0]} 失败（exit ${r.code}）：${r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
    return r.stdout;
  };
}

/** --no-renames makes both sides of a move visible, including binary files and names containing tabs/newlines. */
export function scopeNumstat(out: string): ScopeFile[] {
  if (out && !out.endsWith("\0")) throw new Error("git numstat 文件列表不完整");
  return out.split("\0").filter(Boolean).map((row) => {
    const m = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (!m) throw new Error("git numstat 文件列表不完整");
    return { path: m[3], added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) };
  });
}

export async function scopeDiff(db: Database, task: LedgerTask, head: string): Promise<ScopeDiff> {
  const dir = readSchedulerConfig().projects[task.project]?.repoDir ??
    readRegistryAgentsSync().find((a) => a.name === (getSchedulerSession(db, task.id, "author")?.agent ?? task.agent))?.cwd;
  if (!dir) throw new Error("找不到本卡仓库目录");
  const pr = task.pr?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
  if (!pr || !/^[0-9a-f]{40}$/.test(head)) throw new Error("缺少本次 PR 或完整 head");
  return readScopeGit(pr[1], pr[2], head, scopeRunIn(dir), scopeRunIn(dir, SCOPE_OBJECTS_TIMEOUT_MS));
}

const SHA = /^[0-9a-f]{40}$/;
/**
 * 对象读取上限：runBounded 超过 1 MiB 就静默丢掉后面的输出、退出码照旧是 0（run-bounded.ts CAP），截断的源码会被当成完整源码扫描
 * （SKIPAUTO1 r1 object-cap-1）。远低于它：先按 cat-file -s 拒掉大对象，读完再核字节数，列表也不许逼近上限；超了一律抛，回人工。
 */
export const SCOPE_OBJECT_MAX_BYTES = 512 * 1024;
/** objects port over the same clone; commits must be full SHAs, so a ref name never stands in for the exact head */
function scopeObjects(repo: string, pr: string, run: ScopeRun): ScopeObjects {
  const exact = (sha: string) => { if (!SHA.test(sha)) throw new Error("要完整 commit SHA"); return sha; };
  return {
    show: async (commit, path) => {
      const spec = `${exact(commit)}:${path}`;
      const size = Number((await run("git", ["cat-file", "-s", spec])).trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${path} 读不到对象大小`);
      if (size > SCOPE_OBJECT_MAX_BYTES) throw new Error(`${path} 有 ${size} 字节，超过对象读取上限 ${SCOPE_OBJECT_MAX_BYTES}，读不完整`);
      const text = await run("git", ["cat-file", "blob", spec]);
      // 截断、按块解码切坏多字节字符、非 UTF-8 都会让字节数对不上：不当完整源码用
      if (Buffer.byteLength(text) !== size) throw new Error(`${path} 读到 ${Buffer.byteLength(text)} 字节，对象是 ${size} 字节，读取不完整`);
      return text;
    },
    list: async (commit, dir) => {
      const out = await run("git", ["ls-tree", "-r", "-z", "--name-only", exact(commit), "--", `${dir}/`]);
      if (Buffer.byteLength(out) > SCOPE_OBJECT_MAX_BYTES || (out && !out.endsWith("\0"))) throw new Error(`${dir}/ 文件列表不完整`);
      return out.split("\0").filter(Boolean);
    },
    mergeBase: async (base, head) => {
      const out = (await run("git", ["merge-base", exact(base), exact(head)])).trim();
      if (!SHA.test(out)) throw new Error("merge-base 读不到");
      return out;
    },
    prHead: async () => String(JSON.parse(await run("gh", ["pr", "view", pr, "--repo", repo, "--json", "headRefOid"])).headRefOid ?? ""),
  };
}

/** Shared command seam lets tests use real local git objects and an isolated PR metadata fixture. */
export async function readScopeGit(repo: string, pr: string, head: string, run: ScopeRun, objectsRun: ScopeRun = run): Promise<ScopeDiff> {
  const info = JSON.parse(await run("gh", ["pr", "view", pr, "--repo", repo, "--json", "baseRefOid,headRefOid"]));
  const base = info.baseRefOid;
  if (info.headRefOid !== head || typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) throw new Error("PR head 已变化或 base 读不到");
  for (const sha of [head, base]) {
    // 缺对象先 fetch；fetch 也失败就整体抛给调用方登记「未能登记」，仍然派审
    await run("git", ["cat-file", "-e", `${sha}^{commit}`]).catch(() => run("git", ["fetch", "--no-tags", "--quiet", "origin", sha]));
  }
  return { base, files: scopeNumstat(await run("git", ["diff", "--numstat", "-z", "--no-renames", `${base}...${head}`, "--"])),
    objects: scopeObjects(repo, pr, objectsRun) };
}
