/**
 * N8A: active features of a project bound to a team are shared to the center read-only (PJ1 mirror) without a manual
 * prepare / commit / shared-mirror on. Hosted by the cron daemon on its own 5-minute timer next to the mirror loop.
 * - observe: candidate list + pre-check results only (0 center requests, 0 journal / mode writes).
 * - on: at most one batch per project per pass, ≤ 5 features; prepare → commit (approved under the batch's own
 *   manifestDigest, owner 10-08) → shared-mirror on each. Steps are the import library's; it takes its own locks.
 * Failures never leave a gate: anything before a possible center write is revoked at once; an unknown commit
 * outcome retries the same batch and halts the project after 3 in a row (PM clears with `shared-auto on`).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { LedgerError } from "./ledger-store.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "./shared-ledger-client.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { readSharedLedgerMode, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { sharedMirrorOn } from "./shared-ledger-mirror.js";
import { armSpecPreflight } from "./spec-material-preflight-gate.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import {
  advanceSharedLedgerImport, importScrubContext, MigrationError, prepareSharedLedgerImport, readSharedLedgerImportRecord,
  resolveImportCredential, revokeUncommittedSharedLedgerImport, sharedLedgerImportJournalPath,
} from "./shared-ledger-import-run.js";
import { abortRejectedSharedLedgerImport } from "./shared-ledger-import-run-abort.js";
import { AUTO_SHARE_REASONS, AUTO_SHARE_RULES, checkAutoShareCandidates } from "./shared-ledger-auto-share-check.js";
import {
  readAutoShareState, updateAutoShareProject, validAutoShareId, type AutoShareFeature, type AutoSharePending, type AutoShareProject,
} from "./shared-ledger-auto-share-state.js";

const AUTO_SHARE_INTERVAL_MS = 5 * 60_000;
export const AUTO_SHARE_BATCH_MAX = 5;
export const AUTO_SHARE_UNKNOWN_LIMIT = 3;
const MIRROR_RETRY = "镜像开启失败，下轮重试";

export interface AutoShareDeps {
  stateDir?: string;
  ledgerPath?: string;
  now?: () => number;
  /** Real: SharedLedgerClient with the instance key and the batch's scrub context; tests inject a fake center. */
  client?: (credential: SharedLedgerLocalCredential, scrub: SharedLedgerScrubContext) => SharedLedgerClient | null;
  /** Transport for the real client only. */
  fetch?: typeof fetch;
  /** Real: importScrubContext (local identity + heads that are commits in the install repo). */
  scrub?: (db: Database, plan: { localProject: string; featureIds: string[]; batchId: string }) => Promise<SharedLedgerScrubContext>;
  key?: () => InstanceKey | null;
}
export type AutoShareOutcome = { action: "observe" | "idle" | "halted" | "continued" | "batch" | "error"; batchId?: string };

interface Ctx { db: Database; dir: string; now: number; deps: AutoShareDeps; binding: SharedLedgerBinding & { localProjectId: string } }
const record = (c: Ctx, mutate: (p: AutoShareProject) => void) =>
  updateAutoShareProject(c.dir, c.binding.localProjectId, (p) => { mutate(p); p.lastRunAt = c.now; });
const scrubOf = (c: Ctx, featureIds: string[], batchId: string) =>
  (c.deps.scrub ?? ((db, plan) => importScrubContext(db, plan, c.dir, { username: userInfo().username, hostname: hostname() })))(
    c.db, { localProject: c.binding.localProjectId, featureIds, batchId });
/** A `shared-auto off|observe|exclude` that completed while the pass awaited: the batch's features no longer may leave. */
class AutoShareFenced extends MigrationError {}
/** The PM's current controls (re-read, never the pass's start-of-pass copy): null = this batch may upload. */
function controlsRefuse(cur: AutoShareProject | undefined, featureIds: readonly string[]): string | null {
  if (!cur || cur.mode !== "on" || cur.halted) return "mode";
  return featureIds.some((id) => cur.exclude.includes(id)) ? "exclude" : null;
}
/** One batch's send authorization; `tripped` survives the transport turning the refusal into SharedLedgerUnavailable. */
interface Fence { tripped: boolean; check(): void }
function fenceOf(c: Ctx, featureIds: readonly string[]): Fence {
  const fence: Fence = { tripped: false, check() {
    if (!controlsRefuse(readAutoShareState(c.dir)[c.binding.localProjectId], featureIds)) return;
    fence.tripped = true;
    throw new AutoShareFenced("auto-share controls changed");
  } };
  return fence;
}
/**
 * Fence at the send itself: the payload leaves only in a POST to `imports` (dry-run and commit; `imports/<batchId>`
 * is the abort/revoke control). The real client's fetch re-reads the controls synchronously right before that POST, after
 * every await the client makes on its own (commitImport's receipt lookup, dry-run retries), so a control change that
 * completed before the request leaves goes un-uploaded.
 */
