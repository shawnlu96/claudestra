/**
 * Observation-only ownership proof. A match grants no kill, recovery or cross-owner authority.
 * Callers supply trusted creation records and two independent OS observations in one host/boot scope;
 * argv, paths and process-provided owner claims are never evidence. No collector or state writer lives here.
 * Existing ancestorPids/ancestorsIn stop silently on gaps/cycles and discard start identity, so their
 * PID-only contracts cannot prove ownership. This bounded walk must preserve those failure distinctions.
 */
interface OwnedProcessIdentity {
  readonly pid: number;
  readonly uid: number;
  /** Exact OS process-instance token, including boot identity; never a command or rounded start time. */
  readonly startId: string;
}

export interface OwnedProcessRecord extends OwnedProcessIdentity {
  readonly ppid: number;
  readonly pgid: number;
}

export interface ProcessSessionOwner {
  readonly sessionId: string;
  /** Positive safe integer assigned by the caller's session owner, not by a process claim. */
  readonly generation: number;
  readonly root: OwnedProcessIdentity;
}

export interface ProcessCreationRegistration {
  readonly owner: ProcessSessionOwner;
  /** Only records captured at creation qualify; discovering a current descendant is insufficient. */
  readonly kind: "created";
  readonly parent: OwnedProcessIdentity;
  /** Includes the group established at creation, including an explicitly detached group. */
  readonly child: OwnedProcessRecord;
}

type ProcessRegistrationEvidence =
  | { readonly status: "ok"; readonly entries: readonly ProcessCreationRegistration[] }
  | { readonly status: "unavailable" };

type SessionProcessObservation =
  | {
    readonly status: "ok";
    readonly owner: ProcessSessionOwner;
    /** Strictly increasing collector sequence, attesting to two separately acquired samples. */
    readonly sequence: number;
    readonly processes: readonly OwnedProcessRecord[];
  }
  | { readonly status: "unavailable" };

export interface SessionOwnedProcessInput {
  readonly owner: ProcessSessionOwner;
  readonly targetPid: number;
  readonly registrations: ProcessRegistrationEvidence;
  readonly observations: readonly [SessionProcessObservation, SessionProcessObservation];
}

type OwnershipReason =
  | "creation-confirmed" | "invalid-input" | "source-unavailable" | "invalid-evidence"
  | "evidence-limit" | "duplicate-pid" | "owner-mismatch" | "identity-mismatch"
  | "unregistered" | "process-missing" | "parent-missing" | "parent-mismatch"
  | "group-mismatch" | "observation-changed" | "observation-order" | "tree-cycle" | "depth-limit";

export interface SessionOwnedProcessResult {
  readonly status: "matched" | "mismatch" | "unknown";
  /** A single fixed code; no untrusted values, argv, paths or input objects escape via diagnostics. */
  readonly reason: OwnershipReason;
}

const MAX_ROWS = 4096;
const MAX_DEPTH = 64;

type RecordMap = Map<number, OwnedProcessRecord>;
type RegistrationMap = Map<number, ProcessCreationRegistration>;
type EvidenceMap<T> = { map: T } | { error: SessionOwnedProcessResult };

function unknown(reason: OwnershipReason): SessionOwnedProcessResult { return { status: "unknown", reason }; }
function mismatch(reason: OwnershipReason): SessionOwnedProcessResult { return { status: "mismatch", reason }; }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function pid(value: unknown, minimum = 1): value is number {
  return integer(value, minimum) && value <= 0x7fffffff;
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0;
}

function identity(value: unknown): value is OwnedProcessIdentity {
  return object(value) && pid(value.pid) && integer(value.uid, 0) && token(value.startId);
}

function processRecord(value: unknown): value is OwnedProcessRecord {
  return identity(value) && object(value) && pid(value.ppid, 0) && pid(value.pgid);
}

function owner(value: unknown): value is ProcessSessionOwner {
  return object(value) && token(value.sessionId) && integer(value.generation, 1)
    && identity(value.root) && value.root.pid > 1;
}

function sameIdentity(a: OwnedProcessIdentity, b: OwnedProcessIdentity): boolean {
  return a.pid === b.pid && a.uid === b.uid && a.startId === b.startId;
}

function sameOwner(a: ProcessSessionOwner, b: ProcessSessionOwner): boolean {
  return a.sessionId === b.sessionId && a.generation === b.generation && sameIdentity(a.root, b.root);
}

function sameRecord(a: OwnedProcessRecord, b: OwnedProcessRecord): boolean {
  return sameIdentity(a, b) && a.ppid === b.ppid && a.pgid === b.pgid;
}

function creationRegistration(value: unknown): value is ProcessCreationRegistration {
  return object(value) && value.kind === "created" && owner(value.owner)
    && identity(value.parent) && processRecord(value.child) && value.child.pid > 1 && value.parent.pid > 1;
}

function registrations(input: ProcessRegistrationEvidence, expected: ProcessSessionOwner): EvidenceMap<RegistrationMap> {
  if (!object(input) || input.status !== "ok") return { error: unknown("source-unavailable") };
  if (!Array.isArray(input.entries)) return { error: unknown("invalid-evidence") };
  if (input.entries.length > MAX_ROWS) return { error: unknown("evidence-limit") };
  const map: RegistrationMap = new Map();
  for (const entry of input.entries) {
    if (!creationRegistration(entry)) return { error: unknown("invalid-evidence") };
    if (map.has(entry.child.pid)) return { error: unknown("duplicate-pid") };
    if (!sameOwner(entry.owner, expected)) return { error: mismatch("owner-mismatch") };
    if (entry.parent.uid !== expected.root.uid || entry.child.uid !== expected.root.uid) {
      return { error: mismatch("identity-mismatch") };
    }
    if (entry.child.ppid !== entry.parent.pid) return { error: mismatch("parent-mismatch") };
    map.set(entry.child.pid, entry);
  }
  return { map };
}

