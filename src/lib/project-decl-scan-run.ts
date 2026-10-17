/**
 * generality-PROJSCAN1 · runs each discovered candidate once inside the target repository's own isolation area
 * (`<git common dir>/floka-scan/<run>`). The head is materialized from Git objects (project-decl-scan-tree.ts, no checkout and
 * no filters); every candidate gets its own fresh copy, home, temp and caches, so no earlier command can change what a later one
 * verifies. Commands get a minimal environment without inherited secrets, a timeout with process-group kill (run-bounded.ts),
 * and an execution boundary that confines reads to their own directory plus a read-only toolchain whitelist, writes to their own
 * directory, and denies network. Control files live in a sibling directory no command can read or write. Without such a
 * boundary nothing is materialized or run and every item stays inferred; a run never decides deploy capability.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import type { BoundedResult, runBounded } from "./run-bounded.js";
import type { DeclCandidate } from "./project-decl-discovery.js";
import { classifyDeclFailure, type DeclFailureClass } from "./project-decl-scan-classify.js";
import { assertPlainDir, copyPristine, listTree, materializeTree, type TreeEntry } from "./project-decl-scan-tree.js";

export type ScanRunner = typeof runBounded;
export interface ExecBoundary {
  available: boolean; reason: string;
  /** Read-only toolchain roots; when set, PATH is narrowed to them and a tool found only elsewhere is not run. */
  readRoots?: string[];
  wrap(argv: string[], dir: string): string[];
}
/** `control` holds the draft, PR body, commit message and private index; it is never inside any command's boundary. */
export interface IsolationArea { root: string; control: string; repoRoot: string; head: string }
type RunReason = DeclFailureClass | "VERIFIED" | "OUTBOUND_SUSPECT" | "EXEC_BOUNDARY_UNAVAILABLE" | "CWD_ESCAPE" | "ISOLATION_UNAVAILABLE"
  | "TOOLCHAIN_OUTSIDE_BOUNDARY";
export interface CandidateRun {
  id: string; status: "verified" | "inferred"; reason: RunReason; exitCode: number | null; timedOut: boolean; durationMs: number;
  /** True when the failure carries explicit missing-command evidence (classification interface, not acted on here). */
  rescan: boolean;
}

