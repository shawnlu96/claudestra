/** All repository content comes from immutable Git objects; caller paths only establish repository identity. */
import { realpathSync } from "node:fs";
import type { ProjectDef } from "./projects.js";
import { declPath, remoteIdentity } from "./project-decl-schema.js";

export class DeclReadError extends Error {
  constructor(readonly reasonCode: string, readonly field: string) { super(reasonCode); }
}
function gitDecl(repo: string, args: string[]): Buffer {
  const result = Bun.spawnSync(["git", "--no-replace-objects", "-C", repo, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined,
      GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined }, timeout: 10000,
  });
  if (result.exitCode !== 0) throw new DeclReadError("GIT_READ_FAILED", "repository");
  return Buffer.from(result.stdout);
}
const gitText = (repo: string, args: string[]) => gitDecl(repo, args).toString().trim();
const commonDir = (dir: string) => realpathSync(gitText(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
export interface DeclRepository { root: string; remote: string; targetBranch: string; targetHead: string; tree: Map<string, string> }
export function resolveDeclRepository(project: ProjectDef, repoDir: string, targetBranch?: string): DeclRepository {
  const root = realpathSync(gitText(repoDir, ["rev-parse", "--show-toplevel"]));
  if (root !== realpathSync(repoDir)) throw new DeclReadError("REPOSITORY_ROOT_REQUIRED", "repoDir");
  const common = commonDir(root);
  if (!project.dirs.some((d) => {
    try { return commonDir(d) === common; }
    catch { return false; /* An unavailable registered directory cannot establish identity. */ }
  })) throw new DeclReadError("PROJECT_REPOSITORY_MISMATCH", "project.dirs");
  const remote = remoteIdentity(gitText(root, ["remote", "get-url", "origin"]));
  if (!remote) throw new DeclReadError("UNTRUSTED_REMOTE", "repository.remote");
  const trustedRef = targetBranch ? `refs/heads/${targetBranch}` : gitText(root, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (!trustedRef.startsWith("refs/heads/") && !trustedRef.startsWith("refs/remotes/origin/")) {
    throw new DeclReadError("TARGET_HEAD_UNAVAILABLE", "repository.targetBranch");
  }
  gitDecl(root, ["check-ref-format", trustedRef]);
  const head = gitText(root, ["rev-parse", "--verify", `${trustedRef}^{commit}`]);
  if (!new RegExp("^[a-f0-9]{40}$").test(head)) throw new DeclReadError("TARGET_HEAD_UNAVAILABLE", "repository.targetBranch");
  const prefix = trustedRef.startsWith("refs/heads/") ? "refs/heads/" : "refs/remotes/origin/";
  return { root, remote, targetBranch: trustedRef.slice(prefix.length), targetHead: head, tree: readDeclTree(root, head) };
}
export function readDeclTree(repo: string, head: string): Map<string, string> {
  const entries = gitDecl(repo, ["ls-tree", "-r", "-t", "-z", "--full-tree", head]).toString().split("\0").filter(Boolean);
  return new Map(entries.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)]));
}
export function objectMode(repo: string, head: string, path: string, tree?: Map<string, string>): string | null {
  if (tree) return tree.get(path) ?? null;
  const entry = gitDecl(repo, ["ls-tree", "-z", head, "--", `:(literal)${path}`]).toString();
  if (!entry) return null;
  if (entry.split("\0").filter(Boolean).length !== 1) throw new DeclReadError("AMBIGUOUS_PATH", path);
  return entry.slice(0, 6);
}
/** Reject even in-repository symlinks: their interpretation must never depend on a mutable working tree. */
export function assertObjectPath(repo: string, head: string, path: string, glob = false, tree?: Map<string, string>): void {
  if (!declPath.safeParse(path).success) throw new DeclReadError("UNSAFE_PATH", path);
  if (path === ".") return;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    if (glob && parts[i - 1].includes("*")) break;
    const mode = objectMode(repo, head, parts.slice(0, i).join("/"), tree);
    if (mode === "120000" || mode === "160000") throw new DeclReadError("PATH_ESCAPE", path);
    if (!mode) throw new DeclReadError("PATH_MISSING", path);
  }
}
export function readDeclBlob(repo: string, head: string, path: string, tree?: Map<string, string>): Buffer {
  assertObjectPath(repo, head, path, false, tree);
  if (!["100644", "100755"].includes(objectMode(repo, head, path, tree) ?? "")) throw new DeclReadError("REGULAR_FILE_REQUIRED", path);
  return gitDecl(repo, ["cat-file", "blob", `${head}:${path}`]);
}
export function isDeclAncestor(repo: string, ancestor: string, head: string): boolean {
  try { gitDecl(repo, ["merge-base", "--is-ancestor", ancestor, head]); return true; }
  catch { return false; /* Unavailable or unrelated verification commits are untrusted. */ }
}
