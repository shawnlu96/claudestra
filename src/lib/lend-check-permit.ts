import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { observeLendCheckProcess, type CheckProcessObservation } from "./lend-check-observation.js";

const text = z.string().trim().min(1).max(1024);
const policySchema = z.object({
  mode: z.enum(["on", "observe", "off"]),
  max: z.number().int().positive().nullable(),
  approval: z.string().min(1).max(4096).nullable(),
}).strict();
const ownerSchema = z.object({ pid: z.number().int().positive(), start: text, incarnation: text }).strict();
const requestSchema = z.object({ id: text, orderId: text, workerId: text, cost: z.enum(["full", "focused"]) }).strict();
const entrySchema = requestSchema.extend({
  owner: ownerSchema, status: z.enum(["waiting", "active", "released", "cancelled", "exited"]),
}).strict();
const stateSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), policy: policySchema, entries: z.array(entrySchema) }).strict();
type State = z.infer<typeof stateSchema>;
type Entry = z.infer<typeof entrySchema>;
type Policy = z.infer<typeof policySchema>;
const incarnation = randomUUID();

export type LendCheckConfig = {
  mode?: "on" | "observe" | "off";
  // Data alone is not authority: the host-owned dependency must verify the exact limit and approval provenance.
  ownerApproval?: { maxConcurrentFullChecks: number; approvedBy: string; reference: string };
};
type LendCheckRequest = z.infer<typeof requestSchema>;
export type LendCheckResult = {
  // The execution decision; observe can return diagnostic status "blocked" while still allowing the check.
  allowed: boolean;
  mode: Policy["mode"];
  status: "granted" | "queued" | "observed" | "bypassed" | "released" | "cancelled" | "closed" | "blocked" | "busy" | "policy_conflict";
  retryable: boolean;
  reasonCode?: "store_busy" | "policy_conflict" | "approval_unverified" | "tree_unconfirmed" | "invalid_request" | "invalid_config" | "invalid_action" | "store_or_identity";
  reason?: string;
  position?: number;
  wouldWait?: boolean;
};
export type LendCheckInput = {
  // All workers on this host MUST share this directory, outside per-clone/per-order state. No implicit production default.
  directory: string;
  config?: LendCheckConfig;
  action: "acquire" | "release" | "cancel";
  // IDs identify individual check attempts; allocate a fresh ID for each rerun (same ID only polls that attempt).
  // Call from the check executor itself; it must supervise/reap its check tree. Descendants must not outlive this holder.
  // A short-lived broker or whole LLM worker is not a check executor. Its exit would not prove the check has stopped.
  request: LendCheckRequest;
};

type Dependencies = {
  // Trusted executor dependencies, never deserialized from worker requests. Verify against one host-wide owner policy.
  verifyOwnerApproval?: (approval: NonNullable<LendCheckConfig["ownerApproval"]>) => boolean;
  // "absent" certifies the entire supervised tree is sealed (cannot spawn again) and reaped, not just a PID missing.
  // Required for enforcement. Observe-only release trusts the executor when this dependency is absent.
  // Future wiring must use a durable supervisor/cgroup or equivalent; unknown evidence retains active slots.
  observeCheckTree?: (entry: Readonly<Entry>) => "absent" | "present" | "unknown";
};
class PermitError extends Error {
  constructor(readonly code: NonNullable<LendCheckResult["reasonCode"]>, message: string) { super(message); }
}

