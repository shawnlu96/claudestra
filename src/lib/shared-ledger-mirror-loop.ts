/**
 * PJ1 pusher, hosted by the cron daemon (src/cron.ts) on its own timer: a push failure or exception never reaches the
 * cron tick. Each pass reads the ledger read-only, pushes every due mirrored feature and persists only confirmed watermarks.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { instanceKeySync } from "./instance-key.js";
import { realScrub } from "./dag-write-scrub.js";
import { deferSharedLedger, sharedLedgerNotBefore, SharedLedgerRemoteError } from "./shared-ledger-client-transport.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import { readSharedLedgerMode, sharedLedgerPushable, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { MIRROR_PUSH_LOCK_STALE_MS, mirrorPushLockPath, readSharedLedgerMirrors, resolveMirrorCredential, updateSharedLedgerMirrors } from "./shared-ledger-mirror.js";
import { pushSourceDagMirror } from "./shared-ledger-source-dag-push.js";
import { mirrorBackoffMs, mirrorErrorSummary, mirrorTaskHeads, pushSharedLedgerMirror, type MirrorClient, type MirrorEntry, type PushOutcome } from "./shared-ledger-projector.js";

const MIRROR_INTERVAL_MS = 10_000;
export const MIRROR_REQUEST_GAP_MS = 600, MIRROR_FEATURES_PER_PASS = 12;
export interface MirrorLoopDeps {
  stateDir?: string;
  requestGapMs?: number;
  maxFeatures?: number;
  sleep?: (ms: number) => Promise<void>;
  ledgerPath?: string;
  now?: () => number;
  /** Real: SharedLedgerClient with the instance key and this pass's scrub context; tests inject a fake center. */
  client?: (credential: SharedLedgerLocalCredential, scrub: SharedLedgerScrubContext) => MirrorClient | null;
  /** Transport for the real client only (tests: a fake center behind the real client's own scrub). */
  fetch?: typeof fetch;
  /** Real: realScrub (dag-write-scrub.ts, shared with the DAG write check): local identity plus heads that are commits in the install repo. */
  scrub?: (heads: readonly string[]) => Promise<SharedLedgerScrubContext>;
}

function realClient(dir: string, deps: MirrorLoopDeps) {
  // The client scrubs again before upload: without the same commit allowlist a real head is rejected there.
  return (credential: SharedLedgerLocalCredential, scrub: SharedLedgerScrubContext) => {
    const key = instanceKeySync(dir);
    return key ? new SharedLedgerClient(credential, key, { scrub, fetch: deps.fetch, now: deps.now, stateDir: dir }) : null;
  };
}

