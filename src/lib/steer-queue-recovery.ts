/** The hosting bridge projects policy only; target bridges retain their own queue settings and permissions. */
import { openLedger } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";

const PROJECT = "claude-orchestrator";
const KEY = "steerQueueCapability";
const CAPABILITIES = ["enabled", "disabled", "missing", "invalid", "failed"];
const SAMPLE_LIMIT = 256;

export function steerQueueRecovery(policy: RecoveryPolicyPort = recoveryPolicy) {
  return { mode: policy(PROJECT, KEY).mode };
}

/** Samples contain only coarse outcomes and opaque target/version digests, never text or raw settings. */
export function observeSteerQueueCapability(raw: unknown, policy: RecoveryPolicyPort = recoveryPolicy, db = openLedger) {
  const invalid = { ok: false, recorded: false };
  if (!raw || typeof raw !== "object") return invalid;
  const s = raw as Record<string, unknown>;
  if (typeof s.target !== "string" || !/^[a-f0-9]{24}$/.test(s.target)
    || typeof s.version !== "string" || !/^[a-f0-9]{24}$/.test(s.version)
    || typeof s.capability !== "string" || !CAPABILITIES.includes(s.capability)) return invalid;
  if (policy(PROJECT, KEY).mode !== "observe") return { ok: true, recorded: false };
  try {
    const ledger = db();
    return ledger.transaction(() => {
      // A persistent global budget bounds ledger growth even across restarts or credentials rotating their digests.
      const samples = ledger.prepare(`SELECT 1 FROM events WHERE project = ? AND kind = 'note'
        AND json_extract(data, '$.mechanism') = ? LIMIT ?`).all(PROJECT, KEY, SAMPLE_LIMIT);
      if (samples.length >= SAMPLE_LIMIT) return { ok: true, recorded: false };
      recordObserved(ledger, { project: PROJECT, mechanism: KEY, target: "",
        actionKey: `queuecap:${s.target}:${s.version}`, action: "require explicit queue capability before a busy send",
        data: { targetDigest: s.target, capability: s.capability, differs: s.capability === "missing" || s.capability === "invalid" } }, Date.now());
      return { ok: true, recorded: true };
    }).immediate();
  } catch (e) {
    // Observation failure must not change a send's result; the bridge log retains the diagnostic.
    console.warn(`[steer-queue] observation unavailable: ${(e as Error).message}`);
  }
  return { ok: true, recorded: false };
}
