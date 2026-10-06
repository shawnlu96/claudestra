/**
 * Read-only survey of a retired agent's checkout before it may go (agent-lifecycle-cleanup.ts): is it a linked worktree of the right
 * place, what tracked change it carries, and every file git would not keep (untracked, ignored, dotfiles, nested repos, symlinks).
 * The file list comes from our own lstat walk, not from git's lists: git only says which paths are tracked (`ls-files --stage`) and
 * which ignored roots are regenerable, so a file git does not mention is still archived. Nothing here writes.
 * Regenerable rule (REGENERABLE): an entry git reports ignored (`status --ignored`) whose own name is one of these is not archived
 * but listed in the manifest as excluded; anything else ignored (.env, logs, scratch output) is archived like untracked files.
 * Outputs are parsed from formats with no leading blank (status v2, ls-files --stage / -v): the git helper trims its output.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Git } from "./scheduler-review-worktree.js";

/** Dependency installs and build output: rebuilt from tracked sources, never evidence on their own. */
export const REGENERABLE: readonly string[] = ["node_modules", ".next", ".turbo", "dist", "build", "coverage"];
/** More than this much untracked data is not archived automatically (left in place for PM). */
const ARCHIVE_MAX_BYTES = 1024 ** 3;

export interface ArchiveEntry {
  /** path relative to the checkout */
  path: string;
  type: "file" | "symlink" | "dir";
  /** permission bits (mode & 0o7777) */
  mode: number;
  size: number;
  /** sha256 of the bytes (file) or of the link text (symlink); "" for a dir */
  sha: string;
  /** symlink only: the link text, never followed */
  link?: string;
  /** git reports it ignored (it does not block `git worktree remove`, which deletes it) */
  ignored: boolean;
}

interface TrackedChange { path: string; kind: "conflict" | "staged" | "modified" | "staged+modified" }