function clientOf(c: Ctx, credential: SharedLedgerLocalCredential, scrub: SharedLedgerScrubContext, fence: Fence) {
  if (c.deps.client) {
    // Injected test clients have no transport: fence at their payload methods instead.
    const client = c.deps.client(credential, scrub);
    return client && new Proxy(client, { get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop !== "import" && prop !== "commitImport") return value.bind(target);
      return (...args: unknown[]) => { fence.check(); return value.apply(target, args); };
    } });
  }
  const key = (c.deps.key ?? (() => instanceKeySync(c.dir)))(), send = c.deps.fetch ?? fetch;
  const payloadPath = `/v1/teams/${credential.teamId}/imports`;
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if ((init?.method ?? "GET") !== "GET" && url.pathname === payloadPath) fence.check();
    return send(input, init);
  }) as typeof fetch;
  return key ? new SharedLedgerClient(credential, key, { scrub, fetch: fetcher }) : null;
}
const audit = (p: AutoShareProject, batchId: string, outcome: string) => {
  const entry = p.batches?.find((b) => b.batchId === batchId);
  if (entry) entry.outcome = outcome;
};
/** Per-feature result for every id of a batch (rev / version from the ledger, so a refusal knows when to retry). */
function mark(c: Ctx, p: AutoShareProject, ids: readonly string[], status: AutoShareFeature["status"], reason?: string) {
  p.features ??= {};
  for (const id of ids) {
    const row = c.db.prepare("SELECT rev, currentVersion FROM features WHERE id = ?").get(id) as { rev: number; currentVersion: number } | null;
    p.features[id] = { status, ...(reason ? { reason } : {}), ...(row ? { rev: row.rev, version: row.currentVersion } : {}), at: c.now, ...(status === "refused" ? { rules: AUTO_SHARE_RULES } : {}) };
  }
}

/** `auto-<localProjectId>-<UTC yyyymmddHHMM>`, `-2`, `-3`… when a journal already holds the name. */
export function autoShareBatchId(dir: string, localProjectId: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const base = `auto-${localProjectId.slice(0, 128 - 23)}-${stamp}`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(sharedLedgerImportJournalPath(dir, id))) return id;
  }
}

async function mirrorBatch(c: Ctx, pending: AutoSharePending): Promise<AutoShareOutcome> {
  const failed: string[] = [];
  for (const id of pending.featureIds) {
    if (readSharedLedgerMode(id, c.dir).mirror) continue;
    try { await sharedMirrorOn(c.db, id, { stateDir: c.dir, ...(c.deps.key ? { key: c.deps.key } : {}) }); }
    catch { failed.push(id); } // Recorded on the feature below; the committed batch stays, the next pass retries mirror on.
  }
  await record(c, (p) => {
    mark(c, p, pending.featureIds.filter((id) => !failed.includes(id)), "shared");
    mark(c, p, failed, "in_batch", MIRROR_RETRY);
    p.pending = failed.length ? pending : null;
    p.lastError = failed.length ? MIRROR_RETRY : null;
  });
  return { action: "batch", batchId: pending.batchId };
}

/** Undo a batch that can have no center write; the features are pre-checked again next pass (or stay refused). */
async function revokeBatch(c: Ctx, pending: AutoSharePending, digest: string, status: "deferred" | "refused", reason: string, outcome: string) {
  await revokeUncommittedSharedLedgerImport(c.db, c.dir, pending.batchId, digest);
  await record(c, (p) => { mark(c, p, pending.featureIds, status, reason); p.pending = null; p.lastError = null; audit(p, pending.batchId, outcome); });
}

