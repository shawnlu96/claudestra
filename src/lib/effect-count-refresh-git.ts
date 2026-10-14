/**
 * merge-arch-EFFAUTO1 · git side of the effect-site count refresh, in a scratch worktree of the project's repoDir at the PR head
 * whose CI was red only on the inventory counts (effect-count-refresh.ts decides when). Nothing from the PR is ever run
 * (EFFSAFE1): the rewrite is this process's own rewriteInventory over this process's scan (headScan), the PR tree only data.
 * Refreshable only when all hold:
 * 1. the head is not itself a refresh commit (a refreshed head red on counts again goes back to fix: no chasing main), and the PR
 *    touches none of SKIPAUTO1's JUDGE_GLOBS (scanner / judge), both checked before any worktree exists;
 * 2. the inventory text outside the SKIP_EFFECT_FILES literal equals the merge base's (exit code 2 otherwise: it cannot be checked
 *    without running it), the rewrite needs no person (exit code 1: an unregistered file; an entry to delete) and changes something;
 * 3. it changed src/lib/scheduler-v2-skip-effects.ts (a `100644` blob and a regular file, written without following links) and
 *    nothing else, committed with REFRESH_SUBJECT on top of the head;
 * 4. SKIPAUTO1's judge (skip-effects-auto-scope.ts checkSkipEffectsAutoScope, head → refresh commit, the PR's whole file list
 *    against main) classes the commit as a pure count change matching the trusted scan.
 * Reads take only regular files no larger than BLOB_LIMIT (every path component lstat-ed, never a link, FIFO or device), and
 * every git command but fetch / worktree add / ls-remote / push runs with worktreeEnv (no token-like variable reaches it).
 * pushCountRefresh sends it as the fast-forward head → refresh commit (no `+`, no --force) under a lease pinned to the CI head,
 * so the ref is updated only while the remote branch is still exactly the head CI ran on (the server compares it atomically).
 * Any git error, timeout or mismatch is a refusal. tests/effect-count-refresh-git.test.ts.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopeDiff, ScopeFile } from "./order-deliver-scope-git.js";
import { gitReader, originIs } from "./review-main-carry-proof.js";
import { runBounded } from "./run-bounded.js";
import { inventoryLines } from "./skip-effects-auto-scope-scan.js";
import { checkSkipEffectsAutoScope, headScan, JUDGE_GLOBS, SKIP_EFFECTS_INVENTORY } from "./skip-effects-auto-scope.js";
import { rewriteInventory } from "./skip-effects-rewrite.js";

/** The one commit message this mechanism writes; a head carrying it is never refreshed again. */
export const REFRESH_SUBJECT = "chore(skip-effects): refresh effect-site counts";
const SHA = /^[a-f0-9]{40}$/;
const MAIN_REF = "refs/remotes/origin/main";
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
/** runBounded stops reading at 1 MiB: a listing near that may be cut, so it is no proof of "the PR did not touch the scanner". */
const LIST_LIMIT = 900 * 1024;
const BLOB_LIMIT = 512 * 1024;
/** Plain files only: a symlink (120000) or submodule entry is never read as source. */
const REGULAR = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/;

export interface RefreshTrialInput { repoDir: string; repository: string; branch: string; head: string }
interface RefreshEntry { file: string; gate: string; from: string; to: string }
export type RefreshTrial = Readonly<{ ok: true; sha: string; entries: readonly RefreshEntry[]; files: readonly string[] }
  | { ok: false; reason: string; exitCode?: number; files?: readonly string[]; classification?: readonly string[] }>;
export interface RefreshPushInput { repoDir: string; branch: string; head: string; sha: string }
export type RefreshPush = Readonly<{ ok: true } | { ok: false; moved: boolean; reason: string }>;

type GitRun = (cwd: string, args: string[], opts?: { timeoutMs?: number; okCodes?: number[] }) => Promise<{ code: number; stdout: string }>;
type Objects = NonNullable<ScopeDiff["objects"]>;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);
const ENV = { DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };
/** What git needs to find itself, the user's config (identity) and a temp dir; nothing token-like, whatever the scheduler holds. */
const WORKTREE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER"] as const;

