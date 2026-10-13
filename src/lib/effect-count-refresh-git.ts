/**
 * merge-arch-EFFAUTO1 · git side of the effect-site count refresh, in a scratch worktree of the project's repoDir at the PR head
 * whose CI was red only on the inventory counts (effect-count-refresh.ts decides when). Refreshable only when all hold:
 * 1. the head is not itself a refresh commit (a refreshed head red on counts again goes back to fix: no chasing main);
 * 2. `bun scripts/skip-effects.ts` (EFFCNT1) exits 0: 1 (an unregistered file needs a person to pick its gate) and 2 (the
 *    inventory text disagrees with SKIP_EFFECT_FILES) are refusals carrying that exit code;
 * 3. it changed src/lib/scheduler-v2-skip-effects.ts and nothing else, committed with REFRESH_SUBJECT on top of the head;
 * 4. SKIPAUTO1's judge (skip-effects-auto-scope.ts checkSkipEffectsAutoScope, head → refresh commit, the PR's whole file list
 *    against main for its "PR touched the scanner" rule) classes the commit as a pure count change matching the trusted scan.
 * pushCountRefresh sends it as the fast-forward head → refresh commit (no `+`, no --force) under a lease pinned to the CI head,
 * so the ref is updated only while the remote branch is still exactly the head CI ran on (the server compares it atomically).
 * Any git error, timeout or mismatch is a refusal. tests/effect-count-refresh-git.test.ts.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopeDiff, ScopeFile } from "./order-deliver-scope-git.js";
import { gitReader, originIs } from "./review-main-carry-proof.js";
import { runBounded } from "./run-bounded.js";
import { checkSkipEffectsAutoScope, SKIP_EFFECTS_INVENTORY } from "./skip-effects-auto-scope.js";

/** The one commit message this mechanism writes; a head carrying it is never refreshed again. */
export const REFRESH_SUBJECT = "chore(skip-effects): refresh effect-site counts";
const SHA = /^[a-f0-9]{40}$/;
const MAIN_REF = "refs/remotes/origin/main";
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
/** runBounded stops reading at 1 MiB: a listing near that may be cut, so it is no proof of "the PR did not touch the scanner". */
const LIST_LIMIT = 900 * 1024;
const BLOB_LIMIT = 512 * 1024;

export interface RefreshTrialInput { repoDir: string; repository: string; branch: string; head: string }
interface RefreshEntry { file: string; gate: string; from: string; to: string }
export type RefreshTrial = Readonly<{ ok: true; sha: string; entries: readonly RefreshEntry[]; files: readonly string[] }
  | { ok: false; reason: string; exitCode?: number; files?: readonly string[]; classification?: readonly string[] }>;
export interface RefreshPushInput { repoDir: string; branch: string; head: string; sha: string }
export type RefreshPush = Readonly<{ ok: true } | { ok: false; moved: boolean; reason: string }>;

type GitRun = (cwd: string, args: string[], opts?: { timeoutMs?: number; okCodes?: number[] }) => Promise<{ code: number; stdout: string }>;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);
const ENV = { DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };

/** The scheduler's own git: no prompt, no channel identity, no hooks; a timeout or an unexpected exit throws with git's first words. */
function refreshGit(command: typeof runBounded): GitRun {
  const env = { ...process.env, ...ENV };
  return async (cwd, args, opts = {}) => {
    const r = await command(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env, timeoutMs: opts.timeoutMs ?? 30_000 });
    if (r.timedOut || r.code === null) throw new Error(`git ${args[0]} 超时`);
    if (!(opts.okCodes ?? [0]).includes(r.code)) throw new Error(`git ${args[0]} 失败：${oneLine(r.stderr) || `exit ${r.code}`}`);
    return { code: r.code, stdout: r.stdout };
  };
}

const refuse = (reason: string, more: Omit<Extract<RefreshTrial, { ok: false }>, "ok" | "reason"> = {}): RefreshTrial =>
  Object.freeze({ ok: false, reason, ...more });

