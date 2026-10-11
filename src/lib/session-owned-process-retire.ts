/**
 * What a card worker session may hand to retirement when it ends or restarts: only children it registered at creation, proven by
 * session-owned-process.ts on fresh samples. This module selects and guards; it sends no signal, removes nothing and reads no host
 * state. Samples, creation records, evidence saving and the retire step itself are injected ports — the retire port is LIFE1's entry.
 * Order: session guard → records of this session/generation → two samples → save evidence → third sample → retire port.
 * Anything unclear (user session, unknown history, coarse start identity, mixed records, failed save) is reported, never handed over.
 * tests/session-owned-process-retire.test.ts
 */
import type { AgentFacts, PlanInput } from "./agent-lifecycle.js";
import {
  matchSessionOwnedProcess, type OwnedProcessRecord, type ProcessCreationRegistration, type ProcessSessionOwner,
} from "./session-owned-process.js";

/** Absent or unrecognised = observe / off: only the literal "on" ever reaches the save and retire ports. */
type RetireMode = "on" | "observe" | "off";

/**
 * How a source derived startId. Only a boot identity joined with the kernel's exact start value identifies a process instance;
 * `ps lstart` is second-precision and locale-formatted, so a pid reused within a second would compare equal.
 */
type StartIdSource = "boot+kernel-start" | "ps-lstart" | "unknown";

export type RegistrationSource =
  | { readonly status: "ok"; readonly startIdSource: StartIdSource; readonly entries: readonly ProcessCreationRegistration[] }
  | { readonly status: "unavailable" };

export type ObservationSource =
  | {
    readonly status: "ok"; readonly startIdSource: StartIdSource; readonly owner: ProcessSessionOwner;
    readonly sequence: number; readonly processes: readonly OwnedProcessRecord[];
  }
  | { readonly status: "unavailable" };

/** The same facts LIFE1 plans from (lifecycleSnapshot inputs); `index` is cardWorkerIndex(db). */
export type SessionRetireFacts = Pick<PlanInput, "index" | "cards" | "pms" | "foreign" | "master">;

export interface SessionRetireInput {
  readonly mode?: RetireMode;
  readonly trigger: "end" | "restart";
  /** The session being ended; on a restart, the generation being replaced. */
  readonly agent: Pick<AgentFacts, "name" | "kind" | "role" | "sessionId">;
  readonly owner: ProcessSessionOwner;
  readonly facts: SessionRetireFacts;
}

export interface RetireTarget {
  readonly agent: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly trigger: "end" | "restart";
  /** The exact instance proven on the last two samples; the executor must act on this identity, never on the pid alone. */
  readonly process: OwnedProcessRecord;
  readonly evidenceRef: string;
}

export interface RetireEvidence {
  readonly agent: string;
  readonly owner: ProcessSessionOwner;
  readonly trigger: "end" | "restart";
  readonly registrations: readonly ProcessCreationRegistration[];
  readonly observations: readonly [ObservationSource, ObservationSource];
  readonly decisions: readonly ProcessDecision[];
}

export interface SessionRetirePorts {
  /** Creation-time records from the session owner's trusted store; never discovered descendants. */
  registrations(): Promise<RegistrationSource>;
  /** One fresh sample per call, with a strictly increasing sequence. */
  observe(): Promise<ObservationSource>;
  /** Saves the session and this evidence; anything but ok:true stops before the retire port. */
  preserve(evidence: RetireEvidence): Promise<{ ok: true; ref: string } | { ok: false }>;
  /** LIFE1's retire entry. The only path by which a process is ever stopped; this module has no other exit. */
  retire(target: RetireTarget): Promise<"retired" | "gone" | "refused">;
}

type SessionReason =
  | "invalid-input" | "protected-agent" | "foreign-owner" | "user-session" | "unknown-history" | "session-conflict"
  | "card-unknown" | "frozen-card";
