/** Untouched checkouts left by clean create failures can be reused; every uncertain case is preserved for PM. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Git } from "./scheduler-review-worktree.js";
import { writeTextAtomicSync } from "./state-file.js";

type Plan = { repo: string; worktree: string; branch: string; base: string };
const START_FILE = "scheduler-author-start.json";

/** Record the resolved base in Git's private worktree directory, so a later fetch cannot redefine this card's start. */
export async function addAuthorWorktree(git: Git, p: Plan, existing = false): Promise<{ code: number; out: string }> {
  const start = await git(["rev-parse", "--verify", `${p.base}^{commit}`]);
  if (start.code !== 0) return start;
  const add = await git(["worktree", "add", ...(existing ? [p.worktree, p.branch] : ["-b", p.branch, p.worktree, start.out])]); // existing: AREB1 rebuild, checked equal to start
  if (add.code !== 0) return add;
  const dir = await git(["-C", p.worktree, "rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return dir;
  try {
    writeTextAtomicSync(join(dir.out, START_FILE), JSON.stringify({ repo: p.repo, worktree: p.worktree, branch: p.branch, base: p.base, sha: start.out }));
    return add;
  } catch (e) { return { code: 1, out: `保存 worktree 起点失败：${String(e)}` }; }
}

/** Without a saved start (older checkouts), require equality to the current base, never merely ancestry. */
async function expectedStart(git: Git, p: Plan): Promise<{ sha: string } | { reason: string }> {
  const dir = await git(["-C", p.worktree, "rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return { reason: `读不了 worktree 起点：${dir.out}` };
  try {
    const saved = JSON.parse(readFileSync(join(dir.out, START_FILE), "utf8"));
    if (saved.repo !== p.repo || saved.worktree !== p.worktree || saved.branch !== p.branch || saved.base !== p.base
      || typeof saved.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(saved.sha)) return { reason: "保存的 worktree 起点与本卡不符" };
    return { sha: saved.sha };
  } catch (e) {
    // Missing metadata predates this mechanism; corrupt or unreadable metadata cannot authorize a retry.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { reason: `读不了保存的 worktree 起点：${String(e)}` };
  }
  const base = await git(["rev-parse", "--verify", `${p.base}^{commit}`]);
  return base.code === 0 ? { sha: base.out } : { reason: `读不了本卡起点 ${p.base}：${base.out}` };
}

/** Only the exact dependency links checkout creates are exempt, even when Git ignores their paths. */
function dependencyLinks(worktree: string, repo?: string): { allowed: Set<string>; changed: string[] } {
  const allowed = new Set<string>(), changed: string[] = [];
  for (const sub of ["node_modules", "web/node_modules"]) {
    const dest = join(worktree, sub);
    try {
      const stat = lstatSync(dest);
      if (repo && stat.isSymbolicLink() && resolve(dirname(dest), readlinkSync(dest)) === resolve(repo, sub)) allowed.add(sub);
      else changed.push(sub);
    } catch (e) {
      // Absent links are fine; other stat/readlink failures must not be mistaken for a clean checkout.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") changed.push(`${sub}: ${String(e)}`);
    }
  }
  return { allowed, changed };
}

type TreeFile = { mode: string; oid: string };

/**
 * HEAD's object IDs bypass index stat caches, assume-unchanged and skip-worktree without changing their flags.
 * Submodules are `160000 commit` entries (mode "160000"); every other mode or type is still rejected.
 */
function treeFiles(out: string): Map<string, TreeFile> {
  const files = new Map<string, TreeFile>();
  if (out && !out.endsWith("\0")) throw new Error("Git tree 输出不完整");
  for (const record of out.split("\0").filter(Boolean)) {
    const m = /^(?:(100644|100755|120000) blob|(160000) commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(record);
    if (!m || m[4].includes("\ufffd") || m[4].split("/").some((part) => !part || [".", "..", ".git"].includes(part))) {
      throw new Error(`不能完整核对 Git tree 条目：${record.slice(0, 150)}`);
    }
    if (files.has(m[4])) throw new Error(`Git tree 重复路径：${m[4]}`);
    files.set(m[4], { mode: m[1] ?? m[2], oid: m[3] });
  }
  return files;
}

/**
 * A submodule is its own checkout: its HEAD must be the recorded commit and Git's own status of it must be empty.
 * Status trusts the index, so any assume-unchanged / skip-worktree flag (nested submodules too) conservatively counts as
 * changed, and fsmonitor is not consulted. Ignored files stay unchecked: scheduler-local-author links node_modules here.
 * Absent or uninitialized (empty directory) counts as missing, like a deleted file; any Git failure counts as changed.
 */
async function submoduleChanged(git: Git, path: string, oid: string): Promise<boolean> {
  try {
    if (!lstatSync(path).isDirectory() || !readdirSync(path).length) return true;
  } catch (e) {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return true;
    throw e;
  }
  // Without its own .git, `git -C` would silently answer for the enclosing checkout instead: then the prefix is non-empty.
  // Compare no path text: the git helper trims output, which would drop a legal trailing space from a toplevel path.
  const top = await git(["-C", path, "rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  if (top.code !== 0 || top.out !== "true") return true;
  const head = await git(["-C", path, "rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || head.out !== oid) return true;
  // `ls-files -v` tags assume-unchanged entries in lowercase and skip-worktree ones with S: only plain "H" is trusted.
  const flags = await git(["-C", path, "ls-files", "-v", "-z", "--recurse-submodules"]);
  if (flags.code !== 0 || flags.out.split("\0").some((e) => e && !e.startsWith("H "))) return true;
  const st = await git(["-C", path, "-c", "core.fsmonitor=false", "status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  return st.code !== 0 || st.out !== "";
}

/**
 * Compare raw blob bytes: autocrlf/eol, ident and filters may conservatively reject even a Git-clean checkout.
 * Applying clean filters here could erase hidden user edits. Git file modes use only the owner execute bit.
 */
function sameBlob(path: string, file: TreeFile): boolean {
  const stat = lstatSync(path);
  if (file.mode === "120000" ? !stat.isSymbolicLink() : !stat.isFile()) return false;
  if (file.mode !== "120000" && (stat.mode & 0o100 ? "100755" : "100644") !== file.mode) return false;
  const bytes = file.mode === "120000" ? readlinkSync(path, { encoding: "buffer" }) : readFileSync(path);
  const hash = createHash(file.oid.length === 64 ? "sha256" : "sha1");
  return hash.update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === file.oid;
}

/** Walk disk rather than ignored listings: Git can silently omit unreadable ignored directories. Never follow symlinks. */
function diskChanges(worktree: string, files: Map<string, TreeFile>, allowed: Set<string>): string[] {
  const changed: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(join(worktree, dir))) {
      if (!dir && name === ".git") continue; // Only the checkout's own Git metadata is outside its content.
      const sub = dir ? `${dir}/${name}` : name, path = join(worktree, sub), tracked = files.get(sub);
      if (name.includes("\ufffd")) throw new Error(`不能完整解码工作区路径：${sub}`);
      if (tracked) {
        if (!sameBlob(path, tracked)) changed.push(sub);
        files.delete(sub);
      } else if (allowed.has(sub)) {
        // Either an exact scheduler-created link dependencyLinks verified, or a submodule checkout submoduleChanged verified
        // with its own Git; never a whole ignored subtree of this checkout.
        continue;
      } else if (lstatSync(path).isDirectory()) visit(sub);
      else changed.push(sub);
    }
  };
  visit("");
  changed.push(...files.keys()); // A flagged deletion is invisible to status, too.
  return changed;
}

/** Status checks staged edits; the independent disk/object comparison catches ignored and index-hidden edits. */
export async function retryWorktreeDirty(git: Git, worktree: string, repo?: string): Promise<string | null> {
  try {
    const st = await git(["-C", worktree, "status", "--porcelain", "-z", "--untracked-files=all"]);
    if (st.code !== 0) return `worktree ${worktree} 读不了工作区状态：${st.out}`.slice(0, 400);
    const { allowed, changed } = dependencyLinks(worktree, repo);
    changed.push(...st.out.split("\0").filter((l) => l && !(l.startsWith("?? ") && allowed.has(l.slice(3)))));
    const dirty = () => `worktree 有改动（${worktree}），不复用也不删除，保留并等待核对：${changed.slice(0, 5).join("; ")}`.slice(0, 400);
    // A known edit already forbids reuse; do not traverse a potentially huge replacement dependency directory.
    if (changed.length) return dirty();
    const tree = await git(["-C", worktree, "ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
    if (tree.code !== 0) return `worktree ${worktree} 读不了 Git tree：${tree.out}`.slice(0, 400);
    // Generated caches and .review-tmp/.review-env have no content provenance guarantee, even in review worktrees.
    // Their contents deliberately hold retries for inspection; exempt are only the two exact dependency links and each
    // submodule directory, which is not this checkout's blobs and is checked as a whole by its own Git below.
    const files = treeFiles(tree.out), skip = new Set(allowed);
    for (const [path, file] of files) {
      if (file.mode !== "160000") continue;
      files.delete(path); skip.add(path);
      if (await submoduleChanged(git, join(worktree, path), file.oid)) changed.push(path);
    }
    changed.push(...diskChanges(worktree, files, skip));
    return changed.length ? dirty() : null;
  } catch (e) {
    return `worktree ${worktree} 读不了完整工作区，保留并等待核对：${String(e)}`.slice(0, 400);
  }
}

/** Same branch, exact initial SHA, no edits: a clean create failure may retry without deleting its prepared worktree. */
export async function reusableAuthorWorktree(git: Git, p: Plan): Promise<string | null> {
  const at = (args: string[]) => git(["-C", p.worktree, ...args]);
  const kept = `worktree ${p.worktree} 已存在`;
  const branch = await at(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.out !== p.branch) return `${kept}，但不在本卡分支 ${p.branch} 上（${branch.out || "detached"}），保留并等待核对`;
  const start = await expectedStart(git, p);
  if ("reason" in start) return `${kept}，${start.reason}，保留并等待核对`;
  const head = await at(["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || head.out !== start.sha) return `${kept}，HEAD 不在本卡起点 ${start.sha} 上（有自己的提交或起点错误），保留并等待核对`;
  return retryWorktreeDirty(git, p.worktree, p.repo);
}
