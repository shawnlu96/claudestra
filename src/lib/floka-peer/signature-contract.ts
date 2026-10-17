/** SIGCOMP1: a signature veto never grants entry authority or starts a second send. */
import { recordObserved, recoveryPolicy, type RecoveryMode } from "../recovery-policy.js";
import { openLedger } from "../ledger-store.js";
import type { PeerSigVerdict } from "../peer-trust.js";
import { LogThrottle } from "../log-throttle.js";
import { observePeer, type Mode } from "./policy.js";

type Family = "none" | "claudestra" | "floka" | "mixed";
interface ContractInput {
  family: Family;
  result: string;
  signatureMode: Mode;
  /** The original peer-trust verdict, including its anchor and unchanged deadline (or the caller's outer gate). */
  legacy: PeerSigVerdict;
}

export function signatureFamily(h: { present: boolean; newFamily: boolean; oldFamily?: boolean }): Family {
  return !h.present ? "none" : h.newFamily ? h.oldFamily ? "mixed" : "floka" : "claudestra";
}

/** Matrix: unsigned/valid defer to trust; invalid new/mixed always veto; old off/observe defer to trust. */
export function signatureContractVerdict(input: ContractInput): PeerSigVerdict {
  const { family, result, signatureMode, legacy } = input;
  if (family === "none" || result === "ok") return legacy;
  if (family === "claudestra" && signatureMode !== "on") return legacy;
  return { allow: false, reason: result };
}

const differences = new LogThrottle();
const outcome = (v: PeerSigVerdict): string => v.allow ? v.legacy ? "legacy" : "verified" : "reject";

/** Persist bounded difference categories for PM review; a missing sample must never change authentication. */
function observeContract(area: string, verdict: string): void {
  const now = Date.now();
  try {
    recordObserved(openLedger(), { project: "claude-orchestrator", mechanism: "peerSignatureContract", target: "",
      actionKey: `${verdict.replace("->", ":")}:${Math.floor(now / 60_000)}`, action: verdict, data: { verdict } }, now);
  } catch {
    // Ledger failures lose only observation evidence; do not expose paths or credentials from an exception.
    console.warn("[floka-peer] peerSignatureContract sample write failed; authentication unchanged");
  }
  observePeer(area, verdict);
}

/** Read on every decision: rollback needs no restart. Even on can never widen the baseline permission set. */
export function applySignatureContract(input: ContractInput, baseline: PeerSigVerdict,
  mode: RecoveryMode = recoveryPolicy("claude-orchestrator", "peerSignatureContract").mode,
  observe: (area: string, verdict: string) => void = observeContract): PeerSigVerdict {
  if (mode === "off") return baseline;
  const proposed = signatureContractVerdict(input);
  const candidate = baseline.allow ? proposed : baseline;
  if (mode === "on") return candidate;
  const before = outcome(baseline), after = outcome(candidate);
  // Values are bounded protocol categories only: never log caller-controlled result strings or credentials.
  if (before !== after) {
    const label = `${input.family}:${input.signatureMode}:${before}->${after}`;
    if (differences.take(label)) observe("peerSignatureContract", label);
  }
  return baseline;
}