type RunReason =
  | SessionReason | "mode-off" | "registrations-unavailable" | "start-id-unreliable" | "nothing-registered" | "nothing-proven"
  | "observe-only" | "preserve-failed" | "retire-incomplete" | "handed-over";
type ProcessReason =
  | ReturnType<typeof matchSessionOwnedProcess>["reason"]
  | "start-id-unreliable" | "conflicting-registration" | "would-retire" | "preserve-failed" | "not-attempted"
  | "retired" | "gone" | "refused" | "retire-error";

interface ProcessDecision {
  readonly pid: number;
  readonly decision: "retire" | "report";
  /** Fixed codes only: no argv, path or process-supplied text leaves through a report. */
  readonly reason: ProcessReason;
}

export interface SessionRetireReport {
  readonly mode: RetireMode;
  readonly outcome: "off" | "report-only" | "observed" | "refused" | "retired";
  readonly reason: RunReason;
  readonly processes: readonly ProcessDecision[];
  /** Records of another session or generation, set aside before matching. */
  readonly staleRegistrations: number;
  /** Calls made to the retire port. */
  readonly handedOver: number;
}

const report = (mode: RetireMode, outcome: SessionRetireReport["outcome"], reason: RunReason, processes: readonly ProcessDecision[] = [],
  staleRegistrations = 0, handedOver = 0): SessionRetireReport => ({ mode, outcome, reason, processes, staleRegistrations, handedOver });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Why this session's children are only reported. Mirrors LIFE1's guards from the same facts: an agent no record links to this very
 * session is the user's or of unknown history; master / PM / main / lend workers and frozen or unreadable cards are never touched.
 */
function sessionProblem(input: SessionRetireInput): SessionReason | null {
  const { agent, owner, facts } = input;
  if (!isObject(agent) || !isObject(owner) || !isObject(facts) || typeof agent.name !== "string" || !agent.name
    || typeof agent.sessionId !== "string" || !agent.sessionId || owner.sessionId !== agent.sessionId
    || (input.trigger !== "end" && input.trigger !== "restart")) return "invalid-input";
  if (agent.kind === "main" || agent.role === "pm" || agent.role === "dispatcher" || facts.pms.has(agent.name) || facts.master.has(agent.name)) {
    return "protected-agent";
  }
  if (facts.foreign.has(agent.name)) return "foreign-owner";
  const worker = facts.index.get(agent.name);
  if (!worker) return "user-session";
  const sessions = worker.links.filter((l) => l.sessionId !== undefined);
  if (!sessions.some((l) => l.sessionId === agent.sessionId)) return "unknown-history";
  if (sessions.some((l) => l.sessionId !== agent.sessionId)) return "session-conflict";
  for (const link of worker.links) {
    const card = link.taskId === null ? undefined : facts.cards.find((c) => c.id === link.taskId);
    if (!card || card.extraError) return "card-unknown";
    if (card.frozen) return "frozen-card";
  }
  return null;
}

interface Scoped { kept: ProcessCreationRegistration[]; stale: number; conflicting: Set<number> }

/**
 * Sets aside records that name another session or generation: they are plainly not this retire's and must not poison the match.
 * A pid they share with a kept record is contradictory creation evidence and is refused, with all its registered descendants. Records of this session/generation with
 * another root, and malformed ones, stay in so the matcher refuses the whole set.
 */