/** The environment of every git command that reads or writes the PR's tree: the allowlist above plus ENV, never `...process.env`. */
export function worktreeEnv(from: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of WORKTREE_ENV_KEYS) if (from[k] !== undefined) env[k] = from[k]!;
  return { ...env, ...ENV };
}

/** The scheduler's own git: no prompt, no channel identity, no hooks; a timeout or an unexpected exit throws with git's first words. */
function refreshGit(command: typeof runBounded, env: Record<string, string | undefined>): GitRun {
  return async (cwd, args, opts = {}) => {
    const r = await command(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, timeoutMs: opts.timeoutMs ?? 30_000 });
    if (r.timedOut || r.code === null) throw new Error(`git ${args[0]} 超时`);
    if (!(opts.okCodes ?? [0]).includes(r.code)) throw new Error(`git ${args[0]} 失败：${oneLine(r.stderr) || `exit ${r.code}`}`);
    return { code: r.code, stdout: r.stdout };
  };
}
/** fetch / worktree add and remove / ls-remote / push in repoDir: they need the user's credential helper and never touch PR files. */
const remoteGit = (command: typeof runBounded) => refreshGit(command, { ...process.env, ...ENV });

const refuse = (reason: string, more: Omit<Extract<RefreshTrial, { ok: false }>, "ok" | "reason"> = {}): RefreshTrial =>
  Object.freeze({ ok: false, reason, ...more });

/** Git's blob id of raw bytes (sha1 of `blob <len>\0<bytes>`): what makes a disk read stand for the object. */
const blobOid = (bytes: Uint8Array): string => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** wt/path when every directory on the way is a real directory and the leaf a regular file within BLOB_LIMIT; else null. */
async function regularIn(wt: string, path: string): Promise<string | null> {
  const parts = path.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  let at = wt;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const st = await lstat(at).catch(() => null); // missing or unreadable is "not a regular file here": the caller refuses or falls back
    if (!st || !(i === parts.length - 1 ? st.isFile() && st.size <= BLOB_LIMIT : st.isDirectory())) return null;
  }
  return at;
}
/** O_NOFOLLOW: a link swapped in after the lstat fails to open; O_NONBLOCK: a FIFO never blocks the open. */
const SAFE_OPEN = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The bytes of a regular file of the checkout (see regularIn), or null; never follows a link, never waits on a FIFO. */
async function readRegular(wt: string, path: string): Promise<Uint8Array | null> {
  const at = await regularIn(wt, path);
  // a failed open is the same "no such regular file" as regularIn's null: the object is then read from git or refused
  const fh = at ? await open(at, constants.O_RDONLY | SAFE_OPEN).catch(() => null) : null;
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > BLOB_LIMIT) return null;
    const buf = Buffer.alloc(st.size);
    return buf.subarray(0, (await fh.read(buf, 0, st.size, 0)).bytesRead);
  } finally { await fh.close(); }
}

/** Overwrite a regular file of the checkout in place; false (nothing written) when it is not one or the open fails. */
async function writeRegular(wt: string, path: string, text: string): Promise<boolean> {
  const at = await regularIn(wt, path);
  // a failed open means the file is not the regular one regularIn saw: false, the trial refuses without writing
  const fh = at ? await open(at, constants.O_WRONLY | constants.O_TRUNC | SAFE_OPEN).catch(() => null) : null;
  if (!fh) return false;
  try { await fh.writeFile(text); return true; } finally { await fh.close(); }
}

/**
 * SKIPAUTO1's object port over the scratch worktree. A path is read only when commit's tree holds it as a plain blob, and its
 * bytes are taken only when they hash to that blob's id: first the checkout's regular file (readRegular), else the object itself
 * (`git cat-file`, size-capped; runBounded decodes in chunks, so a lossy decode fails the id check and is a read failure).
 * Verified bytes are kept by id, so the inventory as it was at the head stays readable after the rewrite. Fail-closed throughout.
 */
