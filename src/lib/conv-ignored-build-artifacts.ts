/** Only the owning repository's explicit generated outputs can pass a convergence reuse preflight. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openAttachment } from "./attachment-lookup.js";
import { stripComments } from "./skip-effects-auto-scope-scan.js";
import { unquoteGitPath } from "./ci-impact-select.js";
import { REPO_ROOT } from "./repo-root.js";
import type { ObservedAction, RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import type { Git } from "./scheduler-review-worktree.js";

export const CONV_BUILD_PATHS = [
  { path: "web/out", directory: true }, { path: "web/.next", directory: true },
  { path: "web/lib/build-info.ts", directory: false }, { path: "web/public/build-info.json", directory: false },
  { path: "web/next-env.d.ts", directory: false }, { path: "web/tsconfig.tsbuildinfo", directory: false },
] as const;
export interface ConvArtifactContext {
  project: string; taskId: string; intentId: string;
  policy?: RecoveryPolicyPort;
  observe(action: ObservedAction): void;
  /** Synchronous effect permission, including the scheduler lease and the old author's stopped state. */
  gate(): string | null;
  repository?: string;
  quarantineRoot?: string;
  expected?: { branch: string | null; head: string | null };
}
export interface BuildArtifact { path: string; fingerprint: string; digest: string; members: string[] }
type Result = { code: number; out: string };
type Check<T> = Generator<string[], T, Result>;
export type ArtifactProof = { candidates: BuildArtifact[]; mode: RecoveryMode; reason: string | null };
export const coversBuildPath = (paths: readonly string[], path: string): boolean => paths.some((p) => path === p || path.startsWith(`${p}/`));

