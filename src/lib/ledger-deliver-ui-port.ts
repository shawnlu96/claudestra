/**
 * UISDEL1 wiring: the file-backed UiDeliverPort (recovery-policy uiDelivery + recordObserved, artifact roots under the state dir).
 * Separate from ledger-deliver-ui.ts because recovery-policy.ts imports ledger-write.ts. Roots are this machine's own: nothing
 * here widens what may be read. tests/order-deliver-ui.test.ts、tests/ledger-lend-write-ui.test.ts.
 */
import { statePath } from "./paths.js";
import { recordObserved, recoveryPolicy, RECOVERY_POLICY_PATH } from "./recovery-policy.js";
import type { UiDeliverPeer, UiDeliverPort } from "./ledger-deliver-ui.js";

/** <root>/<taskId>/… for local deliveries; <root>/imported/<peer>/<order>/… for artifacts a peer order already had imported */
export const UI_ARTIFACT_ROOT = statePath("ledger", "ui-artifacts");

export function uiDeliverPort(o: { peer?: UiDeliverPeer; policyPath?: string; root?: string; now?: number } = {}): UiDeliverPort {
  const root = o.root ?? UI_ARTIFACT_ROOT, path = o.policyPath ?? RECOVERY_POLICY_PATH;
  return {
    mode: (project) => recoveryPolicy(project, "uiDelivery", path),
    observe: (db, a) => { recordObserved(db, { ...a, mechanism: "uiDelivery" }, o.now ?? Date.now()); },
    roots: { local: root, imported: `${root}/imported` },
    ...(o.peer ? { peer: o.peer } : {}),
  };
}