function objectsOf(git: GitRun, wt: string, prHead: () => string): Objects {
  const exact = (c: string) => { if (!SHA.test(c)) throw new Error("要完整 commit SHA"); return c; };
  const trees = new Map<string, Map<string, string>>(), verified = new Map<string, Uint8Array>();
  const rows = (out: string) => out.split("\0").filter(Boolean).map((l) => REGULAR.exec(l)).filter((m) => !!m);
  const oidOf = async (commit: string, path: string) => {
    const known = trees.get(commit)?.get(path);
    if (known) return known;
    const hit = rows((await git(wt, ["ls-tree", "-z", "--full-tree", exact(commit), "--", path])).stdout).find((m) => m[3] === path);
    if (!hit) throw new Error(`${path} 在 ${commit.slice(0, 12)} 不是普通文件`);
    return hit[2]!;
  };
  const fromObject = async (oid: string) => {
    const size = Number((await git(wt, ["cat-file", "-s", oid])).stdout.trim());
    if (!Number.isSafeInteger(size) || size > BLOB_LIMIT) return null;
    const bytes = Buffer.from((await git(wt, ["cat-file", "blob", oid])).stdout, "utf8");
    return blobOid(bytes) === oid ? bytes : null;
  };
  return {
    show: async (commit, path) => {
      const oid = await oidOf(commit, path), disk = verified.get(oid) ?? await readRegular(wt, path);
      const bytes = disk && blobOid(disk) === oid ? disk : await fromObject(oid);
      if (!bytes) throw new Error(`${path} 在 ${commit.slice(0, 12)} 的字节读不到或与 Git 对象不一致`);
      verified.set(oid, bytes);
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error(`${path} 不是合法 UTF-8`); }
    },
    list: async (commit, dir) => {
      const out = (await git(wt, ["ls-tree", "-r", "-z", "--full-tree", exact(commit), "--", `${dir}/`])).stdout;
      if (out.length > LIST_LIMIT || (out && !out.endsWith("\0"))) throw new Error(`${dir}/ 文件列表不完整`);
      const found = rows(out);
      trees.set(commit, new Map([...(trees.get(commit) ?? []), ...found.map((m) => [m[3]!, m[2]!] as const)]));
      return found.map((m) => m[3]!);
    },
    mergeBase: async (a, b) => {
      const out = (await git(wt, ["merge-base", exact(a), exact(b)])).stdout.trim();
      if (!SHA.test(out)) throw new Error("merge-base 读不到");
      return out;
    },
    prHead: async () => prHead(), // not pushed yet: the remote is checked against the CI head right before the push
  };
}

/** The PR's whole change against main (numstat, NUL separated), for SKIPAUTO1's "PR touched the scanner" rule. */
async function prFiles(git: GitRun, cwd: string, main: string, sha: string): Promise<ScopeFile[]> {
  const base = (await git(cwd, ["merge-base", main, sha])).stdout.trim();
  const out = (await git(cwd, ["diff", "--numstat", "-z", "--no-renames", base, sha, "--"], { timeoutMs: 60_000 })).stdout;
  if (out.length > LIST_LIMIT || (out && !out.endsWith("\0"))) throw new Error("PR 改动文件列表不完整");
  return out.split("\0").filter(Boolean).map((rec) => {
    const [added, deleted, ...path] = rec.split("\t");
    return { path: path.join("\t"), added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) };
  });
}

/** The inventory's bytes outside the SKIP_EFFECT_FILES literal (its first and closing lines included), or null with no literal. */
function outsideLiteral(text: string): string | null {
  const lines = text.split("\n");
  try {
    const { start, end } = inventoryLines(lines);
    return JSON.stringify([lines.slice(0, start), lines.slice(end)]);
  } catch { return null; } // no literal to rewrite: the caller refuses with exit code 2, as for any text it cannot check
}

