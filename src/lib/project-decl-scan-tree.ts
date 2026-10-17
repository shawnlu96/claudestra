/**
 * generality-PROJSCAN1 · materializes the fixed target head from Git objects without any checkout machinery. `git worktree add`
 * runs smudge / process filters configured for the repository outside every execution boundary, so it is never used: blobs are
 * read with `cat-file --batch` (no filters) under a minimal environment and written by this process as plain files. Symlinks and
 * submodules are not materialized at all, so nothing in the tree can point out of it. Control files go through writeExclusive.
 */
import { closeSync, constants, cpSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const GIT_MS = 60_000;
export interface TreeEntry { path: string; mode: string; oid: string }
class TreeError extends Error {}

/** Local object reads only: no inherited secrets, no system or global config (filters, fsmonitor), no lazy fetch, no prompts. */
function scanLocalGitEnv(path = process.env.PATH ?? "/usr/bin:/bin"): Record<string, string> {
  return { PATH: path, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}
function gitObjects(repo: string, args: string[], stdin?: Buffer): Buffer {
  const r = Bun.spawnSync(["git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", repo, ...args],
    { stdin: stdin ?? "ignore", stdout: "pipe", stderr: "ignore", env: scanLocalGitEnv(), timeout: GIT_MS });
  if (r.exitCode !== 0) throw new TreeError("TREE_READ_FAILED");
  return Buffer.from(r.stdout);
}

/** A tree path is materialized only when every part is a plain name: no empty, dot, dot-dot or Git directory component. */
const safePath = (path: string) => path.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git");

/** Regular files of the head with their blob ids; links (120000) and submodules (160000) are counted and left out. */
export function listTree(repo: string, head: string): { files: TreeEntry[]; skipped: number } {
  const files: TreeEntry[] = [];
  let skipped = 0;
  for (const line of gitObjects(repo, ["ls-tree", "-r", "-z", "--full-tree", head]).toString().split("\0").filter(Boolean)) {
    const [meta, path] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
    const [mode, type, oid] = meta.split(" ");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) { skipped++; continue; }
    if (!safePath(path)) throw new TreeError("TREE_PATH_UNSAFE");
    files.push({ path, mode, oid });
  }
  if (files.length > MAX_FILES) throw new TreeError("TREE_TOO_LARGE");
  return { files, skipped };
}

/** Creates a new file that must not exist yet; an existing name or a planted link fails instead of being followed or replaced. */
export function writeExclusive(file: string, data: string | Uint8Array, mode = 0o600): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
  } finally { closeSync(fd); }
}
/** A directory this process owns: it must be a real directory reached without any link. */
export function assertPlainDir(dir: string): void {
  if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw new TreeError("ISOLATION_LINK_REJECTED");
}

/** Writes every regular file of the head under `dest` (which must not exist); directories are created by this process only. */
export function materializeTree(repo: string, files: TreeEntry[], dest: string): void {
  mkdirSync(dest, { mode: 0o700 });
  const batch = gitObjects(repo, ["cat-file", "--batch"], Buffer.from(files.map((f) => `${f.oid}\n`).join("")));
  let off = 0, total = 0;
  for (const f of files) {
    const nl = batch.indexOf(10, off);
    const [oid, type, size] = batch.subarray(off, nl).toString().split(" ");
    const len = Number(size);
    if (oid !== f.oid || type !== "blob" || !Number.isSafeInteger(len)) throw new TreeError("TREE_READ_FAILED");
    total += len;
    if (total > MAX_TOTAL_BYTES) throw new TreeError("TREE_TOO_LARGE");
    const parts = f.path.split("/");
    if (parts.length > 1) mkdirSync(join(dest, ...parts.slice(0, -1)), { recursive: true, mode: 0o755 });
    writeExclusive(join(dest, f.path), batch.subarray(nl + 1, nl + 1 + len), f.mode === "100755" ? 0o755 : 0o644);
    off = nl + 1 + len + 1;
  }
}

/** A fresh copy of the pristine tree for one candidate; the pristine copy itself is outside every command's writable area. */
export function copyPristine(pristine: string, dest: string): void {
  cpSync(pristine, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}