function scopeRegistrations(entries: readonly ProcessCreationRegistration[], owner: ProcessSessionOwner): Scoped {
  const kept: ProcessCreationRegistration[] = [], stalePids = new Set<number>();
  let stale = 0;
  for (const entry of entries) {
    const o: unknown = isObject(entry) ? entry.owner : null;
    const foreign = isObject(o) && typeof o.sessionId === "string" && typeof o.generation === "number"
      && (o.sessionId !== owner.sessionId || o.generation !== owner.generation);
    if (!foreign) { kept.push(entry); continue; }
    stale++;
    const child: unknown = entry.child;
    if (isObject(child) && typeof child.pid === "number") stalePids.add(child.pid);
  }
  const conflicting = new Set<number>();
  for (const entry of kept) if (isObject(entry) && isObject(entry.child) && stalePids.has(entry.child.pid)) conflicting.add(entry.child.pid);
  // A refused parent cannot prove its children: everything registered beneath a contradictory pid is refused with it.
  for (let grew = conflicting.size > 0; grew;) {
    grew = false;
    for (const entry of kept) {
      if (!isObject(entry) || !isObject(entry.child) || !isObject(entry.parent)) continue;
      if (conflicting.has(entry.parent.pid) && !conflicting.has(entry.child.pid)) { conflicting.add(entry.child.pid); grew = true; }
    }
  }
  return { kept, stale, conflicting };
}

const reliable = (s: RegistrationSource | ObservationSource): boolean => s.status !== "ok" || s.startIdSource === "boot+kernel-start";

/** Depth of each registered child under the root, so leaves are handed over before the parents that prove them. */
function depths(entries: readonly ProcessCreationRegistration[]): Map<number, number> {
  const parentOf = new Map<number, number>();
  for (const e of entries) if (isObject(e) && isObject(e.child) && isObject(e.parent)) parentOf.set(e.child.pid, e.parent.pid);
  const out = new Map<number, number>();
  for (const pid of parentOf.keys()) {
    let depth = 0;
    for (let at = pid; parentOf.has(at) && depth <= parentOf.size; at = parentOf.get(at)!) depth++;
    out.set(pid, depth);
  }
  return out;
}

function decide(owner: ProcessSessionOwner, scoped: Scoped, pair: readonly [ObservationSource, ObservationSource]): ProcessDecision[] {
  const order = depths(scoped.kept);
  const pids = [...order.keys()].sort((a, b) => order.get(b)! - order.get(a)! || a - b);
  const strip = (s: ObservationSource) => (s.status === "ok" ? { status: s.status, owner: s.owner, sequence: s.sequence, processes: s.processes } : s);
  return pids.map((pid): ProcessDecision => {
    if (scoped.conflicting.has(pid)) return { pid, decision: "report", reason: "conflicting-registration" };
    if (!reliable(pair[0]) || !reliable(pair[1])) return { pid, decision: "report", reason: "start-id-unreliable" };
    const r = matchSessionOwnedProcess({ owner, targetPid: pid, registrations: { status: "ok", entries: scoped.kept },
      observations: [strip(pair[0]), strip(pair[1])] });
    return r.status === "matched" ? { pid, decision: "retire", reason: r.reason } : { pid, decision: "report", reason: r.reason };
  });
}

/** A port that throws is the same as one that could not answer: nothing is known, so nothing is handed over. */
async function sample(ports: SessionRetirePorts): Promise<ObservationSource> {
  try {
    const s = await ports.observe();
    return isObject(s) && s.status === "ok" ? s : { status: "unavailable" };
  } catch { return { status: "unavailable" }; /* collector failure is reported as source-unavailable on every process */ }
}

/** Hands the still-proven processes to the retire port, leaves first; the first error or refusal ends the run. */
async function handOver(input: SessionRetireInput, ports: SessionRetirePorts, decisions: ProcessDecision[], last: ObservationSource,
  ref: string): Promise<{ processes: ProcessDecision[]; calls: number }> {
  const observed = new Map((last.status === "ok" ? last.processes : []).map((p) => [p.pid, p]));
  const processes: ProcessDecision[] = [];
  let calls = 0, stopped = false;
  for (const d of decisions) {
    const process = observed.get(d.pid);
    if (d.decision !== "retire" || !process) { processes.push(d); continue; }
    if (stopped) { processes.push({ pid: d.pid, decision: "report", reason: "not-attempted" }); continue; }
    calls++;
    let reason: ProcessReason;
    try {
      const r = await ports.retire({ agent: input.agent.name, sessionId: input.owner.sessionId, generation: input.owner.generation,
        trigger: input.trigger, process: { ...process }, evidenceRef: ref });
      reason = r === "retired" || r === "gone" ? r : "refused";
    } catch { reason = "retire-error"; /* the entry's own failure is its to log; here it only stops the run */ }
    stopped = reason !== "retired" && reason !== "gone";
    processes.push({ pid: d.pid, decision: stopped ? "report" : "retire", reason });
  }
  return { processes, calls };
}