const GIT_MS = 60_000;
const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
};
/** Git environment for operations that need the operator's identity (commit author, push, gh): no redirected repository. */
export function scanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_DIR: undefined,
    GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined };
}
/** Hooks and fsmonitor are configured programs; the scanner's own Git calls never start them. */
export async function scanGit(run: ScanRunner, repo: string, args: string[], extraEnv: Record<string, string> = {}): Promise<BoundedResult> {
  return run(["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo, ...args],
    { cwd: repo, env: { ...scanGitEnv(), ...extraEnv }, timeoutMs: GIT_MS });
}

/** System toolchains only; home directories, user temp and mounted volumes are outside the whitelist. */
const DARWIN_READ_ROOTS = ["/usr", "/bin", "/sbin", "/System", "/Library/Developer", "/Library/Frameworks", "/Library/Apple",
  "/private/etc", "/private/var/select", "/private/var/db/timezone", "/opt/homebrew", "/dev"];
const DARWIN_READ_LITERALS = ["/", "/private/var/db/xcode_select_link"];
const quoted = (p: string) => {
  if (["\"", "\\", "\n", "(", ")"].some((c) => p.includes(c))) throw new Error("UNSAFE_AREA_PATH");
  return `"${p}"`;
};
/** macOS sandbox-exec, deny by default: reads only in `dir` and the toolchain whitelist, writes only in `dir`, no network. */
export function darwinBoundary(platform = process.platform, exists: (p: string) => boolean = existsSync,
  readRoots = DARWIN_READ_ROOTS): ExecBoundary {
  const bin = "/usr/bin/sandbox-exec";
  if (platform !== "darwin" || !exists(bin)) {
    return { available: false, reason: "EXEC_BOUNDARY_UNAVAILABLE", wrap: () => { throw new Error("EXEC_BOUNDARY_UNAVAILABLE"); } };
  }
  return {
    available: true, reason: "darwin-sandbox-exec", readRoots,
    wrap(argv, dir) {
      const reads = [...readRoots.map((r) => `(subpath ${quoted(r)})`), ...DARWIN_READ_LITERALS.map((l) => `(literal ${quoted(l)})`)];
      const profile = ["(version 1)", "(deny default)", "(allow process*)", "(allow signal (target same-sandbox))", "(allow sysctl-read)",
        "(allow mach-lookup)", "(allow ipc-posix*)", "(allow iokit-open)", "(allow file-read-metadata)", "(allow file-ioctl)",
        "(allow pseudo-tty)", "(deny network*)", `(allow file-read* ${reads.join(" ")} (subpath ${quoted(dir)}))`,
        `(allow file-write* (subpath ${quoted(dir)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`].join("");
      return [bin, "-p", profile, ...argv];
    },
  };
}

/** Minimal environment: PATH to find toolchains, every home and cache redirected into the run directory, nothing else inherited. */
export function scanCommandEnv(area: string, path = process.env.PATH ?? "/usr/bin:/bin"): Record<string, string> {
  const home = join(area, "home"), tmp = join(area, "tmp"), cache = join(area, "cache");
  return { PATH: path, HOME: home, TMPDIR: tmp, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(home, ".config"), LANG: "C", LC_ALL: "C",
    CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GOCACHE: join(cache, "go-build"), GOPATH: join(area, "gopath"),
    GOMODCACHE: join(area, "gopath", "mod"), GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod", npm_config_cache: join(cache, "npm"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"), PIP_CACHE_DIR: join(cache, "pip"), PYTHONDONTWRITEBYTECODE: "1",
    CARGO_TARGET_DIR: join(area, "cargo-target") };
}

const real = (p: string) => { try { return realpathSync(p); } catch { return null; /* absent PATH entry: dropped */ } };
const withinRoots = (p: string | null, roots: string[]) => !!p && roots.some((r) => inside(r, p));
/** PATH entries that resolve inside the read whitelist; others would only produce reads the boundary denies. */
export function confinedPath(hostPath: string, roots: string[]): string {
  return hostPath.split(delimiter).filter((d) => isAbsolute(d) && withinRoots(real(d), roots)).join(delimiter);
}
/** A bare command that exists for the operator but not inside the whitelist is a boundary limit, never "command missing". */
function outsideBoundary(cmd: string, hostPath: string, path: string, roots: string[]): boolean {
  if (cmd.includes("/")) return false;
  const confined = Bun.which(cmd, { PATH: path });
  if (confined && withinRoots(real(confined), roots)) return false;
  return !!Bun.which(cmd, { PATH: hostPath });
}

/** Creates `<common dir>/floka-scan/<runId>` with no link on the way, plus its control directory. Nothing is checked out here. */
export async function createIsolationArea(run: ScanRunner, repoRoot: string, head: string, runId: string): Promise<IsolationArea> {
  const common = await scanGit(run, repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) throw new Error("ISOLATION_UNAVAILABLE");
  const commonDir = realpathSync(common.stdout.trim());
  if (!new RegExp("^[A-Za-z0-9-]{1,80}$").test(runId)) throw new Error("ISOLATION_UNAVAILABLE");
  const base = join(commonDir, "floka-scan");
  mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink() || realpathSync(base) !== base) throw new Error("ISOLATION_LINK_REJECTED");
  const root = join(base, runId);
  mkdirSync(root, { mode: 0o700 });
  const area = { root, control: join(root, "control"), repoRoot, head };
  try { for (const d of [area.control, join(root, "runs")]) mkdirSync(d, { mode: 0o700 }); }
  catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  return area;
}

/** Removes only the area this run created (links inside are unlinked, not followed) and any stale worktree registration. */
export async function removeIsolationArea(run: ScanRunner, repoRoot: string, area: IsolationArea): Promise<void> {
  if (area.root.split(sep).includes("floka-scan")) rmSync(area.root, { recursive: true, force: true });
  await scanGit(run, repoRoot, ["worktree", "prune"]);
}

