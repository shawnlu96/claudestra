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
const stateSchema = z.object({ version: z.literal(1), policy: policySchema, entries: z.array(entrySchema) }).strict();
type State = z.infer<typeof stateSchema>;
type Entry = z.infer<typeof entrySchema>;
type Policy = z.infer<typeof policySchema>;
const incarnation = randomUUID();

export type LendCheckConfig = {
  mode?: "on" | "observe" | "off";
  // Trusted owner configuration only. Approval provenance must be checked by the future configuration loader.
  ownerApproval?: { maxConcurrentFullChecks: number; approvedBy: string; reference: string };
};
type LendCheckRequest = z.infer<typeof requestSchema>;
export type LendCheckResult = {
  // The execution decision; observe can return diagnostic status "blocked" while still allowing the check.
  allowed: boolean;
  mode: Policy["mode"];
  status: "granted" | "queued" | "observed" | "bypassed" | "released" | "cancelled" | "closed" | "blocked";
  reason?: string;
  position?: number;
  wouldWait?: boolean;
};
export type LendCheckInput = {
  // All workers on this host MUST share this directory, outside per-clone/per-order state. No implicit production default.
  directory: string;
  config?: LendCheckConfig;
  action: "acquire" | "release" | "cancel";
  // Call from the check executor itself; it must supervise/reap its check tree. Descendants must not outlive this holder.
  // A short-lived broker or whole LLM worker is not a check executor. Its exit would not prove the check has stopped.
  request: LendCheckRequest;
};

