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
/** Raw stdout bytes (no decoding), rejects on non-zero exit / timeout / more than maxBytes. */
export type ScopeRunBytes = (cmd: string, args: string[], maxBytes: number) => Promise<Uint8Array>;

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

/**
 * 对象读取专用：原样收 stdout 字节、不解码（runBounded 按块有损解码、超 1 MiB 静默截断，SKIPAUTO1 r2 byte-integrity-1）。
 * 超过 maxBytes 立刻杀掉并抛；deadline 同 scopeRunIn，在调用本工厂时起算。
 */
export function scopeBytesIn(dir: string, timeoutMs = SCOPE_OBJECTS_TIMEOUT_MS): ScopeRunBytes {
  const deadline = Date.now() + timeoutMs;
  return async (cmd, args, maxBytes) => {
    const p = Bun.spawn([cmd, ...args], { cwd: dir, env: ghEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, Math.max(1, deadline - Date.now()));
    try {
      const chunks: Uint8Array[] = [];
      let n = 0;
      for await (const c of p.stdout) {
        n += c.length;
        if (n > maxBytes) { p.kill("SIGKILL"); throw new Error(`${cmd} ${args[0]} 输出超过 ${maxBytes} 字节`); }
        chunks.push(c);
      }
      const code = await p.exited;
      if (timedOut) throw new Error(`${cmd} ${args[0]} 超时`);
      if (code !== 0) throw new Error(`${cmd} ${args[0]} 失败（exit ${code}）`);
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
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
  return readScopeGit(pr[1], pr[2], head, scopeRunIn(dir), scopeRunIn(dir, SCOPE_OBJECTS_TIMEOUT_MS), scopeBytesIn(dir));
}

const SHA = /^[0-9a-f]{40}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * 对象读取上限：runBounded 超过 1 MiB 就静默丢掉后面的输出、退出码照旧是 0（run-bounded.ts CAP），截断的源码会被当成完整源码扫描
 * （SKIPAUTO1 r1 object-cap-1）。先按 cat-file -s 拒掉大对象，原始字节读取也以它封顶；超了一律抛，回人工。
 */
export const SCOPE_OBJECT_MAX_BYTES = 512 * 1024;
/**
 * 读取完整性的实现版本：读取 / 校验方式一变就改它（进 AUTO_SCOPE_RULE，旧版本写下的核准证据随之失效，r2 object-cap-1）。
 * 2：原始字节 + Git 对象 id 复算 + fatal UTF-8（保留 BOM）。
 */
export const SCOPE_OBJECT_READER = "raw-oid-fatal-utf8/2";
/** Git 对象 id：sha1 / sha256 over "blob <len>\0" + 原始字节 */
function blobOid(raw: Uint8Array, hexLen: number): string {
  const h = new Bun.CryptoHasher(hexLen === 64 ? "sha256" : "sha1");
  h.update(`blob ${raw.length}\0`); h.update(raw);
  return h.digest("hex");
}
/** objects port over the same clone; commits must be full SHAs, so a ref name never stands in for the exact head */
function scopeObjects(repo: string, pr: string, run: ScopeRun, bytes: ScopeRunBytes): ScopeObjects {
  const exact = (sha: string) => { if (!SHA.test(sha)) throw new Error("要完整 commit SHA"); return sha; };
  return {
    show: async (commit, path) => {
      const oid = (await run("git", ["rev-parse", "--verify", `${exact(commit)}:${path}`])).trim();
      if (!OID.test(oid)) throw new Error(`${path} 读不到对象 id`);
      const size = Number((await run("git", ["cat-file", "-s", oid])).trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${path} 读不到对象大小`);
      if (size > SCOPE_OBJECT_MAX_BYTES) throw new Error(`${path} 有 ${size} 字节，超过对象读取上限 ${SCOPE_OBJECT_MAX_BYTES}，读不完整`);
      const raw = await bytes("git", ["cat-file", "blob", oid], SCOPE_OBJECT_MAX_BYTES);
      // 字节身份：读到的原始字节复算对象 id，与 Git 给的 id 一致才算完整（长度相等不够，r2 byte-integrity-1）
      if (raw.length !== size || blobOid(raw, oid.length) !== oid) throw new Error(`${path} 读到的字节与 Git 对象不一致，读取不完整`);
      // 严格解码：非法 UTF-8 不替换成 U+FFFD；BOM 原样保留，不让 BOM 增删在比较里消失
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw); }
      catch { throw new Error(`${path} 不是合法 UTF-8`); }
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

/**
 * Shared command seam lets tests use real local git objects and an isolated PR metadata fixture.
 * 没给原始字节端口（私仓卡等）就不带对象端口：自动例外落成「读不到 Git 对象」，不退回有损的字符串读取。
 */
export async function readScopeGit(repo: string, pr: string, head: string, run: ScopeRun, objectsRun: ScopeRun = run,
  objectsBytes?: ScopeRunBytes): Promise<ScopeDiff> {
  const info = JSON.parse(await run("gh", ["pr", "view", pr, "--repo", repo, "--json", "baseRefOid,headRefOid"]));
  const base = info.baseRefOid;
  if (info.headRefOid !== head || typeof base !== "string" || !/^[0-9a-f]{40}$/.test(base)) throw new Error("PR head 已变化或 base 读不到");
  for (const sha of [head, base]) {
    // 缺对象先 fetch；fetch 也失败就整体抛给调用方登记「未能登记」，仍然派审
    await run("git", ["cat-file", "-e", `${sha}^{commit}`]).catch(() => run("git", ["fetch", "--no-tags", "--quiet", "origin", sha]));
  }
  return { base, files: scopeNumstat(await run("git", ["diff", "--numstat", "-z", "--no-renames", `${base}...${head}`, "--"])),
    ...(objectsBytes ? { objects: scopeObjects(repo, pr, objectsRun, objectsBytes) } : {}) };
}