/** Steps 2–4 inside the scratch worktree at the head; git here is the worktreeEnv one. */
async function refreshIn(git: GitRun, input: RefreshTrialInput, wt: string, main: string): Promise<RefreshTrial> {
  let refreshed = "";
  const objects = objectsOf(git, wt, () => refreshed), inv = SKIP_EFFECTS_INVENTORY;
  const text = await objects.show(input.head, inv), outside = outsideLiteral(text);
  if (outside === null || outside !== outsideLiteral(await objects.show(await objects.mergeBase(main, input.head), inv))) {
    return refuse("清单字面量以外有改动，不执行无法核对", { exitCode: 2 });
  }
  const r = rewriteInventory(text, await headScan(objects, input.head));
  if (r.unregistered.length) return refuse("skip-effects 退出 1（有未登记的新文件，要人定组）", { exitCode: 1 });
  if (r.removed.length) return refuse(`有条目要删，要人核：${r.removed.slice(0, 5).map((c) => c.file).join(", ")}`, { exitCode: 0 });
  if (r.text === text) return refuse("skip-effects 什么都没改（计数已和代码一致）", { exitCode: 0, files: [] });
  const entry = (await git(wt, ["ls-tree", "-z", "--full-tree", input.head, "--", inv])).stdout;
  if (!/^100644 blob [a-f0-9]{40}\t/.test(entry) || !entry.endsWith(`\t${inv}\0`) || entry.split("\0").length !== 2 || !await writeRegular(wt, inv, r.text)) {
    return refuse("清单在 head 不是普通文件（100644 blob），不写", { exitCode: 0 });
  }
  const files = (await git(wt, ["status", "--porcelain", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean).map((l) => l.slice(3));
  if (files.some((f) => f !== inv)) return refuse(`改动不只在清单：${files.slice(0, 5).join(", ")}`, { exitCode: 0, files });
  await git(wt, ["add", "--", inv]);
  await git(wt, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", REFRESH_SUBJECT]);
  const [sha, ...parents] = (await git(wt, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().toLowerCase().split(/\s+/);
  if (!sha || !SHA.test(sha) || parents.join(" ") !== input.head) return refuse("刷新提交的父提交不是 CI 的 head", { exitCode: 0, files });
  const changed = (await git(wt, ["diff", "--name-only", "-z", input.head, sha])).stdout.split("\0").filter(Boolean);
  if (changed.join() !== inv) return refuse(`刷新提交改了清单以外的文件：${changed.slice(0, 5).join(", ")}`, { exitCode: 0, files: changed });
  refreshed = sha;
  const diff: ScopeDiff = { base: input.head, files: await prFiles(git, wt, main, sha), filesComplete: true, objects };
  const judged = await checkSkipEffectsAutoScope(diff, [inv], sha, { mode: "on", privateRepo: false });
  if (!judged?.eligible) {
    const why = judged ? [...judged.reasons, ...(judged.error ? [oneLine(judged.error)] : [])] : ["清单不在 PR 改动里"];
    return refuse(`SKIPAUTO1 分类不是纯计数改动：${why.join("；").slice(0, 300)}`, { exitCode: 0, files: changed, classification: why });
  }
  return Object.freeze({ ok: true, sha, files: Object.freeze([...changed]),
    entries: Object.freeze(judged.entries.map(({ file, gate, from, to }) => ({ file, gate, from, to }))) });
}

/** Step 1 in repoDir, before any worktree: a refresh commit or a PR touching the scanner / judge is refused here. */
async function refusedEarly(git: GitRun, repo: string, main: string, head: string): Promise<RefreshTrial | null> {
  if ((await git(repo, ["log", "-1", "--format=%s", head])).stdout.trim() === REFRESH_SUBJECT) {
    return refuse("这个 head 本身就是计数刷新提交，再红在计数上不再自动推（防止和 main 来回追）");
  }
  const judge = (await prFiles(git, repo, main, head)).map((f) => f.path).filter((p) => JUDGE_GLOBS.some((g) => new Bun.Glob(g).match(p)));
  return judge.length ? refuse(`PR 改了扫描器 / 判定器，不自动刷新：${judge.slice(0, 5).join(", ")}`, { files: judge }) : null;
}

/** Never throws: every git failure, timeout or mismatch is `{ ok: false, reason }`. The scratch worktree is always removed. */
export async function trialCountRefresh(input: RefreshTrialInput, command: typeof runBounded = runBounded): Promise<RefreshTrial> {
  const git = remoteGit(command), local = refreshGit(command, worktreeEnv()), repo = input.repoDir;
  if (!SHA.test(input.head) || !BRANCH.test(input.branch)) return refuse("head 或分支名无效");
  let dir: string | null = null, wt = "";
  try {
    if (!await originIs(gitReader(repo, command), input.repository)) return refuse("repoDir 的 origin 不是 PR 所在仓库");
    await git(repo, ["fetch", "--no-tags", "--quiet", "origin", input.head, `+refs/heads/main:${MAIN_REF}`], { timeoutMs: 120_000 });
    const main = (await local(repo, ["rev-parse", "--verify", `${MAIN_REF}^{commit}`])).stdout.trim().toLowerCase();
    if (!SHA.test(main)) return refuse("main 不是完整 SHA");
    const early = await refusedEarly(local, repo, main, input.head);
    if (early) return early;
    dir = await mkdtemp(join(tmpdir(), "eff-count-refresh-"));
    wt = join(dir, "wt");
    await git(repo, ["worktree", "add", "--detach", "--quiet", wt, input.head], { timeoutMs: 120_000 });
    return await refreshIn(local, input, wt, main);
  } catch (e) {
    return refuse(`本地试刷新出错：${oneLine((e as Error).message)}`);
  } finally {
    if (dir) await cleanup(git, repo, wt, dir);
  }
}

/** Remove the scratch worktree, then its directory, then prune whatever registration is left; a failure is only logged. */
async function cleanup(git: GitRun, repo: string, wt: string, dir: string): Promise<void> {
  const removed = await git(repo, ["worktree", "remove", "--force", wt], { okCodes: [0, 128] }).catch((e: Error) => e);
  await rm(dir, { recursive: true, force: true });
  const pruned = await git(repo, ["worktree", "prune"]).catch((e: Error) => e);
  const failed = [removed, pruned].find((r): r is Error => r instanceof Error);
  if (failed) console.error(`⚠️ [eff-count-refresh] 临时 worktree 清理失败（不影响合并队列）：${failed.message.slice(0, 200)}`);
}

/** The remote branch's head now (ls-remote), or null when it is missing or ambiguous; throws on a git failure. */
export async function remoteBranchHead(repoDir: string, branch: string, command: typeof runBounded = runBounded): Promise<string | null> {
  if (!BRANCH.test(branch)) throw new Error("分支名无效");
  const ref = `refs/heads/${branch}`;
  const rows = (await remoteGit(command)(repoDir, ["ls-remote", "origin", ref], { timeoutMs: 60_000 })).stdout.trim().split("\n")
    .map((l) => l.split(/\s+/)).filter(([, name]) => name === ref);
  return rows.length === 1 && SHA.test(rows[0]![0]!.toLowerCase()) ? rows[0]![0]!.toLowerCase() : null;
}

/** The fast-forward push head → sha, atomically only while the remote branch is still the CI head; `moved` = it is not. */
export async function pushCountRefresh(input: RefreshPushInput, command: typeof runBounded = runBounded): Promise<RefreshPush> {
  const git = remoteGit(command);
  if (!SHA.test(input.head) || !SHA.test(input.sha) || !BRANCH.test(input.branch)) return { ok: false, moved: false, reason: "head 或分支名无效" };
  const ref = `refs/heads/${input.branch}`;
  const remoteAt = () => remoteBranchHead(input.repoDir, input.branch, command);
  const moved = (remote: string | null) => ({ ok: false as const, moved: true, reason: `PR 分支已不在 CI 的 head（远端 ${remote?.slice(0, 12) ?? "无"}）` });
  try {
    const parent = (await git(input.repoDir, ["rev-parse", "--verify", `${input.sha}^`])).stdout.trim().toLowerCase();
    if (parent !== input.head) return { ok: false, moved: false, reason: "刷新提交不是直接接在 CI 的 head 上" };
    const before = await remoteAt();
    if (before !== input.head) return moved(before);
    // The lease is the expected-old-head guard: git refuses unless the branch advertised by this very push is the CI head, and
    // sends that head as the old value, which the server compares atomically while updating the ref (a branch rewound to an
    // ancestor or deleted after the ls-remote above is refused; a plain push would take the rewind as a fast-forward). No `+`
    // and no --force: with the old value pinned to the head and sha^ = head checked above, the only update it can make is the
    // fast-forward head → sha.
    const pushed = await git(input.repoDir, ["push", "--quiet", `--force-with-lease=${ref}:${input.head}`, "origin", `${input.sha}:${ref}`],
      { timeoutMs: 120_000, okCodes: [0, 1] });
    if (pushed.code === 0) return { ok: true };
    const after = await remoteAt();
    return after === input.sha ? { ok: true } : after !== input.head ? moved(after) : { ok: false, moved: false, reason: "推送被拒" };
  } catch (e) {
    return { ok: false, moved: false, reason: `推送失败：${oneLine((e as Error).message)}` };
  }
}