/** Wrap actual sends so conflict recovery and source-DAG uploads consume the same spacing as projections. */
function pacedClients(deps: MirrorLoopDeps, dir: string, now: () => number) {
  let lastSent: number | null = null;
  const send = async <T>(baseUrl: string, action: () => Promise<T>): Promise<T> => {
    const wait = lastSent === null ? 0 : Math.max(0, lastSent + (deps.requestGapMs ?? MIRROR_REQUEST_GAP_MS) - now());
    if (wait) await (deps.sleep ?? Bun.sleep)(wait);
    const blocked = sharedLedgerNotBefore(baseUrl, dir) - now();
    if (blocked > 0) throw new SharedLedgerRemoteError(429, null, blocked);
    lastSent = now();
    return action();
  };
  return (client: MirrorClient, baseUrl: string): MirrorClient => ({
    projection: (p) => send(baseUrl, () => client.projection(p)),
    ...(client.sourceDag ? { sourceDag: (p: Parameters<NonNullable<MirrorClient["sourceDag"]>>[0]) => send(baseUrl, () => client.sourceDag!(p)) } : {}),
  });
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
  const lock = await acquireLock(mirrorPushLockPath(dir), 0, MIRROR_PUSH_LOCK_STALE_MS);
  if (!lock) return out; // Another pass or an `off` holds it.
  let db: Database | undefined;
  try {
    // Re-read under the push lock: an `off` that disabled the feature before we got here must win.
    const fresh = readSharedLedgerMirrors(dir);
    const live = due.flatMap(([id]) => fresh[id]?.enabled ? [[id, fresh[id]] as const] : [])
      .sort(([a, x], [b, y]) => (x.lastPushAt ?? 0) - (y.lastPushAt ?? 0) || a.localeCompare(b))
      .slice(0, deps.maxFeatures ?? MIRROR_FEATURES_PER_PASS);
    if (!live.length) return out;
    db = new Database(ledgerPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 2000");
    const pace = pacedClients(deps, dir, now);
    for (const [featureId, entry] of live) {
      let next: MirrorEntry = entry, outcome: PushOutcome, limited = false;
      let baseUrl: string | undefined;
      try {
        const credential = resolveMirrorCredential(entry, dir);
        if (!credential || credential.instanceId !== entry.sourceInstanceId) throw new Error("credential unavailable");
        baseUrl = credential.baseUrl;
        if (sharedLedgerNotBefore(baseUrl, dir) > now()) break;
        const scrub = await (deps.scrub ?? realScrub)(mirrorTaskHeads(db, featureId, entry.localProject));
        const raw = (deps.client ?? realClient(dir, deps))(credential, scrub);
        if (!raw) throw new Error("credential unavailable");
        const client = pace(raw, baseUrl);
        ({ entry: next, outcome } = await pushSharedLedgerMirror(db, featureId, entry, { client, scrub, now: now() }));
        // DAG errors stay in dag* fields; 429 escapes to end the pass without counting a failure.
        if (outcome.kind !== "failed") next = await pushSourceDagMirror(db, featureId, next, { client, scrub, now: now(), stateDir: dir });
      } catch (error) {
        if (error instanceof SharedLedgerRemoteError && error.status === 429 && baseUrl) {
          // Best effort: a held lock or failed write still ends the pass as a 429, never a counted failure.
          await deferSharedLedger(baseUrl, now() + Math.min(60_000, Math.max(0, error.retryAfterMs)), dir)
            .catch(() => console.warn("shared ledger cooldown not recorded"));
          next = { ...next, lastError: "中心限流", lastErrorAt: now() };
          outcome = { kind: "failed", error: "中心限流" };
          limited = true;
        } else {
          const failures = entry.failures + 1;
          const text = error instanceof Error && error.message === "credential unavailable" ? "本机 service 凭据或实例密钥不可用" : mirrorErrorSummary(error);
          next = { ...entry, failures, lastError: text, lastErrorAt: now(), nextAttemptAt: now() + mirrorBackoffMs(failures) };
          outcome = { kind: "failed", error: text };
        }
      }
      out[featureId] = outcome;
      if (outcome.kind === "idle" && next === entry) continue;
      // `off` or a re-`on` for another batch in between wins: only the fields this pass owns are written back.
      await updateSharedLedgerMirrors(dir, (features) => {
        const cur = features[featureId];
        if (cur?.enabled && cur.batchId === entry.batchId) features[featureId] = { ...cur, ...next, enabled: true, taskMeta: cur.taskMeta };
      });
      if (limited) break;
    }
  } finally { db?.close(); lock.release(); }
  return out;
}

/** Self-scheduling timer (no overlap); stop() for tests and shutdown. */
export function startSharedLedgerMirrorLoop(deps: MirrorLoopDeps = {}, intervalMs = MIRROR_INTERVAL_MS): () => void {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, loggedAt = 0;
  const run = async () => {
    const started = Date.now();
    try { await runSharedLedgerMirrorPass(deps); }
    catch {
      // Fixed text (errors may carry state paths), at most every 10 minutes so a stuck state file does not flood the log.
      if (Date.now() - loggedAt > 600_000) { loggedAt = Date.now(); console.error("共享台账镜像推送本轮失败（已隔离，不影响调度）"); }
    }
    // Count cadence from the start: adding ten seconds after a paced pass can starve the oldest observation past a minute.
    const delay = Math.max(Math.min(intervalMs, deps.requestGapMs ?? MIRROR_REQUEST_GAP_MS), intervalMs - (Date.now() - started));
    if (!stopped) { timer = setTimeout(run, delay); timer.unref?.(); }
  };
  timer = setTimeout(run, 0);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
