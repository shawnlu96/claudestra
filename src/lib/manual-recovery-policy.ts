/**
 * Mode of an evidence recovery mechanism (RECBASE1). Unlike CFG's effective mode, a project-wide `mode: on` never turns one on:
 * both the umbrella key manualRecovery and the mechanism's own key must be configured `on` explicitly under `keys`; anything else
 * that is not off reads observe (the default). off on either = silent. An invalid / unreadable policy is an error and the caller
 * refuses (it is not off: the tick reports it, nothing is written). tests/manual-recovery-contract*.test.ts.
 */
import { readFileSync } from "node:fs";
import { RECOVERY_POLICY_PATH, recoveryPolicy, type RecoveryKey, type RecoveryMode, type RecoveryPolicy } from "./recovery-policy.js";

/** Switch for the whole extension surface; a mechanism also names its own key (it may be this one). */
const MANUAL_RECOVERY_KEY: RecoveryKey = "manualRecovery";

/** policy = CFG's reading; explicit = what `keys[key]` says for this project, null when unset. */
interface ExplicitPolicy { policy: RecoveryPolicy; explicit: RecoveryMode | null }
export type ExplicitPolicyPort = (project: string, key: RecoveryKey) => ExplicitPolicy;
export type ExtensionMode = { mode: "on" | "observe" | "off"; why: string } | { mode: "error"; why: string };

/** File-backed port: CFG validates the file, then its own `keys` entry is read again from the same path. */
export const filePolicyPort = (path = RECOVERY_POLICY_PATH): ExplicitPolicyPort => (project, key) => {
  const policy = recoveryPolicy(project, key, path);
  if (policy.source !== "config") return { policy, explicit: null };
  const data = JSON.parse(readFileSync(path, "utf8")) as { projects: Record<string, { keys?: Record<string, RecoveryMode> }> };
  return { policy, explicit: data.projects[project]?.keys?.[key] ?? null };
};

function keyMode(port: ExplicitPolicyPort, project: string, key: RecoveryKey): ExtensionMode {
  let read: ExplicitPolicy;
  try { read = port(project, key); } catch (e) { return { mode: "error", why: `读恢复策略 ${key} 失败：${(e as Error).message}` }; }
  if (read.policy.source === "error") return { mode: "error", why: read.policy.diagnostic ?? `恢复策略 ${key} 不可用` };
  if (read.policy.mode === "off") return { mode: "off", why: `${key} 是 off` };
  if (read.policy.mode === "on" && read.explicit === "on") return { mode: "on", why: `${key} 显式 on` };
  return { mode: "observe", why: read.policy.mode === "on" ? `${key} 未显式配置 on（项目总档 on 不开新机制），按 observe` : `${key} 是 observe` };
}

/** The most conservative of the umbrella and the mechanism key: error > off > observe > on. */
export function extensionMode(project: string, key: RecoveryKey, port: ExplicitPolicyPort = filePolicyPort()): ExtensionMode {
  const keys = key === MANUAL_RECOVERY_KEY ? [key] : [MANUAL_RECOVERY_KEY, key];
  const modes = keys.map((k) => keyMode(port, project, k));
  for (const rank of ["error", "off", "observe"] as const) {
    const hit = modes.find((m) => m.mode === rank);
    if (hit) return hit;
  }
  return modes[0];
}