/** Check every ancestor with lstat: a safe leaf under a linked parent is still an external write. */
export function noLinkedAncestors(path: string, allowMissing = false): void {
  const chain = [resolve(path)];
  for (let at = chain[0]; dirname(at) !== at;) { at = dirname(at); chain.push(at); }
  for (const at of chain.reverse()) {
    let stat;
    try { stat = lstatSync(at); }
    catch (e) { if (allowMissing && (e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (stat.isSymbolicLink()) throw new Error(`软链路径不隔离：${at}`);
  }
}

/** Disk fingerprints freeze identity and bytes; a move must re-read them immediately before its rename. */
export function readBuildArtifact(worktree: string, path: string, directory: boolean): BuildArtifact | null {
  const full = join(worktree, path);
  noLinkedAncestors(dirname(full), true);
  let s;
  try { s = lstatSync(full); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  noLinkedAncestors(full);
  if (directory ? !s.isDirectory() : !s.isFile()) throw new Error(`构建产物类型不符：${path}`);
  const digest = createHash("sha256"), identity = createHash("sha256"), members: string[] = [];
  const visit = (sub: string) => {
    const p = join(worktree, sub), stat = lstatSync(p);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`构建产物含非普通文件：${sub}`);
    members.push(sub);
    const record = JSON.stringify([sub.slice(path.length), stat.isDirectory() ? "directory" : "file", stat.mode, stat.isFile() ? stat.size : 0]);
    digest.update(record); identity.update(JSON.stringify([record, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isDirectory()) for (const name of readdirSync(p).sort()) {
      if (name.includes("\ufffd")) throw new Error(`不能完整解码构建产物：${sub}`);
      visit(`${sub}/${name}`);
    } else {
      const file = openAttachment(p, { uploadDir: worktree, inboxDirs: [] });
      if (!file) throw new Error(`构建产物不是安全普通文件：${sub}`);
      try {
        const fdStat = fstatSync(file.fd);
        noLinkedAncestors(p);
        if (fdStat.ino !== stat.ino || fdStat.dev !== stat.dev) throw new Error(`构建产物读取中已被替换：${sub}`);
        const bytes = readFileSync(file.fd); digest.update(bytes); identity.update(bytes);
      } finally { closeSync(file.fd); }
    }
  };
  visit(path);
  return { path, fingerprint: identity.digest("hex"), digest: digest.digest("hex"), members };
}

/** Build provenance is read from Git objects, never by executing or trusting modified checkout scripts. */
function* repositoryEvidence(worktree: string, repository: string): Check<void> {
  const own = yield ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"];
  const trusted = yield ["-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"];
  const [dir, common] = own.out.split("\n");
  if (own.code !== 0 || trusted.code !== 0 || !common || realpathSync(common) !== realpathSync(trusted.out)
    || realpathSync(dir) === realpathSync(common)) throw new Error("构建清单仅用于本仓库的 linked worktree");
  const read = function* (path: string): Check<string> {
    const value = yield ["-C", worktree, "show", `HEAD:${path}`];
    if (value.code !== 0) throw new Error(`构建清单依据不可读：${path}`);
    return value.out;
  };
  const pkg = JSON.parse(yield* read("package.json")), web = JSON.parse(yield* read("web/package.json"));
  const next = stripComments(yield* read("web/next.config.ts")), ts = JSON.parse(yield* read("web/tsconfig.json"));
  const gen = stripComments(yield* read("web/scripts/gen-build-info.mjs"));
  if (pkg.name !== "claudestra" || web.name !== "claudestra-web" || web.scripts?.build !== "next build"
    || web.scripts?.prebuild !== "node scripts/gen-build-info.mjs" || !/output:\s*["']export["']/.test(next)
    || ts.compilerOptions?.incremental !== true || !ts.include?.includes("next-env.d.ts")
    || !/writeFileSync\s*\(\s*join\s*\(\s*webDir,\s*"lib",\s*"build-info\.ts"\s*\)/.test(gen)
    || !/writeFileSync\s*\(\s*join\s*\(\s*webDir,\s*"public",\s*"build-info\.json"\s*\)/.test(gen)) throw new Error("构建清单依据不足，不隔离");
}

function* candidatesCheck(worktree: string, context: ConvArtifactContext): Check<BuildArtifact[]> {
  // A tracked web submodule is checked by its own Git; its ignored contents never become primary-checkout candidates.
  const web = yield ["-C", worktree, "ls-tree", "-z", "HEAD", "--", "web"];
  if (web.code === 0 && /^160000 commit [0-9a-f]{40,64}\tweb\0$/.test(web.out)) return [];
  const candidates: BuildArtifact[] = [];
  for (const item of CONV_BUILD_PATHS) {
    try { const candidate = readBuildArtifact(worktree, item.path, item.directory); if (candidate) candidates.push(candidate); }
    catch (e) {
      // A missing intermediate directory has no candidate; the canonical disk proof still checks every existing ancestor.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (!candidates.length) return [];
  yield* repositoryEvidence(worktree, context.repository ?? REPO_ROOT);
  if (context.expected) {
    const branch = yield ["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"];
    const head = yield ["-C", worktree, "rev-parse", "--verify", "HEAD"];
    if (branch.code || head.code || branch.out !== context.expected.branch || head.out !== context.expected.head) throw new Error("候选工作树分支 / HEAD 不符");
  }
  const index = yield ["-C", worktree, "ls-files", "-z"];
  const head = yield ["-C", worktree, "ls-tree", "-r", "-z", "--name-only", "HEAD"];
  if (index.code !== 0 || head.code !== 0 || [index.out, head.out].some((s) => s && !s.endsWith("\0"))) throw new Error("读不了完整 HEAD/index 路径");
  const tracked = [...index.out.split("\0"), ...head.out.split("\0")].filter(Boolean);
  for (const artifact of candidates) {
    const item = { path: artifact.path };
    if (tracked.some((p) => coversBuildPath([item.path], p) || coversBuildPath([p], item.path))) throw new Error(`清单产物已被 HEAD/index 跟踪：${item.path}`);
    for (let offset = 0; offset < artifact.members.length; offset += 100) {
      const batch = artifact.members.slice(offset, offset + 100);
      const ignored = yield ["-C", worktree, "-c", "core.quotePath=true", "check-ignore", "--no-index", "--", ...batch, artifact.path];
      const paths = new Set(ignored.out.split("\n").filter(Boolean).map(unquoteGitPath));
      if (ignored.code !== 0 || batch.some((p) => !paths.has(p))) throw new Error(`清单产物并非完整 ignored：${item.path}`);
    }
  }
  return candidates;
}

export const convBuildCandidates = (git: Git, worktree: string, context: ConvArtifactContext): Promise<BuildArtifact[]> =>
  drive(candidatesCheck(worktree, context), git);
export const convBuildCandidatesSync = (git: (args: string[]) => Result, worktree: string, context: ConvArtifactContext): BuildArtifact[] =>
  driveSync(candidatesCheck(worktree, context), git);

async function drive<T>(check: Check<T>, git: Git): Promise<T> {
  let step = check.next();
  while (!step.done) step = check.next(await git(step.value));
  return step.value;
}
function driveSync<T>(check: Check<T>, git: (args: string[]) => Result): T {
  let step = check.next();
  while (!step.done) step = check.next(git(step.value));
  return step.value;
}
/** Resolve the same dependency-link spelling used by the checkout creator while retaining the main worktree's identity. */
export function buildArtifactOwner(dir: string, list: Result): string | undefined {
  const first = list.code === 0 ? list.out.trim().split("\n\n")[0].split("\n") : [];
  const main = first[0]?.startsWith("worktree ") && !first.includes("bare") ? first[0].slice(9) : undefined;
  if (!main) return undefined;
  for (const sub of ["node_modules", "web/node_modules"]) {
    const dest = join(dir, sub);
    try {
      const to = resolve(dirname(dest), readlinkSync(dest)), repo = resolve(to, sub === "node_modules" ? ".." : "../..");
      if (resolve(repo, sub) === to && realpathSync(repo) === realpathSync(main)) return repo;
    } catch { /* A missing or bad dependency link cannot supply a spelling; the canonical dirty proof still refuses bad links. */ }
  }
  return main;
}
