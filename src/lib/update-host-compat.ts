import type { AcpTurn } from "./acp-turn-gate.js";

interface UpdateHostIdentity {
  readonly agent: string;
  readonly sessionId: string;
  readonly hostGeneration: string;
}

interface EvidenceScope {
  readonly identity: UpdateHostIdentity;
  readonly observedAt: number;
  /** Caller-owned validity policy; this module introduces no timeout or version exception. */
  readonly validUntil: number;
}

/** Normalized, verified facts, not raw wire replies. Missing fields/errors/old SHAs prove nothing.
 * The caller must authenticate the host and bind each fact to the same session and host generation.
 * Adapter initialize capabilities do not describe the host's bridge `turn` operation.
 */
export type UpdateHostEvidence = EvidenceScope & (
  | { readonly kind: "capability"; readonly source: "host-declaration"; readonly value: "supported" | "unsupported" | "unknown" }
  | { readonly kind: "capability"; readonly source: "structured-rejection"; readonly value: "unsupported" }
  | { readonly kind: "turn"; readonly source: "turn-query" | "verified-session-state"; readonly value: AcpTurn }
  | { readonly kind: "session"; readonly value: "preserved" | "unpreserved" | "unknown" }
  | { readonly kind: "orders"; readonly value: "none" | "active" | "unknown" }
  | { readonly kind: "read"; readonly value: "failed" }
);

export interface UpdateHostCompatInput {
  readonly mode?: "on" | "observe" | "off";
  readonly identity: UpdateHostIdentity;
  readonly now: number;
  readonly evidence: readonly UpdateHostEvidence[];
}

type Compatibility = "supported" | "unsupported" | "unknown";
type Reason = "disabled" | "invalid-input" | "identity-mismatch" | "stale-evidence" | "conflicting-evidence"
  | "read-failed" | "busy" | "active-orders" | "capability-unknown" | "turn-unknown" | "session-unpreserved"
  | "orders-unknown" | "compatible-idle" | "legacy-recovery-needs-owner";
type Advice = "none" | "refresh-evidence" | "wait-for-idle" | "wait-for-orders" | "preserve-session"
  | "use-existing-gate" | "request-owner-controlled-restart";

export interface UpdateHostCompatDecision {
  readonly mode: "on" | "observe" | "off";
  readonly status: "disabled" | "blocked" | "compatible" | "recovery-plan";
  readonly compatibility: Compatibility;
  readonly reason: Reason;
  readonly advice: Advice;
  /** Even on-mode is diagnostic only. Neither this result nor unsupported authorizes an upgrade. */
  readonly gate: "unchanged";
  readonly executable: false;
  readonly recovery: null | {
    readonly action: "controlled-host-restart";
    readonly requires: readonly ["owner-approval", "existing-control-path", "revalidate-evidence"];
  };
}

type Rec = Record<string, unknown>;
const record = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);
const token = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function identity(value: unknown): value is UpdateHostIdentity {
  return record(value) && token(value.agent) && token(value.sessionId) && token(value.hostGeneration);
}

function sameIdentity(a: UpdateHostIdentity, b: UpdateHostIdentity): boolean {
  return a.agent === b.agent && a.sessionId === b.sessionId && a.hostGeneration === b.hostGeneration;
}

function fact(value: unknown): value is UpdateHostEvidence {
  if (!record(value) || !identity(value.identity) || !time(value.observedAt) || !time(value.validUntil)) return false;
  switch (value.kind) {
    case "capability":
      return value.source === "host-declaration" && ["supported", "unsupported", "unknown"].includes(value.value as string)
        || value.source === "structured-rejection" && value.value === "unsupported";
    case "turn":
      return ["turn-query", "verified-session-state"].includes(value.source as string) && ["busy", "idle", "unknown"].includes(value.value as string);
    case "session": return ["preserved", "unpreserved", "unknown"].includes(value.value as string);
    case "orders": return ["none", "active", "unknown"].includes(value.value as string);
    case "read": return value.value === "failed";
    default: return false;
  }
}