export interface Survey {
  /** the checkout's real path */
  dir: string;
  tracked: TrackedChange[];
  entries: ArchiveEntry[];
  /** ignored regenerable roots left out of the archive */
  excluded: string[];
  /** content hash of entries + excluded: the stable attempt id */
  id: string;
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Where git keeps this checkout: a linked worktree of a repo whose admin dir names it, and the top of that worktree. */
async function linkedWorktree(g: (...a: string[]) => ReturnType<Git>, real: string): Promise<string | null> {
  const where = await g("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel");
  const [gitDir, common, top] = where.out.split("\n");
  if (where.code !== 0 || !gitDir || !common || !top) return `读不出是不是 git worktree：${where.out}`;
  if (gitDir === common) return "是主仓库而不是 linked worktree，不碰";
  if (dirname(gitDir) !== join(common, "worktrees")) return `git 目录 ${gitDir} 不在 ${common}/worktrees 下，不认`;
  if ((await realpath(top).catch(() => "")) !== real) return `git 顶层是 ${top}，不是这个目录本身，不碰`;
  const list = await g("worktree", "list", "--porcelain");
  if (list.code !== 0) return `列不出 worktree：${list.out}`;
  const blocks = list.out.split("\n\n").map((b) => b.split("\n"));
  let mine: string[] | undefined;
  for (const b of blocks) {
    const p = b.find((l) => l.startsWith("worktree "))?.slice(9);
    if (p && (await realpath(p).catch(() => "")) === real) mine = b;
  }
  if (!mine) return "仓库的 worktree 登记里没有它，不碰";
  if (mine.some((l) => l === "locked" || l.startsWith("locked "))) return "worktree 被 lock 了（有人要留着），不碰";
  return null;
}

/** status --porcelain=v2 -z: tracked changes, and the ignored roots. */
function parseStatus(out: string): { tracked: TrackedChange[]; ignored: string[] } {
  const recs = out.split("\0");
  const tracked: TrackedChange[] = [], ignored: string[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const f = r.split(" ");
    if (r[0] === "!") ignored.push(r.slice(2).replace(/\/$/, ""));
    else if (r[0] === "u") tracked.push({ path: f.slice(10).join(" "), kind: "conflict" });
    else if (r[0] === "1" || r[0] === "2") {
      const [x, y] = f[1];
      tracked.push({ path: f.slice(r[0] === "1" ? 8 : 9).join(" "), kind: x !== "." && y !== "." ? "staged+modified" : x !== "." ? "staged" : "modified" });
      if (r[0] === "2") i++; // a rename / copy carries its origin path as the next record
    }
  }
  return { tracked, ignored };
}

const under = (p: string, roots: readonly string[]): boolean => roots.some((r) => p === r || p.startsWith(`${r}/`));

/** lstat walk of everything not tracked; a fifo / socket / device cannot be archived faithfully and refuses the whole survey. */
async function walk(real: string, tracked: Set<string>, skip: readonly string[], ignored: readonly string[]): Promise<ArchiveEntry[] | string> {
  const out: ArchiveEntry[] = [];
  let bytes = 0;
  const visit = async (rel: string): Promise<string | null> => {
    const names = (await readdir(join(real, rel))).sort();
    if (!names.length && rel) out.push({ path: rel, type: "dir", mode: (await lstat(join(real, rel))).mode & 0o7777, size: 0, sha: "", ignored: under(rel, ignored) });
    for (const n of names) {
      const p = rel ? `${rel}/${n}` : n;
      if ((!rel && n === ".git") || under(p, skip) || tracked.has(p)) continue;
      const st = await lstat(join(real, p));
      const base = { path: p, mode: st.mode & 0o7777, ignored: under(p, ignored) };
      if (st.isDirectory()) { const why = await visit(p); if (why) return why; continue; }
      if (st.isSymbolicLink()) {
        const link = await readlink(join(real, p));
        out.push({ ...base, type: "symlink", size: Buffer.byteLength(link), sha: sha(link), link });
        continue;
      }
      if (!st.isFile()) return `${p} 不是普通文件 / 链接 / 目录，归档保证不了原样`;
      if ((bytes += st.size) > ARCHIVE_MAX_BYTES) return `未跟踪资料超过 ${ARCHIVE_MAX_BYTES / 1024 ** 3}GB，不自动归档`;
      out.push({ ...base, type: "file", size: st.size, sha: sha(await readFile(join(real, p))) });
    }
    return null;
  };
  const why = await visit("");
  return why ?? out;
}

/** A refusal (string) or the survey. `real` must already be the checkout's verified real path. */
export async function surveyCheckout(git: Git, real: string): Promise<Survey | string> {
  const g = (...a: string[]) => git(["-C", real, ...a]);
  const linked = await linkedWorktree(g, real);
  if (linked) return linked;
  const stage = await g("ls-files", "-z", "--stage");
  if (stage.code !== 0) return `读不出已跟踪文件：${stage.out}`;
  const tracked = new Set<string>();
  for (const rec of stage.out.split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    if (rec.startsWith("160000 ")) return `含子模块 ${rec.slice(tab + 1)}，不自动处理`;
    tracked.add(rec.slice(tab + 1));
  }
  const tags = await g("ls-files", "-z", "-v");
  if (tags.code !== 0) return `读不出已跟踪文件标记：${tags.out}`;
  const hidden = tags.out.split("\0").filter((r) => r && (r[0] === "S" || /^[a-z]/.test(r))).map((r) => r.slice(2));
  if (hidden.length) return `有 skip-worktree / assume-unchanged 文件（改动 git status 看不见），不自动处理：${hidden.slice(0, 5).join(", ")}`;
  const head = await g("for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)");
  if (head.code !== 0) return `读不出 HEAD 在不在分支上：${head.out}`;
  if (!head.out) return "HEAD 上的提交不在任何分支 / 标签里（删了 worktree 就找不回），不自动处理";
  const st = await g("status", "--porcelain=v2", "-z", "--ignored=traditional", "--untracked-files=normal");
  if (st.code !== 0) return `读不了工作区状态：${st.out}`;
  const { tracked: changes, ignored } = parseStatus(st.out);
  const excluded = ignored.filter((p) => REGENERABLE.includes(basename(p))).sort();
  let entries: ArchiveEntry[] | string;
  try { entries = await walk(real, tracked, excluded, ignored); } catch (e) { return `列不全 worktree 里的文件：${(e as Error).message}`; }
  if (typeof entries === "string") return entries;
  const id = sha(JSON.stringify({ entries: entries.map(({ ignored: _i, ...e }) => e), excluded })).slice(0, 16);
  return { dir: real, tracked: changes, entries, excluded, id };
}

/** The checkout's real path when it is a real directory directly under the worktree root; a refusal otherwise. null = gone. */
export async function ownedPath(root: string, dir: string): Promise<{ real: string } | { why: string } | null> {
  const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : e));
  if (st === null) return null;
  if (st instanceof Error) return { why: `读不了 ${dir}：${st.message}` };
  if (!st.isDirectory()) return { why: st.isSymbolicLink() ? "是符号链接，不跟" : "不是目录，不碰" };
  if (dirname(resolve(dir)) !== resolve(root)) return { why: `不在 worktree 根 ${root} 下一层，外部路径不碰` };
  try {
    const real = await realpath(dir);
    return real === join(await realpath(root), basename(dir)) ? { real } : { why: `真实路径 ${real} 逃出了 worktree 根，不碰` };
  } catch (e) {
    return { why: `读不出真实路径：${(e as Error).message}` };
  }
}
