import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const PREFIX = "cstra-test-run-";
const STALE_MS = 2 * 60 * 60 * 1_000;
type Identity = Pick<Stats, "dev" | "ino">;

function checkedRoot(path: string, parent: string, identity?: Identity): Stats {
  if (dirname(path) !== parent || !basename(path).startsWith(PREFIX) || basename(path) === PREFIX) {
    throw new Error("not a test root directly inside the original tmpdir");
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("test root is not a real directory");
  if (realpathSync(parent) !== parent || realpathSync(path) !== path) throw new Error("test root resolves outside its original location");
  if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) throw new Error("test root was replaced");
  return stat;
}

function removeRoot(path: string, parent: string, identity?: Identity, olderThan?: number): void {
  try {
    const stat = checkedRoot(path, parent, identity);
    if (olderThan !== undefined && stat.mtimeMs >= olderThan) return;
    // Recheck the directory identity immediately before removal; rmSync unlinks interior symlinks without following them.
    checkedRoot(path, parent, stat);
    rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
  } catch (error) {
    // Another test process can reap the same stale root first, or a test can already have removed its own root.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[test-tmp-root] Refusing/failed cleanup of ${path}: ${error}`);
  }
}

/** Only this prefix belongs to the preload; old per-test prefixes and other applications' temp files are never swept. */
function sweepStaleRoots(parent: string): void {
  try {
    const cutoff = Date.now() - STALE_MS;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.name.startsWith(PREFIX)) removeRoot(join(parent, entry.name), parent, undefined, cutoff);
    }
  } catch (error) {
    console.warn(`[test-tmp-root] Could not scan ${parent}: ${error}`);
  }
}

export function createTestTmpRoot(originalTmpDir = tmpdir()): { path: string; cleanup: () => void } {
  // Resolve the parent once: /tmp and /var on macOS are themselves legitimate symlinks.
  const parent = realpathSync(originalTmpDir);
  sweepStaleRoots(parent);
  const path = mkdtempSync(join(parent, `${PREFIX}${process.pid}-`));
  const identity = checkedRoot(path, parent);
  return { path, cleanup: () => removeRoot(path, parent, identity) };
}

function inheritEnv<T extends (...args: any[]) => any>(spawn: T): T {
  return ((command: string[] | { env?: NodeJS.ProcessEnv }, options?: { env?: NodeJS.ProcessEnv }) => {
    const config = Array.isArray(command) ? options : command;
    const inherited = { ...config, env: config?.env ?? process.env };
    return Array.isArray(command) ? spawn(command, inherited) : spawn(inherited);
  }) as T;
}

export function installTestTmpRoot(): () => void {
  const { path, cleanup } = createTestTmpRoot();
  // Synchronous exit cleanup also covers failing tests and uncaught errors without swallowing the failure.
  process.once("exit", cleanup);
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  // A child inherits this root. A child with an explicit TMPDIR keeps using its own chosen location.
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = path;
  // Bun's env-less spawn uses the startup environment, ignoring preload's process.env edits (also on CI's Bun).
  // Supply the current environment for both overloads; explicit env options retain their existing semantics.
  Bun.spawn = inheritEnv(Bun.spawn);
  Bun.spawnSync = inheritEnv(Bun.spawnSync);
  return cleanup;
}