function decision(mode: UpdateHostCompatDecision["mode"], reason: Reason, compatibility: Compatibility = "unknown"): UpdateHostCompatDecision {
  let status: UpdateHostCompatDecision["status"] = "blocked";
  let advice: Advice = "refresh-evidence";
  let recovery: UpdateHostCompatDecision["recovery"] = null;
  switch (reason) {
    case "disabled": status = "disabled"; advice = "none"; break;
    case "busy": advice = "wait-for-idle"; break;
    case "active-orders": advice = "wait-for-orders"; break;
    case "session-unpreserved": advice = "preserve-session"; break;
    case "compatible-idle": status = "compatible"; advice = "use-existing-gate"; break;
    case "legacy-recovery-needs-owner":
      status = "recovery-plan";
      advice = "request-owner-controlled-restart";
      recovery = { action: "controlled-host-restart", requires: ["owner-approval", "existing-control-path", "revalidate-evidence"] };
  }
  return { mode, status, compatibility, reason, advice, gate: "unchanged", executable: false, recovery };
}

/** Pure per-host diagnosis. Repeated calls/identical facts are idempotent; no clock, state, I/O or actions.
 * Fact count and identifiers are bounded for runtime inputs. All outputs are fixed vocabulary; no identities,
 * raw errors, argv or paths escape. A future controller must revalidate and obtain owner authorization.
 */
export function diagnoseUpdateHostCompat(input: UpdateHostCompatInput): UpdateHostCompatDecision {
  if (!record(input)) return decision("observe", "invalid-input");
  const mode = input.mode === undefined ? "observe" : input.mode;
  if (mode !== "on" && mode !== "observe" && mode !== "off") return decision("observe", "invalid-input");
  if (mode === "off") return decision(mode, "disabled");
  if (!identity(input.identity) || !time(input.now) || !Array.isArray(input.evidence) || input.evidence.length > 32) return decision(mode, "invalid-input");
  // Validate by iteration, not Array.every: sparse arrays must not silently omit unknown evidence.
  for (const item of input.evidence) if (!fact(item)) return decision(mode, "invalid-input");
  const evidence = input.evidence;
  if (evidence.some((e) => !sameIdentity(e.identity, input.identity))) return decision(mode, "identity-mismatch");
  if (evidence.some((e) => e.observedAt > input.now || e.validUntil <= input.now || e.validUntil <= e.observedAt)) return decision(mode, "stale-evidence");
  const values = new Map<UpdateHostEvidence["kind"], string>();
  for (const e of evidence) {
    if (values.has(e.kind) && values.get(e.kind) !== e.value) return decision(mode, "conflicting-evidence");
    values.set(e.kind, e.value);
  }
  const capability = values.get("capability");
  const compatibility: Compatibility = capability === "supported" || capability === "unsupported" ? capability : "unknown";
  // A successful turn reply and an explicit rejection of that operation cannot both describe this host.
  if (compatibility === "unsupported" && evidence.some((e) => e.kind === "turn" && e.source === "turn-query" && e.value !== "unknown")) {
    return decision(mode, "conflicting-evidence");
  }
  if (values.has("read")) return decision(mode, "read-failed", compatibility);
  if (values.get("turn") === "busy") return decision(mode, "busy", compatibility);
  if (values.get("orders") === "active") return decision(mode, "active-orders", compatibility);
  if (compatibility === "unknown") return decision(mode, "capability-unknown");
  if (values.get("turn") !== "idle") return decision(mode, "turn-unknown", compatibility);
  if (values.get("session") !== "preserved") return decision(mode, "session-unpreserved", compatibility);
  if (values.get("orders") !== "none") return decision(mode, "orders-unknown", compatibility);
  return decision(mode, compatibility === "supported" ? "compatible-idle" : "legacy-recovery-needs-owner", compatibility);
}
