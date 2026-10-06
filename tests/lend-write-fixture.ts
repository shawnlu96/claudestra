/** Resources belong to one lab; callers register dispose in afterEach, including failed setup. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLendJournal } from "../src/lib/lend-journal.js";
import { runBounded, type BoundedResult } from "../src/lib/run-bounded.js";
import type { Run } from "../src/lib/lend-clone.js";
import { testChildEnv } from "./test-env.ts";

export function writeResources() {
  let closed = false;
  const checkOpen = () => { if (closed) throw new Error("lend-write fixture already disposed"); };
  const roots = new Set<string>();
  const dbs = new Set<ReturnType<typeof openLendJournal>>();
  const pending = new Set<Promise<BoundedResult>>();
  const temp = () => {
    checkOpen();
    const root = mkdtempSync(join(tmpdir(), "lend-write-"));
    roots.add(root);
    return root;
  };
  const journal = () => {
    checkOpen();
    const db = openLendJournal(":memory:");
    dbs.add(db);
    return db;
  };
  const run: Run = async (argv, opts) => {
    checkOpen();
    // runBounded owns the process group and reaps it on success, spawn failure and timeout.
    const task = runBounded(argv, { ...opts, timeoutMs: Math.min(opts.timeoutMs, 4_000) });
    pending.add(task);
    try { return await task; } finally { pending.delete(task); }
  };
  const dispose = async () => {
    closed = true;
    const errors: unknown[] = [];
    await Promise.allSettled([...pending]);
    for (const db of dbs) {
      try { db.close(); dbs.delete(db); } catch (error) { errors.push(error); }
    }
    for (const root of roots) {
      try { rmSync(root, { recursive: true, force: true }); roots.delete(root); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "lend-write fixture cleanup failed");
  };
  return { temp, journal, run, dispose, checkOpen };
}

type Resources = ReturnType<typeof writeResources>;

export function writeEnv(root: string) {
  const env = testChildEnv({
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), TMPDIR: join(root, "tmp"),
    CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"),
    CLAUDESTRA_SANDBOX: "1", CLAUDESTRA_LAB_ROOT: root,
    GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  });
  for (const key of ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR"]) mkdirSync(env[key], { recursive: true });
  return env;
}

export function writeLab(resources: Resources) {
  const root = resources.temp();
  const env = writeEnv(root);
  const tryGit = (cwd: string, ...args: string[]) => {
    resources.checkOpen();
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
    return { code: r.exitCode, stdout: r.stdout.toString().trim(), stderr: r.stderr.toString(), signal: r.signalCode };
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = tryGit(cwd, ...args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} (exit ${r.code}, signal ${r.signal}): ${r.stderr}`);
    return r.stdout;
  };
  const commit = (dir: string, file: string) => {
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", file);
    return git(dir, "rev-parse", "HEAD");
  };
  // Production filters Git config variables. Reapply only fixture isolation at the real spawn boundary.
  const run: Run = (argv, opts) => resources.run(argv, { ...opts, env: { ...opts.env, ...env } });
  const bare = join(root, "git", "o", "r.git");
  const seed = join(root, "seed");
  mkdirSync(bare, { recursive: true });
  mkdirSync(seed);
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "a\n");
  const target = join(root, "synthetic-env");
  writeFileSync(target, "SYNTHETIC=1\n");
  symlinkSync(target, join(seed, ".env"));
  git(seed, "add", "a.txt", ".env");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", bare, "main");
  return { root, env, bare, seed, git, tryGit, commit, run, lendRoot: join(root, "lend"), main: git(bare, "rev-parse", "main") };
}
