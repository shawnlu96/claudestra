import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import { id } from "./shared-ledger-contract-schema.js";
import { canonicalJson } from "./ask-bind.js";
import {
  requestSharedLedger, SharedLedgerRemoteError, SharedLedgerUnavailable, type SharedLedgerTransportOptions,
} from "./shared-ledger-client-transport.js";

export interface SharedLedgerProjectOwner extends SharedLedgerConnection { localSubject: "owner:self"; kind: "person" }
export interface SharedLedgerProjectScope {
  readonly centerId: string; readonly teamId: string; readonly personId: string; readonly instanceId: string;
  readonly projectId?: string; readonly operationId?: string; readonly targetPersonId?: string;
}
type Read = "projects" | "members" | "operation";
type Write = "create" | "update" | "invite" | "remove" | "recover";
type Operation = Read | Write;
/** N1C owns the wire format. Encoders produce the complete JSON envelope, including the supplied nonce.
 * Parsers must validate the whole response and its request scope, and return only contract fields.
 * No default codec exists: the frozen design alone does not specify an envelope or recovery version field.
 */
export interface SharedLedgerProjectsProtocol {
  requests: { [K in Write]: (input: never, scope: SharedLedgerProjectScope, attemptNonce: string) => unknown };
  responses: { [K in Operation]: (raw: unknown, scope: SharedLedgerProjectScope, input: unknown) => unknown };
  /** Return only the validated public current value, never the error envelope, a code or a bearer. */
  conflict(raw: unknown, scope: SharedLedgerProjectScope, input: unknown, operation: Operation): unknown;
}
type Input<P extends SharedLedgerProjectsProtocol, K extends Write> = Parameters<P["requests"][K]>[0];
type Output<P extends SharedLedgerProjectsProtocol, K extends Operation> = ReturnType<P["responses"][K]>;
export interface SharedLedgerProjectsOptions<P extends SharedLedgerProjectsProtocol> extends SharedLedgerTransportOptions {
  projectsProtocol?: P;
}
/** Current stays available to UI code without being serialized or included by ordinary error logging. */
export class SharedLedgerProjectConflict extends SharedLedgerRemoteError {
  declare readonly current: unknown;
  constructor(current: unknown) {
    super(409, { error: "shared ledger rejected" });
    Object.defineProperty(this, "current", { value: current, enumerable: false });
  }
}

/** Adds project methods to SharedLedgerClient without inferring person authority from service grants. */
export abstract class SharedLedgerProjectsClient<P extends SharedLedgerProjectsProtocol> {
  constructor(private projectConnection: SharedLedgerConnection, private projectKey: InstanceKey,
    private projectOptions: SharedLedgerProjectsOptions<P>) {}

  private scope(selected: Partial<SharedLedgerProjectScope>): SharedLedgerProjectScope {
    const c = this.projectConnection as Partial<SharedLedgerProjectOwner>;
    if (c.localSubject !== "owner:self" || c.kind !== "person") throw new Error("shared ledger projects require owner:self person credential");
    try {
      for (const value of [c.centerId, c.teamId, c.personId, c.instanceId, selected.operationId, selected.targetPersonId]) {
        if (value !== undefined) id(value);
      }
      if (![c.centerId, c.teamId, c.personId, c.instanceId, c.bearer].every(v => typeof v === "string" && v.length > 0)) throw new Error();
      if (selected.projectId !== undefined && (typeof selected.projectId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(selected.projectId))) throw new Error();
    } catch { throw new Error("invalid shared ledger project request"); } // Input validation must not echo identifiers or credentials.
    return Object.freeze({ centerId: c.centerId!, teamId: c.teamId!, personId: c.personId!, instanceId: c.instanceId!, ...selected });
  }

  private async projectRequest<K extends Operation>(operation: K, method: string, path: string, selected: Partial<SharedLedgerProjectScope>,
    input?: unknown, signal?: AbortSignal): Promise<Output<P, K>> {
    const scope = this.scope(selected);
    const protocol = this.projectOptions.projectsProtocol;
    if (!protocol) throw new Error("shared ledger projects contract unavailable");
    let requestInput: unknown;
    try { requestInput = structuredClone(input); }
    catch { throw new Error("invalid shared ledger project request"); } // Uncloneable inputs cannot form a stable request snapshot; discard their error text.
    const reject = async (status: number, response: Response) => {
      if (status === 409) {
        let current: unknown;
        try { current = protocol.conflict(await response.json(), scope, requestInput, operation); }
        catch { return { error: "shared ledger rejected" }; } // Broken conflict bodies still reject as 409, without raw body or parser text.
        throw new SharedLedgerProjectConflict(current);
      }
      return { error: "shared ledger rejected" };
    };
    const encode = method === "GET" ? undefined : (nonce: string) => {
      try { return canonicalJson(protocol.requests[operation as Write](requestInput as never, scope, nonce)); }
      catch { throw new SharedLedgerUnavailable(); } // Encoders are injected; even a custom error must not retain their input.
    };
    const raw = await requestSharedLedger(this.projectConnection, this.projectKey, this.projectOptions, method, path, requestInput, signal, reject, encode);
    try { return protocol.responses[operation](raw, scope, requestInput) as Output<P, K>; }
    catch { throw new SharedLedgerUnavailable(); } // The protocol parser may mention secrets in a rejected response; never attach its cause.
  }

  projects(signal?: AbortSignal) { return this.projectRequest("projects", "GET", "/v1/projects", {}, undefined, signal); }
  createProject(input: Input<P, "create">, signal?: AbortSignal) {
    return this.projectRequest("create", "POST", "/v1/projects", {}, input, signal);
  }
  updateProject(projectId: string, input: Input<P, "update">, signal?: AbortSignal) {
    return this.projectRequest("update", "PATCH", `/v1/projects/${projectId}`, { projectId }, input, signal);
  }
  projectMembers(projectId: string, signal?: AbortSignal) {
    return this.projectRequest("members", "GET", `/v1/projects/${projectId}/members`, { projectId }, undefined, signal);
  }
  inviteProjectMember(projectId: string, input: Input<P, "invite">, signal?: AbortSignal) {
    return this.projectRequest("invite", "POST", `/v1/projects/${projectId}/invites`, { projectId }, input, signal);
  }
  removeProjectMember(projectId: string, personId: string, signal?: AbortSignal) {
    return this.projectRequest("remove", "POST", `/v1/projects/${projectId}/members/${personId}/remove`,
      { projectId, targetPersonId: personId }, undefined, signal);
  }
  projectOperation(operationId: string, signal?: AbortSignal) {
    return this.projectRequest("operation", "GET", `/v1/projects/operations/${operationId}`, { operationId }, undefined, signal);
  }
  recoverProjectCreatorCredential(projectId: string, input: Input<P, "recover">, signal?: AbortSignal) {
    return this.projectRequest("recover", "POST", `/v1/projects/${projectId}/creator-credential`, { projectId }, input, signal);
  }
}