function policyOf(config: LendCheckConfig = {}, deps: Dependencies): Policy {
  const mode = config.mode ?? "observe";
  if (!["on", "observe", "off"].includes(mode)) throw new Error("invalid check mode");
  if (mode === "off") return { mode, max: null, approval: null };
  const approval = config.ownerApproval;
  if (!approval) return { mode: mode === "on" ? "observe" : mode, max: null, approval: null };
  const max = z.number().int().positive().safe().parse(approval.maxConcurrentFullChecks);
  const provenance = JSON.stringify([text.parse(approval.approvedBy), text.parse(approval.reference)]);
  if (deps.verifyOwnerApproval?.({ maxConcurrentFullChecks: max, approvedBy: approval.approvedBy, reference: approval.reference }) !== true) {
    throw new PermitError("approval_unverified", "owner approval was not verified by host authority");
  }
  if (mode === "on" && typeof deps.observeCheckTree !== "function") {
    throw new PermitError("tree_unconfirmed", "on mode requires a host check-tree observer before admission");
  }
  return { mode, max, approval: provenance };
}

function openStore(directory: string): Database {
  if (!directory) throw new Error("explicit permit directory required");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(realpathSync(directory), "lend-check-permit.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      const stat = lstatSync(path + suffix);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("permit store must be a regular, unaliased file");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;");
    return db;
  } catch (e) { db.close(); throw e; }
}

function pending(entry: Entry): boolean { return entry.status === "active" || entry.status === "waiting"; }
function sameOwner(a: Entry["owner"], b: Entry["owner"]): boolean {
  return a.pid === b.pid && a.start === b.start && a.incarnation === b.incarnation;
}

