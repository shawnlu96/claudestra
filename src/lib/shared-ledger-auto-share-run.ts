/**
 * N8A3: the cron daemon's auto-share timer runs each pass in a child process (scripts/shared-ledger-auto-share-pass.ts), so the
 * pass's synchronous pre-checks and prepare (export previews, VACUUM backup) never hold the cron event loop the mirror push
 * runs on. This side keeps only the timer, single flight (the pass lock, held and renewed here for the child) and the result.
 * A child past the hard timeout is killed; its open batch is read back from the journal: an uncommitted one is revoked (no
 * gate left), one that may have reached the center takes the unknown path of a lost commit.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { REPO_ROOT } from "./repo-root.js";
import { migrationLockPath } from "./shared-ledger-mirror.js";
import { autoSharePassLockPath, recoverTimedOutAutoSharePass, type AutoShareOutcome } from "./shared-ledger-auto-share.js";
import { armSpecPreflight } from "./spec-material-preflight-gate.js";

export const AUTO_SHARE_PASS_TIMEOUT_MS = 4 * 60_000;
const AUTO_SHARE_INTERVAL_MS = 5 * 60_000;
/** The parent's pass lock as `{ path, token }`: the child runs only while that lock is still the parent's. */
export const AUTO_SHARE_LOCK_ENV = "CLAUDESTRA_AUTO_SHARE_PASS_LOCK";
const PASS_SCRIPT = join(REPO_ROOT, "scripts", "shared-ledger-auto-share-pass.ts");

export interface AutoShareChildOptions {
  stateDir?: string; timeoutMs?: number; now?: () => number;
  /** Ledger handed to the child (tests); default the state dir's ledger.sqlite. */
  ledgerPath?: string;
  /** Child command (tests inject one that never returns); default bun on the pass script. */
  cmd?: string[];
}
export type AutoShareChildResult =
  | { status: "busy" | "failed" | "timeout" } | { status: "done"; outcomes: Record<string, AutoShareOutcome> };

/** Locks a killed child may have held (its token starts with its pid): it is gone, so they are released now, not at expiry. */
function releaseDeadChildLocks(dir: string, pid: number) {
  for (const path of [migrationLockPath(dir), join(dir, "shared-ledger-modes.json.lock"), join(dir, "shared-ledger-auto-share.json.lock")]) {
    try { if (readFileSync(join(path, "owner"), "utf8").startsWith(`${pid}.`)) rmSync(path, { recursive: true, force: true }); }
    catch { /* Not held (or unreadable): nothing of the child's to release. */ }
  }
}

export async function runAutoSharePassInChild(opts: AutoShareChildOptions = {}): Promise<AutoShareChildResult> {
  const dir = opts.stateDir ?? STATE_DIR, path = autoSharePassLockPath(dir);
  const lock = await acquireLock(path, 0);
  if (!lock) return { status: "busy" }; // Another pass is running.
  try {
    const cmd = opts.cmd ?? [process.execPath, "--no-env-file", PASS_SCRIPT, ...(opts.ledgerPath ? ["--ledger", opts.ledgerPath] : [])];
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "inherit",
      env: { ...process.env, CLAUDESTRA_STATE_DIR: dir, [AUTO_SHARE_LOCK_ENV]: JSON.stringify({ path, token: lock.token }) } });
    const out = new Response(child.stdout).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), opts.timeoutMs ?? AUTO_SHARE_PASS_TIMEOUT_MS); });
    const timedOut = await Promise.race([child.exited.then(() => false as const), late]);
    clearTimeout(timer);
    if (timedOut) {
      child.kill("SIGKILL");
      await child.exited;
      releaseDeadChildLocks(dir, child.pid);
      await recoverTimedOutAutoSharePass(dir, opts.ledgerPath ?? join(dir, "ledger.sqlite"), (opts.now ?? Date.now)());
      return { status: "timeout" };
    }
    if (child.exitCode !== 0) return { status: "failed" };
    try { return { status: "done", outcomes: JSON.parse(await out) as Record<string, AutoShareOutcome> }; }
    catch { return { status: "failed" }; } // A child that printed no result is reported like a failed one; its writes stand.
  } finally { lock.release(); }
}

/** Self-scheduling timer (no overlap); stop() for tests and shutdown. */
export function startSharedLedgerAutoShareLoop(opts: AutoShareChildOptions = {}, intervalMs = AUTO_SHARE_INTERVAL_MS): () => void {
  armSpecPreflight(); // timeout recovery writes the ledger from the cron process: arm the writer's preflight like the other writing entries (SPECG1)
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, loggedAt = 0;
  const run = async () => {
    let status: AutoShareChildResult["status"];
    try { status = (await runAutoSharePassInChild(opts)).status; }
    catch { status = "failed"; } // Spawn or state-file failure: reported below as a failed pass, the timer goes on.
    if ((status === "failed" || status === "timeout") && Date.now() - loggedAt > 600_000) {
      // Fixed text (errors may carry state paths), at most every 10 minutes.
      loggedAt = Date.now();
      console.error(status === "timeout" ? "共享台账自动共享本轮超时，子任务已终止（结果未知，下轮核对）" : "共享台账自动共享本轮失败（已隔离，不影响调度）");
    }
    if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
  };
  timer = setTimeout(run, 0);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
