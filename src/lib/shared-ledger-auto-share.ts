/**
 * N8A: active features of a project bound to a team are shared to the center read-only (PJ1 mirror) without a manual
 * prepare / commit / shared-mirror on. Hosted by the cron daemon on its own 5-minute timer next to the mirror loop.
 * - observe: candidate list + pre-check results only (0 center requests, 0 journal / mode writes).
 * - on: at most one batch per project per pass (shared-ledger-auto-share-batch.ts picks it); prepare → commit (approved under the batch's own
 *   manifestDigest, owner 10-08) → shared-mirror on each. Steps are the import library's; it takes its own locks.
 * Failures never leave a gate: anything before a possible center write is revoked at once; an unknown commit
 * outcome retries the same batch and halts the project after 3 in a row (PM clears with `shared-auto on`). A multi-feature
 * batch that fails prepare, is too large or is refused by the center splits: each feature is batched alone from the next pass;
 * alone, the same failure refuses it. An identity / rate refusal (401 / 403 / 429) refuses nothing: the batch waits a pass.
 * The cron daemon runs a pass out of process (shared-ledger-auto-share-run.ts).
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { acquireLock, lockOwnedBy } from "./file-lock.js";
import { STATE_DIR } from "./paths.js";
import { LedgerError } from "./ledger-store.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "./shared-ledger-client.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { readSharedLedgerMode, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { sharedMirrorOn } from "./shared-ledger-mirror.js";
import type { SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import {
  advanceSharedLedgerImport, importScrubContext, MigrationError, prepareSharedLedgerImport, readSharedLedgerImportRecord,
  resolveImportCredential, revokeUncommittedSharedLedgerImport, sharedLedgerImportJournalPath,
} from "./shared-ledger-import-run.js";
import { abortRejectedSharedLedgerImport } from "./shared-ledger-import-run-abort.js";
import { SHARED_LEDGER_ERROR_STATUS } from "./shared-ledger-contract.js";
import {
  AUTO_SHARE_REASONS, AUTO_SHARE_RULES, autoShareCenterBusy, autoShareCenterRefused, checkAutoShareCandidates,
} from "./shared-ledger-auto-share-check.js";
import { AUTO_SHARE_MAX_BATCH_BYTES, autoShareRequestBytes, selectAutoShareBatch } from "./shared-ledger-auto-share-batch.js";
import {
  readAutoShareState, updateAutoShareProject, validAutoShareId, type AutoShareFeature, type AutoSharePending, type AutoShareProject,
} from "./shared-ledger-auto-share-state.js";

const AUTO_SHARE_UNKNOWN_LIMIT = 3;
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
  /** Real: prepareSharedLedgerImport; tests inject a failing prepare. */
  prepare?: typeof prepareSharedLedgerImport;
  /** The pass lock as already held by the parent that started this pass (lock path + token); absent = take it here. */
  heldLock?: { path: string; token: string };
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
function autoShareBatchId(dir: string, localProjectId: string, now: number): string {
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

/** How a batch failed as a whole; `center` carries the contract error code the center refused it with. */
type BatchFailure = "prepare" | "size" | { center: string };
/** A batch failed as a whole: several features are each batched alone from the next pass; one alone is refused. */
function markFailed(c: Ctx, p: AutoShareProject, ids: readonly string[], kind: BatchFailure) {
  const R = AUTO_SHARE_REASONS;
  if (ids.length < 2) return mark(c, p, ids, "refused", kind === "prepare" ? R.prepare : kind === "size" ? R.tooLarge : autoShareCenterRefused(kind.center));
  mark(c, p, ids, "deferred", kind === "prepare" ? R.batchPrepare : kind === "size" ? R.batchTooLarge : R.batchRejected);
  for (const id of ids) p.features![id]!.solo = true;
}
const failed = (c: Ctx, ids: readonly string[], kind: BatchFailure) => (p: AutoShareProject) => markFailed(c, p, ids, kind);
const marked = (c: Ctx, ids: readonly string[], status: "deferred" | "refused", reason: string) => (p: AutoShareProject) => mark(c, p, ids, status, reason);
/** The center's error code if it is one of the contract's, else `unknown`: its message text is never recorded. */
function centerCode(error: SharedLedgerRemoteError): string {
  const code = (error.response as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(SHARED_LEDGER_ERROR_STATUS, code) ? code : "unknown";
}
const tooLarge = (error: SharedLedgerRemoteError) => error.status === 413 || centerCode(error) === "payload_too_large";
/** Identity / rate limits say nothing about the content: 401 / 403 / 429, or a contract code of those statuses. */
const AUTO_SHARE_BUSY_STATUS: readonly number[] = [401, 403, 429];
function centerBusy(error: SharedLedgerRemoteError): boolean {
  const code = centerCode(error);
  return AUTO_SHARE_BUSY_STATUS.includes(error.status)
    || (code !== "unknown" && AUTO_SHARE_BUSY_STATUS.includes(SHARED_LEDGER_ERROR_STATUS[code as keyof typeof SHARED_LEDGER_ERROR_STATUS]));
}

/** Undo a batch that can have no center write; the features are pre-checked again next pass (or stay refused). */
async function revokeBatch(c: Ctx, pending: AutoSharePending, digest: string, apply: (p: AutoShareProject) => void, outcome: string) {
  await revokeUncommittedSharedLedgerImport(c.db, c.dir, pending.batchId, digest);
  await record(c, (p) => { p.lastError = null; apply(p); p.pending = null; audit(p, pending.batchId, outcome); });
}

/** The batch's outcome is unknown (lost transport, or a pass killed at its timeout): retried next pass, halts at the limit. */
function markAutoShareUnknown(p: AutoShareProject, pending: AutoSharePending, now: number) {
  const unknown = pending.unknown + 1, halted = unknown >= AUTO_SHARE_UNKNOWN_LIMIT;
  p.pending = { ...pending, unknown };
  if (halted) { p.halted = { batchId: pending.batchId, at: now }; audit(p, pending.batchId, "halted"); }
  p.lastError = halted ? `提交结果连续 ${unknown} 次未知，已停开新批；PM 核对批次 ${pending.batchId} 的 journal 后 shared-auto on`
    : `提交结果未知（第 ${unknown} 次），下轮重试同一批`;
}

/**
 * A pass killed at its timeout (shared-ledger-auto-share-run.ts), read back from each open batch's journal:
 * gating / prepared had no possible center write, so the gate comes down now and the batch counts as a failed prepare
 * (several features: each alone next pass; one alone: refused). From committing on, the center may hold it: the
 * unknown path (gate kept, next pass reads the receipt). An undo that fails falls back to unknown as well. The journal
 * decides, not the switch: a project turned off while its child was in prepare is undone too, and stays off.
 */
export async function recoverTimedOutAutoSharePass(dir: string, ledgerPath: string, now: number) {
  const db = existsSync(ledgerPath) ? new Database(ledgerPath, { readonly: true }) : null;
  try {
    for (const [id, cfg] of Object.entries(readAutoShareState(dir))) {
      // Switched off mid-pass still gets its open batch undone (the switch stays off); with nothing open it is left alone.
      if (cfg.mode === "off" && !cfg.pending) continue;
      const pending = cfg.pending, journal = pending && validAutoShareId(pending.batchId)
        ? readSharedLedgerImportRecord(sharedLedgerImportJournalPath(dir, pending.batchId)) : null;
      if (db && pending && journal && (journal.phase === "gating" || journal.phase === "prepared")) {
        const c = { db, dir, now, deps: {}, binding: { localProjectId: id } } as Ctx;
        try {
          await revokeBatch(c, pending, journal.payload?.manifestDigest ?? "", failed(c, pending.featureIds, "prepare"), "timeout");
          await record(c, (p) => { p.lastError = "自动共享本轮超时，已终止；批次未提交，已撤闸"; });
          continue;
        } catch { /* Not undone: unknown below, the next pass reads the journal again. */ }
      }
      await updateAutoShareProject(dir, id, (p) => {
        p.lastRunAt = now;
        if (p.mode === "on" && p.pending && !p.halted) markAutoShareUnknown(p, p.pending, now);
        else p.lastError = "自动共享本轮超时，已终止，结果未知；下轮重新预检";
      });
    }
  } finally { db?.close(); }
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
        const code = centerCode(error), size = tooLarge(error), busy = !size && centerBusy(error);
        const outcome = size ? "too-large" : busy ? "center-busy" : "rejected";
        const apply = size ? failed(c, pending.featureIds, "size")
          : busy ? (p: AutoShareProject) => { mark(c, p, pending.featureIds, "deferred", autoShareCenterBusy(code)); p.lastError = autoShareCenterBusy(code); }
          : failed(c, pending.featureIds, { center: code });
        if (phase === "committing") {
          await abortRejectedSharedLedgerImport(c.db, c.dir, pending.batchId, client, pending.digest);
          await record(c, (p) => { p.lastError = null; apply(p); p.pending = null; audit(p, pending.batchId, outcome); });
        } else await revokeBatch(c, pending, pending.digest, apply, outcome);
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
        await revokeBatch(c, pending, pending.digest, marked(c, pending.featureIds, "deferred", AUTO_SHARE_REASONS.control), "fenced");
        return out;
      }
      if (phase === "prepared" && error instanceof MigrationError) {
        await revokeBatch(c, pending, pending.digest, marked(c, pending.featureIds, "deferred", AUTO_SHARE_REASONS.precheck), "revoked");
        return out;
      }
    } catch (undo) {
      // The receipt check behind the undo was itself refused for identity / rate limits: the center may hold the batch,
      // so the gate and journal stay and the same batch is retried next pass, without counting toward the unknown halt.
      if (undo instanceof SharedLedgerRemoteError && centerBusy(undo)) {
        const reason = autoShareCenterBusy(centerCode(undo));
        await record(c, (p) => { mark(c, p, pending.featureIds, "in_batch", reason); p.pending = pending; p.lastError = reason; audit(p, pending.batchId, "center-busy"); });
        return out;
      }
      /* The undo itself failed otherwise: fall through and treat the outcome as unknown, so the same batch is retried. */
    }
    await record(c, (p) => markAutoShareUnknown(p, pending, c.now));
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
  let bytes: number;
  try {
    const { payload } = await (c.deps.prepare ?? prepareSharedLedgerImport)(c.db, { localProject: lp, projectId: c.binding.projectId,
      sourceInstanceId: credential.instanceId, featureIds, batchId, stateDir: c.dir, scrub, summaries: {} });
    pending.digest = payload.manifestDigest;
    bytes = autoShareRequestBytes(payload);
  } catch {
    const journal = readSharedLedgerImportRecord(sharedLedgerImportJournalPath(c.dir, batchId));
    if (journal && (journal.phase === "gating" || journal.phase === "prepared")) {
      await revokeBatch(c, pending, journal.payload?.manifestDigest ?? "", failed(c, featureIds, "prepare"), "prepare-failed");
    } else await record(c, (p) => { markFailed(c, p, featureIds, "prepare"); p.pending = null; audit(p, batchId, "prepare-failed"); });
    return { action: "batch" as const, batchId };
  }
  // The prepared body itself (not the plan's estimate) decides: over the limit it never leaves, as if the center refused its size.
  if (bytes > AUTO_SHARE_MAX_BATCH_BYTES) {
    await revokeBatch(c, pending, pending.digest, failed(c, featureIds, "size"), "too-large");
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
    await revokeBatch(c, pending, "", failed(c, pending.featureIds, "prepare"), "prepare-failed");
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
  const { results, ready, plan } = await checkAutoShareCandidates({ db: c.db, dir: c.dir, localProject: c.binding.localProjectId,
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
  return openBatch(c, selectAutoShareBatch(ready, plan), credential, results);
}

export const autoSharePassLockPath = (dir: string) => join(dir, "shared-ledger-auto-share.pass.lock");

/** One pass over every bound project whose switch is not off. A project's failure is recorded on it and never thrown. */
export async function runSharedLedgerAutoSharePass(deps: AutoShareDeps = {}): Promise<Record<string, AutoShareOutcome>> {
  const dir = deps.stateDir ?? STATE_DIR, now = (deps.now ?? Date.now)(), ledgerPath = deps.ledgerPath ?? join(dir, "ledger.sqlite");
  const out: Record<string, AutoShareOutcome> = {}, state = readAutoShareState(dir);
  const bound = readSharedLedgerBindings(dir).filter((b): b is Ctx["binding"] => validAutoShareId(b.localProjectId)
    && (state[b.localProjectId]?.mode ?? "off") !== "off");
  if (!bound.length || !existsSync(ledgerPath)) return out;
  const lockPath = autoSharePassLockPath(dir), held = deps.heldLock;
  // A child pass runs under its parent's lock (which keeps renewing it) and refuses one it no longer holds.
  if (held && (held.path !== lockPath || !lockOwnedBy(held.path, held.token))) return out;
  const lock = held ? { release() {} } : await acquireLock(lockPath, 0);
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
