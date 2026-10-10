import {
  parseV2ProjectCaller, parseV2ProjectDisplay, parseV2ProjectIdentity, parseV2ProjectJoinGrant,
  type V2ProjectDisplay, type V2ProjectJoinGrant,
} from "./shared-ledger-contract-v2-projects.js";
import { V2ContractError } from "./shared-ledger-contract-v2-validation.js";

/** Supplied only after the invitation and signed owner approval have been verified by the offer consumer. */
export type SharedLedgerExpectedProject = V2ProjectDisplay & { centerId: string; personId: string; instanceId?: string | null };

/** Freeze invitation scope before redemption; the response cannot supply missing expected identity. */
export function sharedLedgerExpectedProject(value: SharedLedgerExpectedProject, centerId: string, instanceId: string): SharedLedgerExpectedProject {
  if (!value.personId) throw new Error("project enrollment unavailable; nothing was saved");
  try {
    const identity = parseV2ProjectIdentity({ centerId: value.centerId, teamId: value.teamId, projectId: value.projectId });
    const display = parseV2ProjectDisplay({ teamId: value.teamId, projectId: value.projectId, name: value.name });
    const person = parseV2ProjectCaller({ kind: "person", personId: value.personId, instanceId });
    if (identity.centerId !== centerId || (value.instanceId != null && value.instanceId !== instanceId) || person.kind !== "person") throw new Error();
    return { ...identity, ...display, personId: person.personId, instanceId };
  } catch { throw new Error("invalid expected project; nothing was saved"); } // Never echo invitation or identity data.
}

export function sharedLedgerOfferedGrant(value: unknown, expected: SharedLedgerExpectedProject, instanceId: string): V2ProjectJoinGrant {
  try {
    const grant = parseV2ProjectJoinGrant(value, { centerId: expected.centerId, teamId: expected.teamId,
      projectId: expected.projectId, personId: expected.personId, instanceId });
    if (grant.project.name !== expected.name) throw new Error();
    return grant;
  } catch (error) {
    if (error instanceof V2ContractError && error.code === "unavailable") throw new Error("project enrollment unavailable; nothing was saved");
    throw new Error("center grant does not match offered project; nothing was saved"); // Raw response errors may contain the bearer.
  }
}
