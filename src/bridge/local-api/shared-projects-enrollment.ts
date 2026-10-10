import { instanceIdSync } from "../../lib/instance-id.js";
import { instanceKeySync } from "../../lib/instance-key.js";
import { redeemSharedLedgerProjectCredential, type SharedLedgerJoinResult } from "../../lib/shared-ledger-join.js";
import { saveSharedLedgerProjectJoin } from "../../lib/shared-ledger-project-link-save.js";
import type { SharedLedgerExpectedProject } from "../../lib/shared-ledger-project-link-grant.js";
import { requireSharedLedgerProject } from "../../lib/shared-ledger-project-link.js";
import { STATE_DIR } from "../../lib/paths.js";
import type { ProjectSelection } from "./shared-projects-ports.js";

/** Expected identity is the approved canonical invitation, fixed before N2 signs the real receiving instance's request. */
export async function enrollSharedProject(url: string, code: string, selection: ProjectSelection, expectedProject: SharedLedgerExpectedProject,
  stateDir = STATE_DIR, fetcher: typeof fetch = fetch): Promise<SharedLedgerJoinResult> {
  if (selection.mode === "existing") requireSharedLedgerProject(selection.localProjectId, stateDir);
  const key = instanceKeySync(stateDir), instanceId = instanceIdSync(stateDir);
  if (!key || !instanceId) throw new Error("receiving instance unavailable");
  const { credential, expiresAt } = await redeemSharedLedgerProjectCredential({ url, code, key, instanceId, subject: "owner:self",
    stateDir, fetch: fetcher, expectedProject });
  // Canonical grants permit service credentials; this person-only approval must reject them before the sole N2 writer runs.
  if (credential.kind !== "person") throw new Error("person credential required; nothing was saved");
  const saved = await saveSharedLedgerProjectJoin(credential, { centerId: credential.centerId, teamId: credential.teamId,
    projectId: expectedProject.projectId, localProjectId: selection.mode === "existing" ? selection.localProjectId : expectedProject.projectId },
    selection.mode === "create" ? expectedProject : undefined, stateDir);
  return { centerId: credential.centerId, teamId: credential.teamId, projectId: expectedProject.projectId,
    personId: credential.personId, kind: credential.kind, expiresAt, ...saved };
}