/** Git's blob id of raw bytes (sha1 of `blob <len>\0<bytes>`): what makes a disk read stand for the object. */
const blobOid = (bytes: Uint8Array): string => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/**
 * SKIPAUTO1's object port over the scratch worktree. runBounded decodes in chunks (lossy for multi-byte text), so a blob is read
 * as raw bytes from the worktree (`kept` holds the inventory as it was at the head, before skip-effects rewrote it) and taken only
 * when those bytes hash to the object id git names for commit:path; any other case is a read failure (fail-closed).
 */
function objectsOf(git: GitRun, wt: string, sha: string, kept: Uint8Array): NonNullable<ScopeDiff["objects"]> {
  const exact = (c: string) => { if (!SHA.test(c)) throw new Error("要完整 commit SHA"); return c; };
  const trees = new Map<string, Map<string, string>>();
  const oidOf = async (commit: string, path: string) => trees.get(commit)?.get(path) ??
    (await git(wt, ["rev-parse", "--verify", `${exact(commit)}:${path}`])).stdout.trim();
  return {
    show: async (commit, path) => {
      const oid = await oidOf(commit, path);
      const disk = await readFile(join(wt, path)).catch(() => null);
      const bytes = [disk, kept].find((b) => b && b.length <= BLOB_LIMIT && blobOid(b) === oid);
      if (!bytes) throw new Error(`${path} 在 ${commit.slice(0, 12)} 的字节读不到或与 Git 对象不一致`);
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new Error(`${path} 不是合法 UTF-8`); }
    },
    list: async (commit, dir) => {
      const out = (await git(wt, ["ls-tree", "-r", "-z", "--full-tree", exact(commit), "--", `${dir}/`])).stdout;
      if (out.length > LIST_LIMIT || (out && !out.endsWith("\0"))) throw new Error(`${dir}/ 文件列表不完整`);
      const rows = out.split("\0").filter(Boolean).map((l) => /^\d+ blob ([a-f0-9]{40})\t(.+)$/.exec(l)).filter((m) => !!m);
      trees.set(commit, new Map([...(trees.get(commit) ?? []), ...rows.map((m) => [m[2]!, m[1]!] as const)]));
      return rows.map((m) => m[2]!);
    },
    mergeBase: async (a, b) => {
      const out = (await git(wt, ["merge-base", exact(a), exact(b)])).stdout.trim();
      if (!SHA.test(out)) throw new Error("merge-base 读不到");
      return out;
    },
    prHead: async () => sha, // not pushed yet: the remote is checked against the CI head right before the push
  };
}

/** The PR's whole change against main (numstat, NUL separated), for SKIPAUTO1's "PR touched the scanner" rule. */
async function prFiles(git: GitRun, wt: string, main: string, sha: string): Promise<ScopeFile[]> {
  const base = (await git(wt, ["merge-base", main, sha])).stdout.trim();
  const out = (await git(wt, ["diff", "--numstat", "-z", "--no-renames", base, sha, "--"], { timeoutMs: 60_000 })).stdout;
  if (out.length > LIST_LIMIT || (out && !out.endsWith("\0"))) throw new Error("PR 改动文件列表不完整");
  return out.split("\0").filter(Boolean).map((rec) => {
    const [added, deleted, ...path] = rec.split("\t");
    return { path: path.join("\t"), added: added === "-" ? null : Number(added), deleted: deleted === "-" ? null : Number(deleted) };
  });
}