async function commitBatch(c: Ctx, pending: AutoSharePending, client: SharedLedgerClient, fence: Fence): Promise<AutoShareOutcome> {
  const out = { action: "batch" as const, batchId: pending.batchId };
  let status: string;
  try { status = (await advanceSharedLedgerImport(c.db, c.dir, pending.batchId, client, pending.digest, "commit")).status; }
  catch (error) {
    const phase = readSharedLedgerImportRecord(sharedLedgerImportJournalPath(c.dir, pending.batchId))?.phase;
    const fenced = error instanceof AutoShareFenced || fence.tripped;
    try {
      if (error instanceof SharedLedgerRemoteError && error.status >= 400 && error.status < 500) {
        if (phase === "committing") {
          await abortRejectedSharedLedgerImport(c.db, c.dir, pending.batchId, client, pending.digest);
          await record(c, (p) => { mark(c, p, pending.featureIds, "refused", AUTO_SHARE_REASONS.center); p.pending = null; audit(p, pending.batchId, "rejected"); });
        } else await revokeBatch(c, pending, pending.digest, "refused", AUTO_SHARE_REASONS.center, "rejected");
        return out;
      }
      // Fenced after the dry-run (journal committing, commit never sent): abort only if the center holds no receipt.
      if (phase === "committing" && fenced) {
        await abortRejectedSharedLedgerImport(c.db, c.dir, pending.batchId, client, pending.digest);
        await record(c, (p) => { mark(c, p, pending.featureIds, "deferred", AUTO_SHARE_REASONS.control); p.pending = null; p.lastError = null; audit(p, pending.batchId, "fenced"); });
        return out;
      }
      // A local refusal before the journal reached committing (e.g. planning changed, controls changed): no center write is possible.
      if (phase === "prepared" && fenced) {
        await revokeBatch(c, pending, pending.digest, "deferred", AUTO_SHARE_REASONS.control, "fenced");
        return out;
      }
      if (phase === "prepared" && error instanceof MigrationError) {
        await revokeBatch(c, pending, pending.digest, "deferred", AUTO_SHARE_REASONS.precheck, "revoked");
        return out;
      }
    } catch { /* The undo itself failed: fall through and treat the outcome as unknown, so the same batch is retried. */ }
    const unknown = pending.unknown + 1, halted = unknown >= AUTO_SHARE_UNKNOWN_LIMIT;
    await record(c, (p) => {
      p.pending = { ...pending, unknown };
      if (halted) { p.halted = { batchId: pending.batchId, at: c.now }; audit(p, pending.batchId, "halted"); }
      p.lastError = halted ? `提交结果连续 ${unknown} 次未知，已停开新批；PM 核对批次 ${pending.batchId} 的 journal 后 shared-auto on`
        : `提交结果未知（第 ${unknown} 次），下轮重试同一批`;
    });
    return out;
  }
  await record(c, (p) => { audit(p, pending.batchId, status); p.lastError = null; });
  if (status !== "staged") {
    await record(c, (p) => { p.pending = null; });
    return out;
  }
  return mirrorBatch(c, pending);
}

async function openBatch(c: Ctx, featureIds: string[], credential: SharedLedgerLocalCredential, results: Record<string, AutoShareFeature>) {
  const lp = c.binding.localProjectId, batchId = autoShareBatchId(c.dir, lp, c.now);
  // Everything that may wait (git scrub, credential, client) is ready before the gate closes: the window holds only commit.
  const scrub = await scrubOf(c, featureIds, batchId), fence = fenceOf(c, featureIds), client = clientOf(c, credential, scrub, fence);
  if (!client) throw new MigrationError("local import credential unavailable");
  const pending: AutoSharePending = { batchId, digest: "", featureIds, unknown: 0, at: c.now };
  // The batch is authorized here, under the state lock the `shared-auto` command writes under, against the controls
  // as they are now: a change that completed while the pre-checks awaited wins, and no journal or gate is written.
  let refused = null as string | null;
  await record(c, (p) => {
    refused = controlsRefuse(p, featureIds);
    if (refused) {
      p.features = results;
      for (const id of featureIds) if (p.exclude.includes(id)) p.features[id] = { status: "excluded", at: c.now };
      return;
    }
    p.features = results; p.pending = pending;
    p.batches = [...(p.batches ?? []), { batchId, digest: "", featureIds, at: c.now, outcome: "preparing" }].slice(-50);
  });
  if (refused) return { action: "idle" as const };
  try {
    pending.digest = (await prepareSharedLedgerImport(c.db, { localProject: lp, projectId: c.binding.projectId, sourceInstanceId: credential.instanceId,
      featureIds, batchId, stateDir: c.dir, scrub, summaries: {} })).payload.manifestDigest;
  } catch {
    const journal = readSharedLedgerImportRecord(sharedLedgerImportJournalPath(c.dir, batchId));
    if (journal && (journal.phase === "gating" || journal.phase === "prepared")) {
      await revokeBatch(c, pending, journal.payload?.manifestDigest ?? "", "deferred", "导入准备失败，已撤闸，下轮重新预检", "prepare-failed");
    } else await record(c, (p) => { mark(c, p, featureIds, "deferred", AUTO_SHARE_REASONS.precheck); p.pending = null; audit(p, batchId, "prepare-failed"); });
    return { action: "batch" as const, batchId };
  }
  await record(c, (p) => {
    mark(c, p, featureIds, "in_batch"); p.pending = pending;
    const entry = p.batches?.find((b) => b.batchId === batchId);
    if (entry) { entry.digest = pending.digest; entry.outcome = "prepared"; }
  });
  return commitBatch(c, pending, client, fence);
}