/**
 * Reports every registered child of the ending session and, in mode "on" only, hands the proven ones to the retire port after the
 * evidence is saved. Safe to repeat: a process already gone is `process-missing` and is not handed over again.
 */
export async function retireSessionOwnedProcesses(input: SessionRetireInput, ports: SessionRetirePorts): Promise<SessionRetireReport> {
  const mode: RetireMode = input?.mode === "on" ? "on" : input?.mode === undefined || input.mode === "observe" ? "observe" : "off";
  if (mode === "off") return report(mode, "off", "mode-off");
  const problem = isObject(input) ? sessionProblem(input) : "invalid-input";
  if (problem) return report(mode, "report-only", problem);
  let source: RegistrationSource;
  try { source = await ports.registrations(); } catch { source = { status: "unavailable" }; /* reported as registrations-unavailable */ }
  if (!isObject(source) || source.status !== "ok" || !Array.isArray(source.entries)) return report(mode, "refused", "registrations-unavailable");
  const scoped = scopeRegistrations(source.entries, input.owner);
  if (!reliable(source)) return report(mode, "refused", "start-id-unreliable", [], scoped.stale);
  if (scoped.kept.length === 0) return report(mode, "observed", "nothing-registered", [], scoped.stale);
  const first = await sample(ports), second = await sample(ports);
  const decisions = decide(input.owner, scoped, [first, second]);
  const wanted = decisions.filter((d) => d.decision === "retire");
  if (wanted.length === 0) return report(mode, "observed", "nothing-proven", decisions, scoped.stale);
  if (mode !== "on") {
    return report(mode, "observed", "observe-only", decisions.map((d) => (d.decision === "retire" ? { ...d, reason: "would-retire" } : d)), scoped.stale);
  }
  const held = (reason: ProcessReason) => decisions.map((d): ProcessDecision => (d.decision === "retire" ? { pid: d.pid, decision: "report", reason } : d));
  let saved: Awaited<ReturnType<SessionRetirePorts["preserve"]>>;
  try {
    saved = await ports.preserve({ agent: input.agent.name, owner: input.owner, trigger: input.trigger, registrations: scoped.kept,
      observations: [first, second], decisions });
  } catch { saved = { ok: false }; /* a save that threw did not save: reported as preserve-failed */ }
  if (!isObject(saved) || saved.ok !== true || typeof saved.ref !== "string" || !saved.ref) {
    return report(mode, "refused", "preserve-failed", held("preserve-failed"), scoped.stale);
  }
  // The save took time: prove each process again on a sample taken after it, so the hand-over is not older than the save.
  const third = await sample(ports);
  const fresh = new Map(decide(input.owner, scoped, [second, third]).map((d) => [d.pid, d]));
  const final = decisions.map((d) => (d.decision === "retire" ? fresh.get(d.pid) ?? d : d));
  if (!final.some((d) => d.decision === "retire")) return report(mode, "observed", "nothing-proven", final, scoped.stale);
  const done = await handOver(input, ports, final, third, saved.ref);
  const complete = done.processes.every((d) => d.decision === "report" || d.reason === "retired" || d.reason === "gone")
    && !done.processes.some((d) => d.reason === "refused" || d.reason === "retire-error" || d.reason === "not-attempted");
  return report(mode, complete ? "retired" : "refused", complete ? "handed-over" : "retire-incomplete", done.processes, scoped.stale, done.calls);
}
