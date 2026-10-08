/**
 * PJ1 pusher, hosted by the cron daemon (src/cron.ts) on its own timer: a push failure or exception never reaches the
 * cron tick. Each pass reads the ledger read-only, pushes every due mirrored feature and persists only confirmed watermarks.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { REPO_ROOT } from "./repo-root.js";
import { instanceKeySync } from "./instance-key.js";
import { knownCommits } from "./peer-pr-github.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import { readSharedLedgerMode, sharedLedgerPushable, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { mirrorPushLockPath, readSharedLedgerMirrors, resolveMirrorCredential, updateSharedLedgerMirrors } from "./shared-ledger-mirror.js";
import { mirrorBackoffMs, mirrorErrorSummary, mirrorTaskHeads, pushSharedLedgerMirror, type MirrorClient, type MirrorEntry, type PushOutcome } from "./shared-ledger-projector.js";

const MIRROR_INTERVAL_MS = 10_000;
export interface MirrorLoopDeps {
  stateDir?: string;
  ledgerPath?: string;
  now?: () => number;
  /** Real: SharedLedgerClient with the instance key and this pass's scrub context; tests inject a fake center. */
  client?: (credential: SharedLedgerLocalCredential, scrub: SharedLedgerScrubContext) => MirrorClient | null;
  /** Transport for the real client only (tests: a fake center behind the real client's own scrub). */
  fetch?: typeof fetch;
  /** Real: local identity plus heads that are commits in the install repo. */
  scrub?: (heads: readonly string[]) => Promise<SharedLedgerScrubContext>;
}

const known = new Set<string>();
async function realScrub(heads: readonly string[]): Promise<SharedLedgerScrubContext> {
  const want = heads.filter((h) => !known.has(h));
  for (let i = 0; i < want.length; i += 200) for (const sha of await knownCommits(REPO_ROOT, want.slice(i, i + 200))) known.add(sha);
  return { identity: { username: userInfo().username, hostname: hostname() }, commits: new Set(heads.filter((h) => known.has(h))) };
}
function realClient(dir: string, fetcher?: typeof fetch) {
  // The client scrubs again before upload: without the same commit allowlist a real head is rejected there.
  return (credential: SharedLedgerLocalCredential, scrub: SharedLedgerScrubContext) => {
    const key = instanceKeySync(dir);
    return key ? new SharedLedgerClient(credential, key, { scrub, ...(fetcher ? { fetch: fetcher } : {}) }) : null;
  };
}

/** One pass. Never throws for a feature's failure; that is recorded on the feature with a backoff. */
export async function runSharedLedgerMirrorPass(deps: MirrorLoopDeps = {}): Promise<Record<string, PushOutcome>> {
  const dir = deps.stateDir ?? STATE_DIR, now = deps.now ?? Date.now, ledgerPath = deps.ledgerPath ?? join(dir, "ledger.sqlite");
  const out: Record<string, PushOutcome> = {};
  const due = Object.entries(readSharedLedgerMirrors(dir)).filter(([id, e]) => {
    if (!e.enabled || e.nextAttemptAt > now()) return false;
    try { return sharedLedgerPushable(readSharedLedgerMode(id, dir)); }
    catch { return false; } // Unverifiable authority: do not push on its behalf.
  });
  if (!due.length || !existsSync(ledgerPath)) return out;
  const lock = await acquireLock(mirrorPushLockPath(dir), 0);
  if (!lock) return out; // Another pass or an `off` holds it.
  let db: Database | undefined;
  try {
    // Re-read under the push lock: an `off` that disabled the feature before we got here must win.
    const fresh = readSharedLedgerMirrors(dir);
    const live = due.flatMap(([id]) => fresh[id]?.enabled ? [[id, fresh[id]] as const] : []);
    if (!live.length) return out;
    db = new Database(ledgerPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 2000");
    for (const [featureId, entry] of live) {
      let next: MirrorEntry, outcome: PushOutcome;
      try {
        const credential = resolveMirrorCredential(entry, dir);
        if (!credential || credential.instanceId !== entry.sourceInstanceId) throw new Error("credential unavailable");
        const scrub = await (deps.scrub ?? realScrub)(mirrorTaskHeads(db, featureId, entry.localProject));
        const client = (deps.client ?? realClient(dir, deps.fetch))(credential, scrub);
        if (!client) throw new Error("credential unavailable");
        ({ entry: next, outcome } = await pushSharedLedgerMirror(db, featureId, entry, { client, scrub, now: now() }));
      } catch (error) {
        const failures = entry.failures + 1;
        const text = error instanceof Error && error.message === "credential unavailable" ? "本机 service 凭据或实例密钥不可用" : mirrorErrorSummary(error);
        next = { ...entry, failures, lastError: text, lastErrorAt: now(), nextAttemptAt: now() + mirrorBackoffMs(failures) };
        outcome = { kind: "failed", error: text };
      }
      out[featureId] = outcome;
      if (outcome.kind === "idle") continue;
      // `off` or a re-`on` for another batch in between wins: only the fields this pass owns are written back.
      await updateSharedLedgerMirrors(dir, (features) => {
        const cur = features[featureId];
        if (cur?.enabled && cur.batchId === entry.batchId) features[featureId] = { ...cur, ...next, enabled: true, taskMeta: cur.taskMeta };
      });
    }
  } finally { db?.close(); lock.release(); }
  return out;
}

/** Self-scheduling timer (no overlap); stop() for tests and shutdown. */
export function startSharedLedgerMirrorLoop(deps: MirrorLoopDeps = {}, intervalMs = MIRROR_INTERVAL_MS): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, loggedAt = 0;
  const run = async () => {
    try { await runSharedLedgerMirrorPass(deps); }
    catch {
      // Fixed text (errors may carry state paths), at most every 10 minutes so a stuck state file does not flood the log.
      if (Date.now() - loggedAt > 600_000) { loggedAt = Date.now(); console.error("共享台账镜像推送本轮失败（已隔离，不影响调度）"); }
    }
    if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
  };
  timer = setTimeout(run, 0);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