function initializeStore(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS check_permit (id INTEGER PRIMARY KEY CHECK (id=1), body TEXT NOT NULL)");
  const row = db.query("SELECT body FROM check_permit WHERE id=1").get() as { body: string } | null;
  const hasHistory = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='check_permit_closed'").get();
  // Recreating lost history would make terminal IDs reusable. Only a new or legacy store may initialize the table.
  if (row && JSON.parse(row.body).version === 2 && !hasHistory) throw new Error("terminal permit history is missing");
  db.exec("CREATE TABLE IF NOT EXISTS check_permit_closed (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
}

function loadState(db: Database, policy: Policy, id: string): State {
  const row = db.query("SELECT body FROM check_permit WHERE id=1").get() as { body: string } | null;
  const state = row ? stateSchema.parse(JSON.parse(row.body)) : { version: 1 as const, policy, entries: [] };
  if (new Set(state.entries.map((entry) => entry.id)).size !== state.entries.length) throw new Error("duplicate permit identities");
  if (state.entries.some((entry) => entry.cost !== "full")) throw new Error("invalid stored check cost");
  if (state.policy.mode === "on" && (state.policy.max === null || state.policy.approval === null)) throw new Error("invalid stored policy");
  // Durable indexed tombstones preserve exact identity/idempotency without reparsing all past checks on every call.
  const closed = db.query("SELECT body FROM check_permit_closed WHERE id=?").get(id) as { body: string } | null;
  if (closed) {
    const entry = entrySchema.parse(JSON.parse(closed.body));
    if (entry.id !== id || entry.cost !== "full" || pending(entry) || state.entries.some((item) => item.id === id)) throw new Error("invalid terminal permit");
    state.entries.push(entry);
  }
  return state;
}

type Sample = { entry: string; process: CheckProcessObservation; tree: "absent" | "present" | "unknown" };
function sample(state: State, probe: (pid: number) => CheckProcessObservation, deps: Dependencies): Map<string, Sample> {
  const processes = new Map<number, CheckProcessObservation>();
  const samples = new Map<string, Sample>();
  for (const entry of state.entries.filter(pending)) {
    let seen = processes.get(entry.owner.pid);
    if (!seen) { seen = probe(entry.owner.pid); processes.set(entry.owner.pid, seen); }
    const tree = entry.status === "active" ? deps.observeCheckTree?.(structuredClone(entry)) ?? "unknown" : "unknown";
    samples.set(entry.id, { entry: JSON.stringify(entry), process: seen, tree });
  }
  return samples;
}

function persist(db: Database, state: State): void {
  for (const entry of state.entries.filter((item) => !pending(item))) {
    const result = db.query(`INSERT INTO check_permit_closed (id,body) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE check_permit_closed.body=excluded.body`).run(entry.id, JSON.stringify(entry));
    if (result.changes !== 1) throw new Error("conflicting terminal permit identity");
  }
  // Old binaries must reject this representation instead of forgetting the separately stored terminal IDs.
  state.version = 2;
  state.entries = state.entries.filter(pending);
  db.query("INSERT INTO check_permit (id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(JSON.stringify(state));
}

function sweep(state: State, samples: Map<string, Sample>): void {
  for (const entry of state.entries.filter(pending)) {
    const sampled = samples.get(entry.id);
    // A concurrent admission/status change cannot inherit an older observation (especially waiting -> active).
    if (!sampled || sampled.entry !== JSON.stringify(entry)) continue;
    const seen = sampled.process;
    // Legacy Darwin boottime identities are incomparable to bootsessionuuid identities; retain them for explicit drain.
    const comparable = !entry.owner.start.startsWith("darwin:{");
    const dead = seen.kind === "absent" || (seen.kind === "present" && comparable &&
      seen.process.pid === entry.owner.pid && seen.process.start !== entry.owner.start);
    if (dead && (entry.status === "waiting" || sampled.tree === "absent")) entry.status = "exited";
  }
}

function apply(state: State, input: LendCheckInput, owner: Entry["owner"], policy: Policy, samples: Map<string, Sample>, deps: Dependencies): LendCheckResult {
  if (JSON.stringify(state.policy) !== JSON.stringify(policy)) {
    // Only a host-verified approval may replace an idle policy. Stale/unconfigured workers cannot downgrade it.
    if (state.entries.some(pending) || policy.approval === null) {
      throw new PermitError("policy_conflict", "host permit policy differs; drain existing attempts before applying a verified owner policy");
    }
    state.policy = policy;
  }
  const request = requestSchema.parse(input.request);
  let entry = state.entries.find((item) => item.id === request.id);
  if (entry && (!sameOwner(entry.owner, owner) || entry.orderId !== request.orderId || entry.workerId !== request.workerId || entry.cost !== request.cost)) {
    throw new Error("permit belongs to a different order, worker or process incarnation");
  }
  if (input.action !== "acquire") {
    if (!entry) throw new Error("unknown permit");
    if (!pending(entry)) return { retryable: false, allowed: false, mode: policy.mode, status: "closed" };
    if (input.action === "cancel" && entry.status === "active") throw new Error("active check must exit before release; cancel only withdraws queued requests");
    const sampled = samples.get(entry.id);
    const executorAttested = policy.mode === "observe" && !deps.observeCheckTree;
    if (entry.status === "active" && !executorAttested && (!sampled || sampled.entry !== JSON.stringify(entry) || sampled.tree !== "absent")) {
      throw new PermitError("tree_unconfirmed", "check tree exit has not been confirmed by the supervisor");
    }
    entry.status = input.action === "release" ? "released" : "cancelled";
    return { retryable: false, allowed: false, mode: policy.mode, status: entry.status };
  }
  if (entry && !pending(entry)) return { retryable: false, allowed: policy.mode === "observe", mode: policy.mode, status: "closed" };
  if (!entry) { entry = { ...request, owner, status: "waiting" }; state.entries.push(entry); }
  const active = state.entries.filter((item) => item.status === "active").length;
  const waiting = state.entries.filter((item) => item.status === "waiting");
  const position = waiting.indexOf(entry) + 1;
  const wouldWait = entry.status !== "active" && policy.max !== null && active + position > policy.max;
  if (policy.mode === "observe") {
    entry.status = "active";
    return { retryable: false, allowed: true, mode: policy.mode, status: "observed", wouldWait };
  }
  // Reserve capacity for earlier waiters even if a later worker polls first. No clock/mtime leases or queue jumping.
  if (entry.status === "active" || !wouldWait) {
    entry.status = "active";
    return { retryable: false, allowed: true, mode: policy.mode, status: "granted" };
  }
  return { retryable: false, allowed: false, mode: policy.mode, status: "queued", position, wouldWait: true };
}

// Sole lifecycle API: acquire (same ID polls), cancel (queued only), release (after the check tree has exited).
// Proposed command boundary: package.json scripts.check/test and .github/workflows/ci.yml's direct bun test/build commands.
// A host-owned loader must validate approval provenance/limit against its owner-approved record, never worker strings.
// Every executor uses the SAME directory/policy. After drain, acquire atomically installs a new host-verified approval.
// A supervisor acquires before spawning; observeCheckTree must prove sealed/reaped descendants even after executor SIGKILL.
// claudeWorkerPlan in lend-claude-worker.ts can propagate shared directory/config, but worker spawn is not a full check.

// No scripts, package.json or production paths are wired here. Policy denials must not retry or switch family.
export function lendCheckPermit(input: LendCheckInput, probe = observeLendCheckProcess, deps: Dependencies = {}): LendCheckResult {
  try { input = { ...input, request: requestSchema.parse(input.request) }; }
  catch { return { retryable: false, allowed: false, mode: "observe", status: "blocked", reasonCode: "invalid_request", reason: "invalid permit request" }; }
  let policy: Policy;
  try { policy = policyOf(input.config, deps); }
  catch (e) {
    const observing = input.config?.mode === undefined || input.config.mode === "observe";
    return { retryable: false, allowed: observing && input.action === "acquire", mode: observing ? "observe" : "on", status: "blocked",
      reasonCode: e instanceof PermitError ? e.code : "invalid_config", reason: "invalid or unverified permit configuration" };
  }
  if (!["acquire", "release", "cancel"].includes(input.action)) {
    return { retryable: false, allowed: false, mode: policy.mode, status: "blocked", reasonCode: "invalid_action", reason: "invalid action" };
  }
  if (policy.mode === "off" || input.request.cost === "focused") return { retryable: false, allowed: input.action === "acquire", mode: policy.mode, status: "bypassed" };
  let db: Database | undefined;
  let transaction = false;
  try {
    const self = probe(process.pid);
    if (self.kind !== "present" || self.process.pid !== process.pid || !self.process.start) throw new Error("own process start identity unavailable");
    db = openStore(input.directory);
    initializeStore(db);
    // Expensive OS/supervisor probes happen before the write lock; re-read state under lock and match sampled entries.
    const samples = sample(loadState(db, policy, input.request.id), probe, deps);
    // SQLite's canonical file lock serializes the entire RMW, survives process crashes, and has no stale-lock takeover.
    // FULL synchronous commit is the grant boundary: failed preservation never returns an enforced grant or removes state.
    db.exec("BEGIN IMMEDIATE"); transaction = true;
    const state = loadState(db, policy, input.request.id);
    sweep(state, samples);
    const result = apply(state, input, { ...self.process, incarnation }, policy, samples, deps);
    persist(db, state);
    db.exec("COMMIT"); transaction = false;
    return result;
  } catch (e) {
    // Observe never gates production on missing configuration, disk failure or diagnostic failure. On always fails closed.
    const code = (e as { code?: string })?.code;
    const busy = typeof code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code);
    const reasonCode = busy ? "store_busy" : e instanceof PermitError ? e.code : "store_or_identity";
    return { allowed: policy.mode === "observe" && input.action === "acquire", mode: policy.mode, retryable: busy,
      status: busy ? "busy" : reasonCode === "policy_conflict" ? "policy_conflict" : "blocked", reasonCode, reason: String(e) };
  } finally {
    if (db) {
      try { if (transaction) db.exec("ROLLBACK"); }
      catch (e) { console.warn("check permit rollback failed; preserve store for inspection", String(e)); }
      try { db.close(); }
      catch (e) { console.warn("check permit close failed; preserve store for inspection", String(e)); }
    }
  }
}
