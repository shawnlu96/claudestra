/**
 * merge-arch-KEYUNION1 · git side of the merge queue's local union merge, in a scratch worktree of the project's repoDir at the
 * reviewed PR head. Resolvable only when all three hold:
 * 1. with the scratch worktree's .gitattributes blanked, `git merge-tree` conflicts, and only on union files that main's
 *    .gitattributes names (git reads attributes from the current worktree, so a blank file there is "without attributes");
 * 2. a real `git merge --no-ff` of the fetched main, with main's union lines as core.attributesFile (a PR cut before the
 *    union line still merges like main will), exits 0 with no unmerged path and no conflict marker in the union files;
 * 3. the main-carry proof (review-main-carry-proof.ts) accepts it under the CARRY2 criteria, whatever mainCarryMerge says now:
 *    the switch only decides whether the post-push carry keeps the review or sends it back to re-review, never whether to push.
 * pushUnionMerge sends it with a lease on the reviewed head: the server updates the ref only while it still is that head, and the
 * merge descends from it, so the update is a fast-forward. Any git error or timeout is a refusal. tests/scheduler-merge-union*.test.ts.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitReader, originIs, reviewMainCarryProof } from "./review-main-carry-proof.js";
import { runBounded } from "./run-bounded.js";

const SHA = /^[a-f0-9]{40}$/;
const MAIN_REF = "refs/remotes/origin/main";
const MARKER = /^(?:<{7}|>{7}|={7})(?: |$)/m;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const GLOB = /[*?[\]!\\]/;

export interface UnionTrialInput { repoDir: string; repository: string; branch: string; reviewedHead: string }
export type UnionTrial = Readonly<{ ok: true; mergeSha: string; mainHead: string; files: readonly string[]; proof: string }
  | { ok: false; reason: string; mainHead?: string; files?: readonly string[] }>;
export interface UnionPushInput { repoDir: string; branch: string; reviewedHead: string; mergeSha: string }
export type UnionPush = Readonly<{ ok: true } | { ok: false; moved: boolean; reason: string }>;

type GitRun = (cwd: string, args: string[], opts?: { timeoutMs?: number; okCodes?: number[] }) => Promise<{ code: number; stdout: string }>;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** The scheduler's own git: no prompt, no channel identity; a timeout or an unexpected exit throws with git's first words. */
function unionGit(command: typeof runBounded = runBounded): GitRun {
  const env = { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" };
  return async (cwd, args, opts = {}) => {
    const r = await command(["git", ...args], { cwd, env, timeoutMs: opts.timeoutMs ?? 30_000 });
    if (r.timedOut || r.code === null) throw new Error(`git ${args[0]} 超时`);
    if (!(opts.okCodes ?? [0]).includes(r.code)) throw new Error(`git ${args[0]} 失败：${oneLine(r.stderr) || `exit ${r.code}`}`);
    return { code: r.code, stdout: r.stdout };
  };
}

/** Literal paths that a .gitattributes text marks merge=union; patterns with glob characters are left out (never matched). */
export function unionPaths(attributes: string): string[] {
  const out: string[] = [];
  for (const raw of attributes.split("\n")) {
    const [pattern, ...attrs] = raw.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#") || GLOB.test(pattern) || !attrs.includes("merge=union")) continue;
    out.push(pattern.replace(/^\/+/, ""));
  }
  return [...new Set(out)];
}

const refuse = (reason: string, mainHead?: string, files?: readonly string[]): UnionTrial =>
  Object.freeze({ ok: false, reason, ...(mainHead ? { mainHead } : {}), ...(files ? { files } : {}) });

/** Step 1: which files conflict when the scratch worktree carries no attributes. */
async function plainConflicts(git: GitRun, wt: string, head: string, main: string): Promise<string[] | null> {
  await writeFile(join(wt, ".gitattributes"), "");
  const r = await git(wt, ["-c", "core.attributesFile=/dev/null", "merge-tree", "--write-tree", "--name-only", "--no-messages", head, main],
    { okCodes: [0, 1] });
  const had = (await git(wt, ["cat-file", "-e", `${head}:.gitattributes`], { okCodes: [0, 1, 128] })).code === 0;
  if (had) await git(wt, ["checkout", "--quiet", head, "--", ".gitattributes"]);
  else await rm(join(wt, ".gitattributes"), { force: true });
  if ((await git(wt, ["status", "--porcelain"])).stdout.trim()) throw new Error("临时 worktree 还原 .gitattributes 后不干净");
  if (r.code === 0) return null;
  return r.stdout.trim().split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
}

/** Steps 2–3 inside the scratch worktree; `dir` holds the attributes file. */
async function mergeIn(git: GitRun, input: UnionTrialInput, wt: string, dir: string, main: string, union: string[],
  command: typeof runBounded): Promise<UnionTrial> {
  const files = await plainConflicts(git, wt, input.reviewedHead, main);
  if (!files) return refuse("不带 attributes 也能干净合并，DIRTY 不是 union 文件的冲突", main);
  if (!files.length) return refuse("merge-tree 报冲突但没列出文件", main);
  const outside = files.filter((f) => !union.includes(f));
  if (outside.length) return refuse(`冲突不只在 union 文件：${outside.slice(0, 5).join(", ")}`, main, files);
  const attrs = join(dir, "attributes");
  await writeFile(attrs, union.map((p) => `/${p} merge=union\n`).join(""));
  const message = `Merge origin/main into ${input.branch} (merge queue union: ${files.join(", ")})`;
  const merged = await git(wt, ["-c", `core.attributesFile=${attrs}`, "merge", "--no-ff", "--no-edit", "-m", message, main],
    { timeoutMs: 120_000, okCodes: [0, 1] });
  if (merged.code !== 0) return refuse("带 union 的真 git merge 仍有冲突", main, files);
  if ((await git(wt, ["ls-files", "-u"])).stdout.trim()) return refuse("合并后仍有未解决路径", main, files);
  for (const f of files) {
    if (MARKER.test((await git(wt, ["show", `HEAD:${f}`])).stdout)) return refuse(`${f} 合并结果里有冲突标记`, main, files);
  }
  const [mergeSha, ...parents] = (await git(wt, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().toLowerCase().split(/\s+/);
  if (!mergeSha || !SHA.test(mergeSha) || parents.join(" ") !== `${input.reviewedHead} ${main}`) return refuse("合并提交的父提交不是「审过的 head + main」", main, files);
  const proof = await reviewMainCarryProof({ repoDir: input.repoDir, repository: input.repository, base: "main", mainHead: main,
    oldHead: input.reviewedHead, newHead: mergeSha }, command, () => "on");
  if (!proof.ok) return refuse(`沿用证明不成立：${proof.reason}`, main, files);
  return Object.freeze({ ok: true, mergeSha, mainHead: main, files: Object.freeze([...files]), proof: proof.reason });
}

/** Never throws: every git failure, timeout or mismatch is `{ ok: false, reason }`. The scratch worktree is always removed. */
export async function trialUnionMerge(input: UnionTrialInput, command: typeof runBounded = runBounded): Promise<UnionTrial> {
  const git = unionGit(command), repo = input.repoDir;
  if (!SHA.test(input.reviewedHead) || !BRANCH.test(input.branch)) return refuse("head 或分支名无效");
  let dir: string | null = null, wt = "";
  try {
    if (!await originIs(gitReader(repo, command), input.repository)) return refuse("repoDir 的 origin 不是 PR 所在仓库");
    await git(repo, ["fetch", "--no-tags", "--quiet", "origin", input.reviewedHead, `+refs/heads/main:${MAIN_REF}`], { timeoutMs: 120_000 });
    const main = (await git(repo, ["rev-parse", "--verify", `${MAIN_REF}^{commit}`])).stdout.trim().toLowerCase();
    if (!SHA.test(main)) return refuse("main 不是完整 SHA");
    const attrs = await git(repo, ["show", `${main}:.gitattributes`], { okCodes: [0, 128] });
    const union = attrs.code === 0 ? unionPaths(attrs.stdout) : [];
    if (!union.length) return refuse("main 的 .gitattributes 没有 merge=union 文件", main);
    dir = await mkdtemp(join(tmpdir(), "merge-union-"));
    wt = join(dir, "wt");
    await git(repo, ["worktree", "add", "--detach", "--quiet", wt, input.reviewedHead], { timeoutMs: 120_000 });
    return await mergeIn(git, input, wt, dir, main, union, command);
  } catch (e) {
    return refuse(`本地试合并出错：${oneLine((e as Error).message)}`);
  } finally {
    if (dir) await cleanup(git, repo, wt, dir);
  }
}

async function cleanup(git: GitRun, repo: string, wt: string, dir: string): Promise<void> {
  try {
    await git(repo, ["worktree", "remove", "--force", wt], { okCodes: [0, 128] });
    await git(repo, ["worktree", "prune"]);
  } catch (e) {
    console.error(`⚠️ [merge-union] 临时 worktree 清理失败（只留下 ${wt}，不影响合并结果）：${(e as Error).message.slice(0, 200)}`);
  }
  await rm(dir, { recursive: true, force: true });
}

/** Only while the remote branch is still the reviewed head (checked first, then atomically by the lease); `moved` = it is not. */
export async function pushUnionMerge(input: UnionPushInput, command: typeof runBounded = runBounded): Promise<UnionPush> {
  const git = unionGit(command);
  if (!SHA.test(input.reviewedHead) || !SHA.test(input.mergeSha) || !BRANCH.test(input.branch)) return { ok: false, moved: false, reason: "head 或分支名无效" };
  const ref = `refs/heads/${input.branch}`;
  const remoteAt = async () => (await git(input.repoDir, ["ls-remote", "origin", ref], { timeoutMs: 60_000 })).stdout.trim().split("\n")
    .map((l) => l.split(/\s+/)).filter(([, name]) => name === ref).map(([sha]) => sha?.toLowerCase());
  const moved = (remote: (string | undefined)[]) => ({ ok: false as const, moved: true, reason: `PR 分支已不在审过的 head（远端 ${remote[0]?.slice(0, 12) ?? "无"}）` });
  try {
    // the lease is what makes the update a fast-forward: it only lands on the reviewed head, which the merge descends from
    if ((await git(input.repoDir, ["merge-base", "--is-ancestor", input.reviewedHead, input.mergeSha], { okCodes: [0, 1] })).code !== 0) {
      return { ok: false, moved: false, reason: "合并提交不是审过 head 的后代" };
    }
    const before = await remoteAt();
    if (before.length !== 1 || before[0] !== input.reviewedHead) return moved(before);
    // a ref that moved after the read above is refused by the server's compare-and-swap on the leased value
    const pushed = await git(input.repoDir, ["push", "--quiet", `--force-with-lease=${ref}:${input.reviewedHead}`, "origin", `${input.mergeSha}:${ref}`],
      { timeoutMs: 120_000, okCodes: [0, 1] });
    if (pushed.code === 0) return { ok: true };
    const after = await remoteAt();
    return after[0] === input.mergeSha ? { ok: true } : after[0] !== input.reviewedHead ? moved(after) : { ok: false, moved: false, reason: "推送被拒" };
  } catch (e) {
    return { ok: false, moved: false, reason: `推送失败：${oneLine((e as Error).message)}` };
  }
}