/** Steps 1–4 inside the scratch worktree at the head. */
async function refreshIn(git: GitRun, input: RefreshTrialInput, wt: string, main: string, command: typeof runBounded): Promise<RefreshTrial> {
  if ((await git(wt, ["log", "-1", "--format=%s", input.head])).stdout.trim() === REFRESH_SUBJECT) {
    return refuse("这个 head 本身就是计数刷新提交，再红在计数上不再自动推（防止和 main 来回追）");
  }
  const kept = await readFile(join(wt, SKIP_EFFECTS_INVENTORY));
  const run = await command([process.execPath, "--no-env-file", "--config=/dev/null", "scripts/skip-effects.ts"],
    { cwd: wt, env: { ...process.env, ...ENV }, timeoutMs: 120_000 });
  if (run.timedOut || run.code === null) return refuse("skip-effects 超时");
  if (run.code !== 0) return refuse(`skip-effects 退出 ${run.code}${run.code === 1 ? "（有未登记的新文件，要人定组）" : run.code === 2 ? "（清单原文对不上）" : ""}`,
    { exitCode: run.code });
  const files = (await git(wt, ["status", "--porcelain", "-z", "--untracked-files=all"])).stdout.split("\0").filter(Boolean).map((l) => l.slice(3));
  if (!files.length) return refuse("skip-effects 什么都没改（计数已和代码一致）", { exitCode: 0, files });
  if (files.some((f) => f !== SKIP_EFFECTS_INVENTORY)) return refuse(`改动不只在清单：${files.slice(0, 5).join(", ")}`, { exitCode: 0, files });
  await git(wt, ["add", "--", SKIP_EFFECTS_INVENTORY]);
  await git(wt, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", REFRESH_SUBJECT]);
  const [sha, ...parents] = (await git(wt, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().toLowerCase().split(/\s+/);
  if (!sha || !SHA.test(sha) || parents.join(" ") !== input.head) return refuse("刷新提交的父提交不是 CI 的 head", { exitCode: 0, files });
  const changed = (await git(wt, ["diff", "--name-only", "-z", input.head, sha])).stdout.split("\0").filter(Boolean);
  if (changed.join() !== SKIP_EFFECTS_INVENTORY) return refuse(`刷新提交改了清单以外的文件：${changed.slice(0, 5).join(", ")}`, { exitCode: 0, files: changed });
  const diff: ScopeDiff = { base: input.head, files: await prFiles(git, wt, main, sha), filesComplete: true, objects: objectsOf(git, wt, sha, kept) };
  const judged = await checkSkipEffectsAutoScope(diff, [SKIP_EFFECTS_INVENTORY], sha, { mode: "on", privateRepo: false });
  if (!judged?.eligible) {
    const why = judged ? [...judged.reasons, ...(judged.error ? [oneLine(judged.error)] : [])] : ["清单不在 PR 改动里"];
    return refuse(`SKIPAUTO1 分类不是纯计数改动：${why.join("；").slice(0, 300)}`, { exitCode: 0, files: changed, classification: why });
  }
  return Object.freeze({ ok: true, sha, files: Object.freeze([...changed]),
    entries: Object.freeze(judged.entries.map(({ file, gate, from, to }) => ({ file, gate, from, to }))) });
}

/** Never throws: every git failure, timeout or mismatch is `{ ok: false, reason }`. The scratch worktree is always removed. */
export async function trialCountRefresh(input: RefreshTrialInput, command: typeof runBounded = runBounded): Promise<RefreshTrial> {
  const git = refreshGit(command), repo = input.repoDir;
  if (!SHA.test(input.head) || !BRANCH.test(input.branch)) return refuse("head 或分支名无效");
  let dir: string | null = null, wt = "";
  try {
    if (!await originIs(gitReader(repo, command), input.repository)) return refuse("repoDir 的 origin 不是 PR 所在仓库");
    await git(repo, ["fetch", "--no-tags", "--quiet", "origin", input.head, `+refs/heads/main:${MAIN_REF}`], { timeoutMs: 120_000 });
    const main = (await git(repo, ["rev-parse", "--verify", `${MAIN_REF}^{commit}`])).stdout.trim().toLowerCase();
    if (!SHA.test(main)) return refuse("main 不是完整 SHA");
    dir = await mkdtemp(join(tmpdir(), "eff-count-refresh-"));
    wt = join(dir, "wt");
    await git(repo, ["worktree", "add", "--detach", "--quiet", wt, input.head], { timeoutMs: 120_000 });
    return await refreshIn(git, input, wt, main, command);
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
  const rows = (await refreshGit(command)(repoDir, ["ls-remote", "origin", ref], { timeoutMs: 60_000 })).stdout.trim().split("\n")
    .map((l) => l.split(/\s+/)).filter(([, name]) => name === ref);
  return rows.length === 1 && SHA.test(rows[0]![0]!.toLowerCase()) ? rows[0]![0]!.toLowerCase() : null;
}

/** The fast-forward push head → sha, atomically only while the remote branch is still the CI head; `moved` = it is not. */
export async function pushCountRefresh(input: RefreshPushInput, command: typeof runBounded = runBounded): Promise<RefreshPush> {
  const git = refreshGit(command);
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
