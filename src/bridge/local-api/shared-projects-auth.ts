import type { Principal } from "../../lib/principals.js";
import { canManage } from "../../lib/devices.js";
import { instanceIdSync } from "../../lib/instance-id.js";
import { instanceKeySync } from "../../lib/instance-key.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import { resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "../../lib/shared-ledger-mode.js";
import { parseV2ProjectCaller } from "../../lib/shared-ledger-contract-v2-projects.js";
import { SharedProjectsError, type ProjectPerson } from "./shared-projects-ports.js";

/** The caller is the actual authenticateApi/effectivePrincipal result, never a body or a legacy token label. */
export function sharedProjectOwnerPrincipal(principal: Principal): boolean {
  return principal.id === "owner:self" && principal.role === "owner" && !principal.disabled && !principal.peer && canManage(principal);
}

/** Scope must be selected from the original binding/approval. New-project and recipient JSON cannot choose the credential subject. */
export function resolveSharedProjectOwner(principal: Principal, original: SharedLedgerBinding,
  action: SharedLedgerLocalCredential["projects"][number]["actions"][number], stateDir: string) {
  if (!sharedProjectOwnerPrincipal(principal)) throw new SharedProjectsError(403, "owner_required");
  const bindings = readSharedLedgerBindings(stateDir).filter(b => b.centerId === original.centerId && b.teamId === original.teamId
    && b.projectId === original.projectId && (b.localProjectId ?? b.projectId) === (original.localProjectId ?? original.projectId));
  if (bindings.length !== 1) throw new SharedProjectsError(403, "original_binding_required");
  const credential = resolveSharedLedgerCredential(principal.id, "person", original.centerId, original.teamId, original.projectId, action, stateDir);
  if (!credential || credential.kind !== "person" || credential.localSubject !== principal.id) throw new SharedProjectsError(403, "person_credential_required");
  const key = instanceKeySync(stateDir), instanceId = instanceIdSync(stateDir);
  if (!key || !instanceId || credential.instanceId !== instanceId) throw new SharedProjectsError(403, "instance_changed");
  const caller = parseV2ProjectCaller({ kind: credential.kind, personId: credential.personId, instanceId });
  if (caller.kind !== "person") throw new SharedProjectsError(403, "person_required");
  const person: ProjectPerson = { subject: "owner:self", kind: "person", centerId: credential.centerId,
    teamId: credential.teamId, personId: caller.personId, instanceId: caller.instanceId };
  return { person, credential, key };
}
