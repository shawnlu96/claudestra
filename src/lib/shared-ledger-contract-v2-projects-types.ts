import type { Infer } from "./shared-ledger-contract-v2-validation.js";
import type {
  parseV2ProjectIdentity, parseV2ProjectRecord, parseV2ProjectMember, parseV2ProjectTeamMember,
  parseV2ProjectCaller, parseV2ProjectOperation, parseV2ProjectInvite, parseV2ProjectDisplay, parseV2ProjectJoinGrant,
  V2_PROJECTS_REQUEST_SCHEMAS, V2_PROJECTS_SUCCESS_SCHEMAS,
  V2ProjectsSimpleError, V2ProjectsProjectConflict, V2ProjectsOperationConflict,
} from "./shared-ledger-contract-v2-projects.js";

/** Types derive from the canonical field tables so consumers cannot drift from the wire parser. */
export type V2ProjectIdentity = Infer<typeof parseV2ProjectIdentity>;
export type V2ProjectRecord = Infer<typeof parseV2ProjectRecord>;
export type V2ProjectMember = Infer<typeof parseV2ProjectMember>;
export type V2ProjectTeamMember = Infer<typeof parseV2ProjectTeamMember>;
export type V2ProjectCaller = Infer<typeof parseV2ProjectCaller>;
export type V2ProjectOperation = Infer<typeof parseV2ProjectOperation>;
export type V2ProjectInvite = Infer<typeof parseV2ProjectInvite>;
export type V2ProjectDisplay = Infer<typeof parseV2ProjectDisplay>;
export type V2ProjectJoinGrant = ReturnType<typeof parseV2ProjectJoinGrant>;
export type V2ProjectsExpectedScope = Pick<V2ProjectIdentity, "centerId" | "teamId">
  & { projectId?: string; operationId?: string; personId?: string; instanceId?: string };
export type V2ProjectsEndpoint = keyof typeof V2_PROJECTS_REQUEST_SCHEMAS;
export type V2ProjectsRequests = { [E in V2ProjectsEndpoint]: Infer<(typeof V2_PROJECTS_REQUEST_SCHEMAS)[E]> };
export type V2ProjectsSuccesses = { [E in V2ProjectsEndpoint]: Infer<(typeof V2_PROJECTS_SUCCESS_SCHEMAS)[E]> };
export type V2ProjectsResponses = {
  [E in V2ProjectsEndpoint]: V2ProjectsSuccesses[E] | V2ProjectsSimpleError
    | (E extends "update" ? V2ProjectsProjectConflict : E extends "create" ? V2ProjectsOperationConflict
      : E extends "creatorCredential" ? Extract<V2ProjectsOperationConflict, { error: "conflict" }> : never);
};