function inferred(id: string, reason: RunReason, extra: Partial<CandidateRun> = {}): CandidateRun {
  return { id, status: "inferred", reason, exitCode: null, timedOut: false, durationMs: 0, rescan: false, ...extra };
}
/** The command's cwd must resolve inside its tree; the tree holds no links, so a missing cwd is refused, never created. */
function commandCwd(worktree: string, cwd: string): string | null {
  const dir = cwd === "." ? worktree : join(worktree, cwd);
  try { return inside(worktree, realpathSync(dir)) ? dir : null; }
  catch { return null; /* A cwd missing from the materialized head is an escape-class refusal, the item stays inferred. */ }
}

/** Lazily materializes the pristine head once, then gives run `index` its own copy and home / temp / cache directories. */
class RunDirs {
  private files: TreeEntry[] | null = null;
  constructor(private area: IsolationArea) {}
  prepare(index: number): { dir: string; worktree: string } {
    const pristine = join(this.area.root, "pristine");
    if (!this.files) {
      assertPlainDir(this.area.root);
      this.files = listTree(this.area.repoRoot, this.area.head).files;
      materializeTree(this.area.repoRoot, this.files, pristine);
    }
    const dir = join(this.area.root, "runs", String(index));
    mkdirSync(dir, { mode: 0o700 });
    for (const d of ["home", "tmp", "cache"]) mkdirSync(join(dir, d));
    const worktree = join(dir, "wt");
    copyPristine(pristine, worktree);
    return { dir, worktree };
  }
}

export interface VerifyPorts { run: ScanRunner; boundary: ExecBoundary; clock?: () => number; hostPath?: string }
/** One run per candidate, sequential, each on a fresh copy of the head; stderr is classified in memory and dropped, never kept. */
export async function verifyCandidates(candidates: DeclCandidate[], area: IsolationArea, ports: VerifyPorts): Promise<CandidateRun[]> {
  const clock = ports.clock ?? Date.now;
  const hostPath = ports.hostPath ?? process.env.PATH ?? "/usr/bin:/bin";
  const roots = ports.boundary.readRoots;
  const path = roots ? confinedPath(hostPath, roots) : hostPath;
  const dirs = new RunDirs(area);
  const runs: CandidateRun[] = [];
  for (const [index, c] of candidates.entries()) {
    if (c.blocked) { runs.push(inferred(c.id, c.blocked)); continue; }
    if (!ports.boundary.available) { runs.push(inferred(c.id, "EXEC_BOUNDARY_UNAVAILABLE")); continue; }
    if (roots && outsideBoundary(c.argv[0], hostPath, path, roots)) { runs.push(inferred(c.id, "TOOLCHAIN_OUTSIDE_BOUNDARY")); continue; }
    let box: { dir: string; worktree: string };
    try { box = dirs.prepare(index); }
    catch { runs.push(inferred(c.id, "ISOLATION_UNAVAILABLE")); continue; /* no fresh tree, no run */ }
    const cwd = commandCwd(box.worktree, c.cwd);
    if (!cwd) { runs.push(inferred(c.id, "CWD_ESCAPE")); continue; }
    const started = clock();
    const r = await ports.run(ports.boundary.wrap(c.argv, box.dir), { cwd, env: scanCommandEnv(box.dir, path), timeoutMs: c.timeoutSec * 1000,
      maxBytes: 256 * 1024 });
    const verdict = classifyDeclFailure({ exitCode: r.code, timedOut: r.timedOut, stderr: r.stderr });
    const base = { exitCode: r.code, timedOut: r.timedOut, durationMs: Math.max(0, clock() - started), rescan: verdict.rescan };
    runs.push(verdict.failureClass === "PASSED" ? { id: c.id, status: "verified", reason: "VERIFIED", ...base } : inferred(c.id, verdict.failureClass, base));
  }
  return runs;
}