function policyOf(config: LendCheckConfig = {}): Policy {
  const mode = config.mode ?? "observe";
  if (!["on", "observe", "off"].includes(mode)) throw new Error("invalid check mode");
  if (mode === "off") return { mode, max: null, approval: null };
  const approval = config.ownerApproval;
  if (!approval) return { mode: mode === "on" ? "observe" : mode, max: null, approval: null };
  const max = z.number().int().positive().safe().parse(approval.maxConcurrentFullChecks);
  const provenance = JSON.stringify([text.parse(approval.approvedBy), text.parse(approval.reference)]);
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

function loadState(db: Database, policy: Policy): State {
  db.exec("CREATE TABLE IF NOT EXISTS check_permit (id INTEGER PRIMARY KEY CHECK (id=1), body TEXT NOT NULL)");
  const row = db.query("SELECT body FROM check_permit WHERE id=1").get() as { body: string } | null;
  const state = row ? stateSchema.parse(JSON.parse(row.body)) : { version: 1 as const, policy, entries: [] };
  if (new Set(state.entries.map((entry) => entry.id)).size !== state.entries.length) throw new Error("duplicate permit identities");
  if (state.entries.some((entry) => entry.cost !== "full")) throw new Error("invalid stored check cost");
  if (state.policy.mode === "on" && (state.policy.max === null || state.policy.approval === null)) throw new Error("invalid stored policy");
  return state;
}

function sweep(state: State, probe: (pid: number) => CheckProcessObservation): void {
  const observations = new Map<number, CheckProcessObservation>();
  for (const entry of state.entries.filter(pending)) {
    let seen = observations.get(entry.owner.pid);
    if (!seen) { seen = probe(entry.owner.pid); observations.set(entry.owner.pid, seen); }
    if (seen.kind === "absent" || (seen.kind === "present" && seen.process.pid === entry.owner.pid && seen.process.start !== entry.owner.start)) {
      entry.status = "exited";
    }
  }
}

function apply(state: State, input: LendCheckInput, owner: Entry["owner"], policy: Policy): LendCheckResult {
  if (JSON.stringify(state.policy) !== JSON.stringify(policy)) {
    if (state.entries.some(pending)) throw new Error("permit policy differs while checks are pending");
    state.policy = policy;
  }
  const request = requestSchema.parse(input.request);
  let entry = state.entries.find((item) => item.id === request.id);
  if (entry && (!sameOwner(entry.owner, owner) || entry.orderId !== request.orderId || entry.workerId !== request.workerId || entry.cost !== request.cost)) {
    throw new Error("permit belongs to a different order, worker or process incarnation");
  }
  if (input.action !== "acquire") {
    if (!entry) throw new Error("unknown permit");
    if (!pending(entry)) return { allowed: false, mode: policy.mode, status: "closed" };
    if (input.action === "cancel" && entry.status === "active") throw new Error("active check must exit before release; cancel only withdraws queued requests");
    entry.status = input.action === "release" ? "released" : "cancelled";
    return { allowed: false, mode: policy.mode, status: entry.status };
  }
  if (entry && !pending(entry)) return { allowed: false, mode: policy.mode, status: "closed" };
  if (!entry) { entry = { ...request, owner, status: "waiting" }; state.entries.push(entry); }
  const active = state.entries.filter((item) => item.status === "active").length;
  const waiting = state.entries.filter((item) => item.status === "waiting");
  const position = waiting.indexOf(entry) + 1;
  const wouldWait = entry.status !== "active" && policy.max !== null && active + position > policy.max;
  if (policy.mode === "observe") {
    entry.status = "active";
    return { allowed: true, mode: policy.mode, status: "observed", wouldWait };
  }
  // Reserve capacity for earlier waiters even if a later worker polls first. No clock/mtime leases or queue jumping.
  if (entry.status === "active" || !wouldWait) {
    entry.status = "active";
    return { allowed: true, mode: policy.mode, status: "granted" };
  }
  return { allowed: false, mode: policy.mode, status: "queued", position, wouldWait: true };
}

// Sole lifecycle API: acquire (same ID polls), cancel (queued only), release (after the check tree has exited).
// Proposed command boundary: package.json scripts.check/test and .github/workflows/ci.yml's direct bun test/build commands.
// A future supervised check executor acquires before spawning, releases only after confirmed child-tree exit.
// claudeWorkerPlan in lend-claude-worker.ts can propagate shared directory/config, but worker spawn is not a full check.
// No scripts, package.json or production paths are wired here. Policy denials must not retry or switch family.
export function lendCheckPermit(input: LendCheckInput, probe = observeLendCheckProcess): LendCheckResult {
  try { requestSchema.parse(input.request); }
  catch { return { allowed: false, mode: "observe", status: "blocked", reason: "invalid permit request" }; }
  let policy: Policy;
  try { policy = policyOf(input.config); }
  catch {
    const observing = input.config?.mode === undefined || input.config.mode === "observe";
    return { allowed: observing && input.action === "acquire", mode: observing ? "observe" : "on", status: "blocked", reason: "invalid permit configuration" };
  }
  if (!["acquire", "release", "cancel"].includes(input.action)) return { allowed: false, mode: policy.mode, status: "blocked", reason: "invalid action" };
  if (policy.mode === "off" || input.request.cost === "focused") return { allowed: input.action === "acquire", mode: policy.mode, status: "bypassed" };
  let db: Database | undefined;
  let transaction = false;
  try {
    const self = probe(process.pid);
    if (self.kind !== "present" || self.process.pid !== process.pid || !self.process.start) throw new Error("own process start identity unavailable");
    db = openStore(input.directory);
    // SQLite's canonical file lock serializes the entire RMW, survives process crashes, and has no stale-lock takeover.
    // FULL synchronous commit is the grant boundary: failed preservation never returns an enforced grant or removes state.
    db.exec("BEGIN IMMEDIATE"); transaction = true;
    const state = loadState(db, policy);
    sweep(state, probe);
    const result = apply(state, input, { ...self.process, incarnation }, policy);
    db.query("INSERT INTO check_permit (id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(JSON.stringify(state));
    db.exec("COMMIT"); transaction = false;
    return result;
  } catch (e) {
    // Observe never gates production on missing configuration, disk failure or diagnostic failure. On always fails closed.
    return { allowed: policy.mode === "observe" && input.action === "acquire", mode: policy.mode, status: "blocked", reason: String(e) };
  } finally {
    if (db) {
      try { if (transaction) db.exec("ROLLBACK"); }
      catch (e) { console.warn("check permit rollback failed; preserve store for inspection", String(e)); }
      try { db.close(); }
      catch (e) { console.warn("check permit close failed; preserve store for inspection", String(e)); }
    }
  }
}
