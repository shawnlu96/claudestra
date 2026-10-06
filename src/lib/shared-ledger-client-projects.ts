import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import {
  parseV2ProjectCaller, parseV2ProjectsRequest, parseV2ProjectsResponse,
  type V2ProjectOperation, type V2ProjectRecord, type V2ProjectsEndpoint, type V2ProjectsExpectedScope,
  type V2ProjectsRequests, type V2ProjectsSuccesses,
} from "./shared-ledger-contract-v2-projects.js";
import {
  requestSharedLedger, SharedLedgerRemoteError, SharedLedgerUnavailable, type SharedLedgerTransportOptions,
} from "./shared-ledger-client-transport.js";

/** Selection metadata only. N4 must authenticate the local Principal and use resolveSharedLedgerCredential
 * for its original approved person binding before constructing this client. These tags and the public caller
 * DTO do not authenticate a person; the center verifies bearer and signature.
 */
export interface SharedLedgerProjectOwner extends SharedLedgerConnection { localSubject: "owner:self"; kind: "person" }
export type SharedLedgerProjectsProtocol = Pick<typeof import("./shared-ledger-contract-v2-projects.js"),
  "parseV2ProjectsRequest" | "parseV2ProjectsResponse">;
type Endpoint = Exclude<V2ProjectsEndpoint, "teamOwners">;
type Input<E extends Endpoint> = V2ProjectsRequests[E] extends infer R
  ? R extends unknown ? Omit<R, "centerId" | "teamId" | "projectId"> : never : never;
export interface SharedLedgerProjectsOptions<P extends SharedLedgerProjectsProtocol> extends SharedLedgerTransportOptions {
  /** Explicit opt-in to the fixed public producer, never a replacement codec or a declaration of verified identity. */
  projectsProtocol?: P;
}
/** Only producer-validated public records survive a conflict; no raw error envelope or invitation is retained. */
export class SharedLedgerProjectConflict<T extends V2ProjectRecord | V2ProjectOperation = V2ProjectRecord | V2ProjectOperation>
  extends SharedLedgerRemoteError {
  declare readonly current: T;
  constructor(current: T) {
    super(409, { error: "shared ledger rejected" });
    Object.defineProperty(this, "current", { value: current, enumerable: false });
  }
}

export abstract class SharedLedgerProjectsClient<P extends SharedLedgerProjectsProtocol> {
  constructor(private projectConnection: SharedLedgerConnection, private projectKey: InstanceKey,
    private projectOptions: SharedLedgerProjectsOptions<P>) {}

  private requestScope<E extends Endpoint>(connection: SharedLedgerConnection, request: V2ProjectsRequests[E]): V2ProjectsExpectedScope {
    const expected: V2ProjectsExpectedScope = { centerId: connection.centerId, teamId: connection.teamId };
    if ("projectId" in request) expected.projectId = request.projectId;
    if ("id" in request && request.id !== undefined) expected.projectId = request.id;
    if ("personId" in request) expected.personId = request.personId;
    if ("operationId" in request) {
      expected.operationId = request.operationId;
      expected.personId = connection.personId;
      expected.instanceId = connection.instanceId;
    }
    return Object.freeze(expected);
  }

  private async projectRequest<E extends Endpoint>(endpoint: E, method: string, path: string,
    selected: Partial<V2ProjectsExpectedScope>, input?: unknown, signal?: AbortSignal): Promise<V2ProjectsSuccesses[E]> {
    const connection = { ...this.projectConnection };
    const options = { ...this.projectOptions };
    const owner = connection as Partial<SharedLedgerProjectOwner>;
    if (owner.localSubject !== "owner:self" || owner.kind !== "person") {
      throw new Error("shared ledger projects require owner:self person credential");
    }
    const protocol = options.projectsProtocol;
    if (protocol?.parseV2ProjectsRequest !== parseV2ProjectsRequest || protocol.parseV2ProjectsResponse !== parseV2ProjectsResponse) {
      throw new Error("shared ledger projects contract unavailable");
    }
    let request: V2ProjectsRequests[E];
    try {
      parseV2ProjectCaller({ kind: owner.kind, personId: owner.personId, instanceId: owner.instanceId });
      if (typeof owner.bearer !== "string" || !owner.bearer) throw new Error();
      const draft = structuredClone(input) as object | undefined;
      request = parseV2ProjectsRequest(endpoint, { centerId: connection.centerId, teamId: connection.teamId, ...selected, ...draft });
      if (request.centerId !== connection.centerId || request.teamId !== connection.teamId
        || Object.entries(selected).some(([field, value]) => (request as Record<string, unknown>)[field] !== value)) throw new Error();
      Object.freeze(request);
    } catch { throw new Error("invalid shared ledger project request"); } // Discard identifiers, credentials and parser text from invalid input.
    const expected = this.requestScope(connection, request);
    const reject = async (status: number, response: Response) => {
      if (status === 409) {
        let parsed;
        try { parsed = parseV2ProjectsResponse(endpoint, status, await response.json(), expected); }
        catch { return { error: "shared ledger rejected" }; } // Malformed conflicts still reject as 409, without raw bodies or parser text.
        if (!parsed.ok && "current" in parsed) throw new SharedLedgerProjectConflict(parsed.current);
      }
      return { error: "shared ledger rejected" };
    };
    const parsed = await requestSharedLedger(connection, this.projectKey, options, method, path,
      method === "GET" ? undefined : request, signal, reject, undefined,
      (status, raw) => parseV2ProjectsResponse(endpoint, status, raw, expected)) as V2ProjectsSuccesses[E];
    if (endpoint === "invite" && "code" in request
      && (parsed as V2ProjectsSuccesses["invite"]).member.code !== request.code) throw new SharedLedgerUnavailable();
    return parsed;
  }

  projects(signal?: AbortSignal) { return this.projectRequest("list", "GET", "/v1/projects", {}, undefined, signal); }
  createProject(input: Input<"create">, signal?: AbortSignal) {
    return this.projectRequest("create", "POST", "/v1/projects", {}, input, signal);
  }
  updateProject(projectId: string, input: Input<"update">, signal?: AbortSignal) {
    return this.projectRequest("update", "PATCH", `/v1/projects/${projectId}`, { projectId }, input, signal);
  }
  projectMembers(projectId: string, signal?: AbortSignal) {
    return this.projectRequest("members", "GET", `/v1/projects/${projectId}/members`, { projectId }, undefined, signal);
  }
  inviteProjectMember(projectId: string, input: Input<"invite">, signal?: AbortSignal) {
    return this.projectRequest("invite", "POST", `/v1/projects/${projectId}/invites`, { projectId }, input, signal);
  }
  removeProjectMember(projectId: string, personId: string, signal?: AbortSignal) {
    return this.projectRequest("removeMember", "POST", `/v1/projects/${projectId}/members/${personId}/remove`,
      { projectId, personId }, undefined, signal);
  }
  projectOperation(operationId: string, signal?: AbortSignal) {
    return this.projectRequest("operation", "GET", `/v1/projects/operations/${operationId}`, { operationId }, undefined, signal);
  }
  recoverProjectCreatorCredential(projectId: string, input: Input<"creatorCredential">, signal?: AbortSignal) {
    return this.projectRequest("creatorCredential", "POST", `/v1/projects/${projectId}/creator-credential`, { projectId }, input, signal);
  }
}
