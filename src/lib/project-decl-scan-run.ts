/**
 * generality-PROJSCAN1 · runs each discovered candidate once inside the target repository's own isolation area
 * (`<git common dir>/floka-scan/<run>`): a detached worktree of the fixed target head, a minimal environment without inherited
 * secrets, a timeout with process-group kill (run-bounded.ts), and an execution boundary that confines writes to the area and
 * denies network. Without such a boundary nothing runs and every item stays inferred; a run never decides deploy capability.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { BoundedResult, runBounded } from "./run-bounded.js";
import type { DeclCandidate } from "./project-decl-discovery.js";
import { classifyDeclFailure, type DeclFailureClass } from "./project-decl-scan-classify.js";

export type ScanRunner = typeof runBounded;
export interface ExecBoundary { available: boolean; reason: string; wrap(argv: string[], area: string): string[] }
export interface IsolationArea { root: string; worktree: string }
type RunReason = DeclFailureClass | "VERIFIED" | "OUTBOUND_SUSPECT" | "EXEC_BOUNDARY_UNAVAILABLE" | "CWD_ESCAPE";
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
/** Git environment for the scanner's own repository operations: no redirected repository, no prompts, no lazy fetch. */
export function scanGitEnv(): Record<string, string | undefined> {
  return { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_DIR: undefined,
    GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_COMMON_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined };
}
export async function scanGit(run: ScanRunner, repo: string, args: string[], extraEnv: Record<string, string> = {}): Promise<BoundedResult> {
  return run(["git", "--no-replace-objects", "-C", repo, ...args], { cwd: repo, env: { ...scanGitEnv(), ...extraEnv }, timeoutMs: GIT_MS });
}

/** macOS sandbox-exec: reads stay possible for toolchains, writes only inside the area, no network at all. */
export function darwinBoundary(platform = process.platform, exists: (p: string) => boolean = existsSync): ExecBoundary {
  const bin = "/usr/bin/sandbox-exec";
  if (platform !== "darwin" || !exists(bin)) {
    return { available: false, reason: "EXEC_BOUNDARY_UNAVAILABLE", wrap: () => { throw new Error("EXEC_BOUNDARY_UNAVAILABLE"); } };
  }
  return {
    available: true, reason: "darwin-sandbox-exec",
    wrap(argv, area) {
      if (["\"", "\\", "\n", "("].some((c) => area.includes(c))) throw new Error("UNSAFE_AREA_PATH");
      const profile = ["(version 1)", "(allow default)", "(deny network*)", "(deny file-write*)",
        `(allow file-write* (subpath "${area}") (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`].join("");
      return [bin, "-p", profile, ...argv];
    },
  };
}

/** Minimal environment: PATH to find toolchains, every home and cache redirected into the area, nothing else inherited. */
export function scanCommandEnv(area: string, path = process.env.PATH ?? "/usr/bin:/bin"): Record<string, string> {
  const home = join(area, "home"), tmp = join(area, "tmp"), cache = join(area, "cache");
  return { PATH: path, HOME: home, TMPDIR: tmp, XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: join(home, ".config"), LANG: "C", LC_ALL: "C",
    CI: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GOCACHE: join(cache, "go-build"), GOPATH: join(area, "gopath"),
    GOMODCACHE: join(area, "gopath", "mod"), GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod", npm_config_cache: join(cache, "npm"),
    BUN_INSTALL_CACHE_DIR: join(cache, "bun"), PIP_CACHE_DIR: join(cache, "pip"), PYTHONDONTWRITEBYTECODE: "1",
    CARGO_TARGET_DIR: join(area, "cargo-target") };
}

/** Creates `<common dir>/floka-scan/<runId>` with no link on the way, then a detached worktree of the fixed target head. */
export async function createIsolationArea(run: ScanRunner, repoRoot: string, head: string, runId: string): Promise<IsolationArea> {
  const common = await scanGit(run, repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) throw new Error("ISOLATION_UNAVAILABLE");
  const commonDir = realpathSync(common.stdout.trim());
  if (!new RegExp("^[A-Za-z0-9-]{1,80}$").test(runId)) throw new Error("ISOLATION_UNAVAILABLE");
  const base = join(commonDir, "floka-scan");
  mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink() || realpathSync(base) !== base) throw new Error("ISOLATION_LINK_REJECTED");
  const root = join(base, runId);
  mkdirSync(root);
  for (const d of ["home", "tmp", "cache"]) mkdirSync(join(root, d));
  const worktree = join(root, "wt");
  const add = await scanGit(run, repoRoot, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--", worktree, head]);
  if (add.code !== 0 || !existsSync(worktree) || realpathSync(worktree) !== worktree) {
    await removeIsolationArea(run, repoRoot, { root, worktree });
    throw new Error("ISOLATION_UNAVAILABLE");
  }
  return { root, worktree };
}

/** Removes only the area this run created: the worktree registration first, then the run directory (links are unlinked, not followed). */
export async function removeIsolationArea(run: ScanRunner, repoRoot: string, area: IsolationArea): Promise<void> {
  await scanGit(run, repoRoot, ["worktree", "remove", "--force", "--", area.worktree]);
  if (area.root.split(sep).includes("floka-scan")) rmSync(area.root, { recursive: true, force: true });
  await scanGit(run, repoRoot, ["worktree", "prune"]);
}

function inferred(id: string, reason: RunReason, extra: Partial<CandidateRun> = {}): CandidateRun {
  return { id, status: "inferred", reason, exitCode: null, timedOut: false, durationMs: 0, rescan: false, ...extra };
}
/** The command's cwd must resolve inside the worktree after links are resolved; a link out of it is refused, never followed. */
function commandCwd(area: IsolationArea, cwd: string): string | null {
  const dir = cwd === "." ? area.worktree : join(area.worktree, cwd);
  try { return inside(area.worktree, realpathSync(dir)) ? dir : null; }
  catch { return null; /* A cwd missing from the checkout is an escape-class refusal, the item stays inferred. */ }
}

export interface VerifyPorts { run: ScanRunner; boundary: ExecBoundary; clock?: () => number }
/** One run per candidate, sequential; stderr is classified in memory and dropped, nothing of the output is kept or logged. */
export async function verifyCandidates(candidates: DeclCandidate[], area: IsolationArea, ports: VerifyPorts): Promise<CandidateRun[]> {
  const clock = ports.clock ?? Date.now;
  const runs: CandidateRun[] = [];
  for (const c of candidates) {
    if (c.blocked) { runs.push(inferred(c.id, c.blocked)); continue; }
    if (!ports.boundary.available) { runs.push(inferred(c.id, "EXEC_BOUNDARY_UNAVAILABLE")); continue; }
    const cwd = commandCwd(area, c.cwd);
    if (!cwd) { runs.push(inferred(c.id, "CWD_ESCAPE")); continue; }
    const started = clock();
    const r = await ports.run(ports.boundary.wrap(c.argv, area.root), { cwd, env: scanCommandEnv(area.root), timeoutMs: c.timeoutSec * 1000,
      maxBytes: 256 * 1024 });
    const verdict = classifyDeclFailure({ exitCode: r.code, timedOut: r.timedOut, stderr: r.stderr });
    const base = { exitCode: r.code, timedOut: r.timedOut, durationMs: Math.max(0, clock() - started), rescan: verdict.rescan };
    runs.push(verdict.failureClass === "PASSED" ? { id: c.id, status: "verified", reason: "VERIFIED", ...base } : inferred(c.id, verdict.failureClass, base));
  }
  return runs;
}
