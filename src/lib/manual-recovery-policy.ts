/**
 * Mode of an evidence recovery mechanism (RECBASE1). Unlike CFG's effective mode, a project-wide `mode: on` never turns one on:
 * both the umbrella key manualRecovery and the mechanism's own key must be configured `on` explicitly under `keys`; anything else
 * that is not off reads observe (the default). off on either = silent. An invalid / unreadable policy is an error and the caller
 * refuses (it is not off: the tick reports it, nothing is written). tests/manual-recovery-contract*.test.ts.
 */
import { RECOVERY_POLICY_PATH, readRecoveryFile, type RecoveryKey, type RecoveryMode, type RecoveryPolicy } from "./recovery-policy.js";

/** Switch for the whole extension surface; a mechanism also names its own key (it may be this one). */
const MANUAL_RECOVERY_KEY: RecoveryKey = "manualRecovery";

/** policy = CFG's reading; explicit = what `keys[key]` says for this project, null when unset. */
interface ExplicitPolicy { policy: RecoveryPolicy; explicit: RecoveryMode | null }
/** One snapshot per call: every key of one decision is answered from the same read of the policy, never from mixed versions. */
export type ExplicitPolicyPort = (project: string) => (key: RecoveryKey) => ExplicitPolicy;
export type ExtensionMode = { mode: "on" | "observe" | "off"; why: string } | { mode: "error"; why: string };

/** File-backed port: one read, validated by CFG's strict parser; effective mode and explicit key both come from that one copy. */
export const filePolicyPort = (path = RECOVERY_POLICY_PATH): ExplicitPolicyPort => (project) => {
  const r = readRecoveryFile(path);
  const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, project) ? r.data.projects[project] : undefined;
  return (key) => r.status === "corrupt"
    ? { policy: { mode: "off", manualAfterMs: null, source: "error", diagnostic: `${path} 读不了，恢复停手：${r.error}` }, explicit: null }
    : { policy: { mode: cfg?.keys?.[key] ?? cfg?.mode ?? "observe", manualAfterMs: null, source: cfg ? "config" : "default" }, explicit: cfg?.keys?.[key] ?? null };
};

function keyMode(read: (key: RecoveryKey) => ExplicitPolicy, key: RecoveryKey): ExtensionMode {
  let got: ExplicitPolicy;
  try { got = read(key); } catch (e) { return { mode: "error", why: `读恢复策略 ${key} 失败：${(e as Error).message}` }; }
  if (got.policy.source === "error") return { mode: "error", why: got.policy.diagnostic ?? `恢复策略 ${key} 不可用` };
  if (got.policy.mode === "off") return { mode: "off", why: `${key} 是 off` };
  if (got.policy.mode === "on" && got.explicit === "on") return { mode: "on", why: `${key} 显式 on` };
  return { mode: "observe", why: got.policy.mode === "on" ? `${key} 未显式配置 on（项目总档 on 不开新机制），按 observe` : `${key} 是 observe` };
}

/** The most conservative of the umbrella and the mechanism key: error > off > observe > on. */
export function extensionMode(project: string, key: RecoveryKey, port: ExplicitPolicyPort = filePolicyPort()): ExtensionMode {
  let read: (key: RecoveryKey) => ExplicitPolicy;
  try { read = port(project); } catch (e) { return { mode: "error", why: `读恢复策略失败：${(e as Error).message}` }; }
  const keys = key === MANUAL_RECOVERY_KEY ? [key] : [MANUAL_RECOVERY_KEY, key];
  const modes = keys.map((k) => keyMode(read, k));
  for (const rank of ["error", "off", "observe"] as const) {
    const hit = modes.find((m) => m.mode === rank);
    if (hit) return hit;
  }
  return modes[0];
}
