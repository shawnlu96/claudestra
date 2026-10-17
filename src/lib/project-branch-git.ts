/**
 * Local Git metadata for a branch context (generality-BRANCH1). Read only: no fetch, no network, no worktree file reads.
 * The declaration's target is read at origin/HEAD and then re-read at that target's own head: both reads must name the same
 * target and remote, so neither commit certifies itself. Remote queries during execution stay in their existing wrappers.
 */
import { createHash } from "node:crypto";
import { parseProjectDeclaration, parseProjectJson, remoteIdentity, type ProjectDeclaration } from "./project-decl-schema.js";
import { FLOKA_REMOTE, LEGACY_TARGET, resolveBranchContext, type BranchContextResult } from "./project-branch.js";

/** Returns trimmed stdout, or null on any failure. Injected in tests; the default never fetches or prompts. */
export type BranchGit = (args: string[]) => Buffer | null;

export function localBranchGit(repoDir: string): BranchGit {
  return (args) => {
    const r = Bun.spawnSync(["git", "--no-replace-objects", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10000,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined } });
    return r.exitCode === 0 ? Buffer.from(r.stdout) : null;
  };
}

const PREFIX = "refs/remotes/origin/";
const text = (git: BranchGit, args: string[]) => git(args)?.toString().trim() || null;
/** Direct tracking ref only; a symbolic alias cannot select a commit. */
function trackingHead(git: BranchGit, branch: string): string | null {
  const ref = `${PREFIX}${branch}`;
  const line = text(git, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype) %(symref)", ref]);
  const [name, sha, type, sym] = (line ?? "").split(" ");
  return name === ref && type === "commit" && !sym ? sha : null;
}
function declarationAt(git: BranchGit, head: string): { declaration: ProjectDeclaration | null; invalid: boolean } {
  if (!text(git, ["ls-tree", head, "--", ".floka/project.json"])) return { declaration: null, invalid: false };
  const blob = git(["cat-file", "blob", `${head}:.floka/project.json`]);
  try {
    const parsed = parseProjectDeclaration(parseProjectJson(blob?.toString() ?? ""));
    return { declaration: parsed.declaration, invalid: !parsed.declaration };
  } catch { return { declaration: null, invalid: true }; /* Malformed declarations block fallback, as in project-decl.ts. */ }
}
const basisStale = (git: BranchGit, head: string, d: ProjectDeclaration) => d.basis.some(({ path, sha256 }) => {
  const blob = git(["cat-file", "blob", `${head}:${path}`]);
  return !blob || createHash("sha256").update(blob).digest("hex") !== sha256;
});

export interface LocalBranchInput { expectedRemote?: string | null; prBase?: string | null; workStartRef?: string | null }

/** Resolve from local metadata. The work start SHA is the start ref's tracking head; a missing start ref is a stop. */
export function readBranchContext(git: BranchGit, input: LocalBranchInput = {}): BranchContextResult {
  const url = text(git, ["remote", "get-url", "origin"]);
  const remote = url ? remoteIdentity(url) : null;
  if (!remote) return resolveBranchContext({ remote, defaultBranch: null });
  const sym = text(git, ["symbolic-ref", "-q", `${PREFIX}HEAD`]);
  const defaultBranch = sym?.startsWith(PREFIX) && sym !== `${PREFIX}HEAD` ? sym.slice(PREFIX.length) : null;
  const defaultHead = defaultBranch ? trackingHead(git, defaultBranch) : null;
  let declaredTarget: string | null = null, declaredRemote: string | null = null, configTarget: string | null = null;
  if (defaultHead) {
    const first = declarationAt(git, defaultHead);
    if (first.invalid) return { ok: false, code: "DECLARATION_INCONSISTENT", reason: "origin/HEAD 上的项目声明不合法，不回落" };
    const d = first.declaration;
    if (d) {
      declaredTarget = d.repository.targetBranch; declaredRemote = remoteIdentity(d.repository.remote);
      if (d.repository.defaultBranch !== defaultBranch) return { ok: false, code: "DECLARATION_INCONSISTENT", reason: "声明的默认分支与 origin/HEAD 不符" };
    } else if (remote === FLOKA_REMOTE) configTarget = LEGACY_TARGET;
  }
  const result = resolveBranchContext({ remote, expectedRemote: input.expectedRemote, defaultBranch, declaredTarget, declaredRemote,
    configTarget, prBase: input.prBase, workStartRef: input.workStartRef });
  if (!result.ok) return result;
  const c = result.context, targetHead = trackingHead(git, c.targetBranch);
  if (!targetHead) return { ok: false, code: "REMOTE_HEAD_MISSING", reason: `本地没有 origin/${c.targetBranch} 的跟踪 head` };
  if (declaredTarget) {
    // The second read: the target's own head must declare the same target and remote, and its basis must still hold.
    const again = declarationAt(git, targetHead).declaration;
    if (!again || again.repository.targetBranch !== declaredTarget || remoteIdentity(again.repository.remote) !== declaredRemote) {
      return { ok: false, code: "DECLARATION_INCONSISTENT", reason: `origin/${declaredTarget} 上的声明与 origin/HEAD 的声明不一致` };
    }
    if (basisStale(git, targetHead, again)) return { ok: false, code: "BASIS_STALE", reason: "目标 head 上的声明依据已变，需重新核实" };
  }
  const startSha = trackingHead(git, c.workStartRef);
  if (!startSha) return { ok: false, code: "REMOTE_HEAD_MISSING", reason: `本地没有起点 origin/${c.workStartRef} 的跟踪 head` };
  return { ok: true, context: { ...c, targetHead, workStartSha: startSha } };
}
