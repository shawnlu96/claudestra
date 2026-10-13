/**
 * Team body switch (team-project-TEAMVIS1): whether this project's card text may be uploaded to the center. It is the
 * `teamBody` key of the one recovery policy file (recovery-policy.ts), never a flag of its own: keys.teamBody → the
 * project's mode → observe. off: nothing leaves and nothing is recorded. observe: only record what would be uploaded.
 * on: upload. An unreadable or invalid policy file answers off (the policy reader's conservative stop).
 * Writes: `ledger scheduler-recovery --key teamBody`. tests/shared-ledger-contract-team-body-switch.test.ts.
 */
import { RECOVERY_POLICY_PATH, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";

export type TeamBodyMode = RecoveryMode;

/** Read every time, never throws. */
export function teamBodyMode(projectId: string, path = RECOVERY_POLICY_PATH): TeamBodyMode {
  return recoveryPolicy(projectId, "teamBody", path).mode;
}
