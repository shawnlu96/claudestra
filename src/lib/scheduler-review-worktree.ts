/**
 * The per-card reviewer's own checkout: a detached linked worktree of the author's repository, pinned to the head under
 * review before every dispatch. It shares the object store, so a head the author committed is visible without a fetch,
 * and the author's later commits never shift what the reviewer reads. A reviewer that left tracked edits is not
 * overwritten: the dispatch stops for PM. This isolates files only — the session's permission mode is the runtime's.
 * Reviewers keep their test HOME / TMPDIR under `.review-tmp/` (peer-pr-spec.ts); the repository's shared exclude lists it, so
 * retirement's plain `git worktree remove` (no --force) is not stopped by it. tests/scheduler-review-worktree*.test.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Git = (args: string[]) => Promise<{ code: number; out: string }>;
export type Pinned = { dir: string } | { manual: string };

export const git: Git = async (args) => {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: (code === 0 ? out : err || out).trim() };
};

/** The commit a checkout sits on, or null when it is not a git checkout. */
export function gitHeadSync(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** null = no tracked file differs from HEAD (index or working tree); otherwise what changed, or why it could not be read. */
export function gitDirtySync(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=no"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return `读不了工作区状态：${r.stderr.toString().trim().slice(0, 200)}`;
  const out = r.stdout.toString().trim();
  return out ? out.split("\n").slice(0, 5).join("; ") : null;
}

/** Move the reviewer's checkout to `head`, refusing when the reviewer changed tracked files. */
export async function pinReviewWorktree(dir: string, head: string, g: Git = git): Promise<Pinned> {
  const st = await g(["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
  if (st.code !== 0) return { manual: `审查 worktree ${dir} 读不了：${st.out}`.slice(0, 400) };
  if (st.out) return { manual: `审查 worktree 有已跟踪文件被改过（审查员不该改被审代码），不覆盖：${st.out.split("\n").slice(0, 5).join("; ")}`.slice(0, 400) };
  const co = await g(["-C", dir, "checkout", "-q", "--detach", head]);
  if (co.code !== 0) return { manual: `审查 worktree 切不到 ${head}：${co.out}`.slice(0, 400) };
  const at = await g(["-C", dir, "rev-parse", "HEAD"]);
  return at.code === 0 && at.out === head ? { dir } : { manual: `审查 worktree 切完不在 ${head}（在 ${at.out}）` };
}

/** The reviewer's scratch folder (tests' HOME / TMPDIR), and the name some reviewers used before it was fixed. */
const REVIEW_TMP_DIR = ".review-tmp";
export const REVIEW_EXCLUDES = [`/${REVIEW_TMP_DIR}/`, "/.review-env/"] as const;

/**
 * Make sure the shared `info/exclude` of the repository `dir` belongs to (`git rev-parse --git-common-dir`, so every linked
 * worktree sees it) lists REVIEW_EXCLUDES: missing lines are appended, nothing else is touched. null = done; otherwise why not.
 */
export async function ensureReviewExcludes(dir: string, g: Git = git): Promise<string | null> {
  const common = await g(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0 || !common.out) return `读不出公共 git 目录：${common.out}`.slice(0, 300);
  const file = join(common.out, "info", "exclude");
  try {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
    const missing = REVIEW_EXCLUDES.filter((l) => !have.has(l));
    if (!missing.length) return null;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    return null;
  } catch (e) { return `写不了 ${file}：${(e as Error).message}`.slice(0, 300); }
}

/** Exclude the reviewers' scratch folders, then pin. A failed exclude only warns: the review goes on, retirement then hands to PM. */
async function excludeAndPin(dir: string, head: string, g: Git): Promise<Pinned> {
  const why = await ensureReviewExcludes(dir, g);
  if (why) console.error(`⚠️ [review-worktree] ${dir} 的临时目录没进 exclude（收尾删 worktree 会被挡、交 PM）：${why}`);
  return pinReviewWorktree(dir, head, g);
}

/** Create `dir` (once) from the author's repository, keep the scratch folders out of git status, and pin it. */
export async function openReviewWorktree(authorDir: string, dir: string, head: string | null, g: Git = git): Promise<Pinned> {
  if (!head) return { manual: "卡上没有交付 head，审查 worktree 不知道固定到哪" };
  if (existsSync(dir)) return excludeAndPin(dir, head, g);
  const top = await g(["-C", authorDir, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { manual: `执行者目录 ${authorDir} 不是 git 仓库，建不了独立的审查 worktree` };
  const add = await g(["-C", authorDir, "worktree", "add", "--detach", dir, head]);
  if (add.code !== 0) return { manual: `建审查 worktree 失败：${add.out}`.slice(0, 400) };
  return excludeAndPin(dir, head, g);
}