function observation(input: SessionProcessObservation, expected: ProcessSessionOwner): EvidenceMap<RecordMap> {
  if (!object(input) || input.status !== "ok") return { error: unknown("source-unavailable") };
  if (!owner(input.owner) || !integer(input.sequence, 1) || !Array.isArray(input.processes)) {
    return { error: unknown("invalid-evidence") };
  }
  if (!sameOwner(input.owner, expected)) return { error: mismatch("owner-mismatch") };
  if (input.processes.length > MAX_ROWS) return { error: unknown("evidence-limit") };
  const map: RecordMap = new Map();
  for (const row of input.processes) {
    if (!processRecord(row)) return { error: unknown("invalid-evidence") };
    if (map.has(row.pid)) return { error: unknown("duplicate-pid") };
    map.set(row.pid, row);
  }
  return { map };
}

/** Check supplied graphs too: an exact child record must not hide contradictory cyclic evidence. */
function treeProblem(map: RecordMap): SessionOwnedProcessResult | null {
  for (const pid of map.keys()) {
    const seen = new Set<number>();
    let current = pid;
    for (let depth = 0; map.has(current); depth++) {
      if (seen.has(current)) return unknown("tree-cycle");
      if (depth >= MAX_DEPTH) return unknown("depth-limit");
      seen.add(current);
      current = map.get(current)!.ppid;
    }
  }
  return null;
}

function stableProcess(
  expected: OwnedProcessIdentity, first: RecordMap, second: RecordMap, missing: "process-missing" | "parent-missing",
): SessionOwnedProcessResult | null {
  const a = first.get(expected.pid), b = second.get(expected.pid);
  if (!a || !b) return unknown(missing);
  if (!sameIdentity(a, expected) || !sameIdentity(b, expected)) return mismatch("identity-mismatch");
  if (!sameRecord(a, b)) return unknown("observation-changed");
  return null;
}

function creationProblem(
  entry: ProcessCreationRegistration, first: RecordMap, second: RecordMap,
): SessionOwnedProcessResult | null {
  const childProblem = stableProcess(entry.child, first, second, "process-missing");
  if (childProblem) return childProblem;
  const current = second.get(entry.child.pid)!;
  // Reparenting or a later setsid is not historical creation evidence, even if both samples agree.
  if (current.ppid !== entry.parent.pid) return mismatch("parent-mismatch");
  if (current.pgid !== entry.child.pgid) return mismatch("group-mismatch");
  return stableProcess(entry.parent, first, second, "parent-missing");
}

function registeredChain(
  input: SessionOwnedProcessInput, entries: RegistrationMap, first: RecordMap, second: RecordMap,
): SessionOwnedProcessResult {
  const seen = new Set<number>();
  let pid = input.targetPid;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (seen.has(pid)) return unknown("tree-cycle");
    seen.add(pid);
    const entry = entries.get(pid);
    if (!entry) return unknown("unregistered");
    const problem = creationProblem(entry, first, second);
    if (problem) return problem;
    if (entry.parent.pid === input.owner.root.pid) {
      if (!sameIdentity(entry.parent, input.owner.root)) return mismatch("identity-mismatch");
      return { status: "matched", reason: "creation-confirmed" };
    }
    const parentEntry = entries.get(entry.parent.pid);
    if (!parentEntry) return unknown("unregistered");
    if (!sameIdentity(parentEntry.child, entry.parent)) return mismatch("identity-mismatch");
    pid = entry.parent.pid;
  }
  return unknown("depth-limit");
}

/**
 * Inputs are inert data, not accessors or collectors. Missing or conflicting evidence fails closed.
 * Registration ownership must come from the caller's trusted session resource owner, never argv.
 * Missing parents (including exited parents) remain unknown; this module cannot reconstruct history.
 * Each source is capped at 4096 rows, and each parent walk at 64 records.
 */
export function matchSessionOwnedProcess(input: SessionOwnedProcessInput): SessionOwnedProcessResult {
  if (!object(input) || !owner(input.owner) || !pid(input.targetPid, 2)
    || !Array.isArray(input.observations) || input.observations.length !== 2) return unknown("invalid-input");
  if (input.targetPid === input.owner.root.pid) return mismatch("parent-mismatch");
  const entries = registrations(input.registrations, input.owner);
  if ("error" in entries) return entries.error;
  const [a, b] = input.observations;
  const first = observation(a, input.owner), second = observation(b, input.owner);
  if ("error" in first) return first.error;
  if ("error" in second) return second.error;
  if (a.status !== "ok" || b.status !== "ok" || a.sequence >= b.sequence) return unknown("observation-order");
  const recorded = new Map([...entries.map].map(([pid, entry]) => [pid, entry.child]));
  for (const map of [recorded, first.map, second.map]) {
    const problem = treeProblem(map);
    if (problem) return problem;
  }
  const rootProblem = stableProcess(input.owner.root, first.map, second.map, "parent-missing");
  if (rootProblem) return rootProblem;
  return registeredChain(input, entries.map, first.map, second.map);
}