/** The project's open batch is this pass's batch: finish it before any new one. */
async function continueBatch(c: Ctx, pending: AutoSharePending, credential: SharedLedgerLocalCredential | null): Promise<AutoShareOutcome> {
  const journal = readSharedLedgerImportRecord(sharedLedgerImportJournalPath(c.dir, pending.batchId));
  const out = { action: "continued" as const, batchId: pending.batchId };
  if (!journal || ["revoked", "aborted", "active"].includes(journal.phase)) {
    await record(c, (p) => { p.pending = null; audit(p, pending.batchId, journal?.phase ?? "missing"); });
    return out;
  }
  if (journal.phase === "gating") {
    await revokeBatch(c, pending, "", "deferred", "导入准备失败，已撤闸，下轮重新预检", "prepare-failed");
    return out;
  }
  if (journal.phase === "verified") return { ...(await mirrorBatch(c, pending)), action: "continued" };
  const digest = journal.payload!.manifestDigest, scrub = await scrubOf(c, pending.featureIds, pending.batchId);
  const fence = fenceOf(c, pending.featureIds), client = credential && clientOf(c, credential, scrub, fence);
  if (!client) {
    await record(c, (p) => { p.lastError = "本机没有带 import 权限的 service 凭据或实例密钥，批次待续"; });
    return out;
  }
  return { ...(await commitBatch(c, { ...pending, digest }, client, fence)), action: "continued" };
}

async function runProject(c: Ctx, cfg: AutoShareProject): Promise<AutoShareOutcome> {
  const credential = resolveImportCredential(c.binding, c.dir);
  if (cfg.mode === "on" && cfg.halted) { await record(c, () => {}); return { action: "halted", batchId: cfg.halted.batchId }; }
  if (cfg.mode === "on" && cfg.pending) return continueBatch(c, cfg.pending, credential);
  const { results, ready } = await checkAutoShareCandidates({ db: c.db, dir: c.dir, localProject: c.binding.localProjectId,
    projectId: c.binding.projectId, sourceInstanceId: credential?.instanceId ?? "auto-observe", exclude: cfg.exclude,
    prior: cfg.features ?? {}, pendingIds: new Set(cfg.pending?.featureIds ?? []), now: c.now,
    scrub: (featureIds, batchId) => scrubOf(c, featureIds, batchId) });
  if (cfg.mode === "observe" || !ready.length) {
    await record(c, (p) => { p.features = results; p.lastError = null; });
    return { action: cfg.mode === "observe" ? "observe" : "idle" };
  }
  if (!credential) {
    await record(c, (p) => { p.features = results; p.lastError = "本机没有带 import 权限的 service 凭据，未开新批"; });
    return { action: "idle" };
  }
  return openBatch(c, ready.slice(0, AUTO_SHARE_BATCH_MAX), credential, results);
}

/** One pass over every bound project whose switch is not off. A project's failure is recorded on it and never thrown. */
export async function runSharedLedgerAutoSharePass(deps: AutoShareDeps = {}): Promise<Record<string, AutoShareOutcome>> {
  const dir = deps.stateDir ?? STATE_DIR, now = (deps.now ?? Date.now)(), ledgerPath = deps.ledgerPath ?? join(dir, "ledger.sqlite");
  const out: Record<string, AutoShareOutcome> = {}, state = readAutoShareState(dir);
  const bound = readSharedLedgerBindings(dir).filter((b): b is Ctx["binding"] => validAutoShareId(b.localProjectId)
    && (state[b.localProjectId]?.mode ?? "off") !== "off");
  if (!bound.length || !existsSync(ledgerPath)) return out;
  const lock = await acquireLock(join(dir, "shared-ledger-auto-share.pass.lock"), 0);
  if (!lock) return out; // Another pass is running.
  const db = new Database(ledgerPath, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 2000");
    for (const binding of bound) {
      const c: Ctx = { db, dir, now, deps, binding };
      try { out[binding.localProjectId] = await runProject(c, state[binding.localProjectId]!); }
      catch (error) {
        out[binding.localProjectId] = { action: "error" };
        const text = error instanceof MigrationError || error instanceof LedgerError ? error.message : "自动共享本轮失败（已隔离）";
        await record(c, (p) => { p.lastError = text; });
      }
    }
  } finally { db.close(); lock.release(); }
  return out;
}

/** Self-scheduling timer (no overlap); stop() for tests and shutdown. */
export function startSharedLedgerAutoShareLoop(deps: AutoShareDeps = {}, intervalMs = AUTO_SHARE_INTERVAL_MS): () => void {
  armSpecPreflight(); // this loop writes the ledger from the cron process: arm the writer's preflight like the other writing entries (SPECG1)
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, loggedAt = 0;
  const run = async () => {
    try { await runSharedLedgerAutoSharePass(deps); }
    catch {
      // Unreadable state / bindings file: fixed text (errors may carry state paths), at most every 10 minutes.
      if (Date.now() - loggedAt > 600_000) { loggedAt = Date.now(); console.error("共享台账自动共享本轮失败（已隔离，不影响调度）"); }
    }
    if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
  };
  timer = setTimeout(run, 0);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
