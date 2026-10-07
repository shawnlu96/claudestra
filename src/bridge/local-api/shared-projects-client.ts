import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Principal } from "../../lib/principals.js";
import { v2ObjectDigest } from "../../lib/shared-ledger-contract-v2-integrity.js";
import { signedHeaders } from "../../lib/instance-key.js";
import type { HttpPeer, PeersData } from "../../lib/peers.js";
import { peerFetch } from "../relay-link.js";
import { proposeSharedProjectInvite, sendApprovedSharedProjectInvite, type ProjectInvitePorts } from "./shared-projects-invite.js";
import { STATE_DIR } from "../../lib/paths.js";
import { SharedLedgerClient } from "../../lib/shared-ledger-client.js";
import { SharedLedgerProjectConflict } from "../../lib/shared-ledger-client-projects.js";
import { SharedLedgerRemoteError } from "../../lib/shared-ledger-client-transport.js";
import { parseV2ProjectsRequest, parseV2ProjectsResponse, type V2ProjectInvite } from "../../lib/shared-ledger-contract-v2-projects.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import { sharedLedgerGateProxy, SHARED_LEDGER_PROJECT_HEADER } from "../../lib/shared-ledger-gate-proxy.js";
import { resolveSharedLedgerCredential } from "../../lib/shared-ledger-mode.js";
import { readSharedLedgerProjects, requireSharedLedgerProject } from "../../lib/shared-ledger-project-link.js";
import { withSharedLedgerProjectMutation } from "../../lib/shared-ledger-project-link-save.js";
import { writeProjects } from "../../lib/projects.js";
import { isPersonalProject } from "../../lib/lend-policy.js";
import { resolveSharedProjectOwner, sharedProjectAnswerPrincipal } from "./shared-projects-auth.js";
import { sharedProjectAskPorts } from "./shared-projects-asks.js";
import { enrollSharedProject } from "./shared-projects-enrollment.js";
import { SharedProjectsError, type ProjectPerson, type SharedProjectsPorts } from "./shared-projects-ports.js";

/** Unavailable dependencies are explicit. A transport peer is not a center recipient; no local writer substitutes for N2 leave. */
export const SHARED_PROJECTS_CAPABILITIES = {
  invite: { available: true, reason: null },
  leave: { available: false, reason: "canonical_local_leave_writer_unavailable" },
  bootstrap: { available: false, reason: "controlled_deployment_executor_unavailable" },
} as const;

function sourceBinding(principal: Principal, requested: string | null, dir: string): SharedLedgerBinding {
  const bindings = readSharedLedgerBindings(dir).filter(b => (requested === null || b.projectId === requested)
    && resolveSharedLedgerCredential(principal.id, "person", b.centerId, b.teamId, b.projectId, "read", dir));
  if (bindings.length !== 1) throw new SharedProjectsError(bindings.length > 1 ? 409 : 403, "original_binding_required");
  return bindings[0]!;
}

/** N4 selects only original local bindings, then supplies N3 an actual resolved person credential and instance key. */
export function sharedProjectsClientPorts(principal: Principal, requested: string | null = null, stateDir = STATE_DIR,
  fetcher: typeof fetch = fetch, original?: SharedLedgerBinding): SharedProjectsPorts {
  const source = structuredClone(original ?? sourceBinding(principal, requested, stateDir));
  const resolve = (action: "read" | "project") => resolveSharedProjectOwner(principal, source, action, stateDir);
  const person = (): ProjectPerson => ({ ...resolve("read").person, sourceBinding: { ...source } });
  const invites = new Map<string, V2ProjectInvite>();
  const client = (who: ProjectPerson, action: "read" | "project") => {
    const actual = resolve(action);
    if (JSON.stringify(who) !== JSON.stringify({ ...actual.person, sourceBinding: source })) throw new SharedProjectsError(403, "person_changed");
    const credential = { ...actual.credential, localSubject: "owner:self" as const, kind: "person" as const };
    return new SharedLedgerClient(credential, actual.key, { fetch: fetcher, projectsProtocol: { parseV2ProjectsRequest, parseV2ProjectsResponse } });
  };
  const checked = async <T>(request: () => Promise<T>): Promise<T> => {
    try { return await request(); }
    catch (error) {
      if (error instanceof SharedLedgerProjectConflict && "status" in error.current) throw new SharedProjectsError(409, "project_conflict", error.current);
      if (error instanceof SharedLedgerRemoteError && error.status < 500) throw new SharedProjectsError(error.status, "center_rejected");
      throw new SharedProjectsError(503, "center_unavailable"); // Never propagate center or bearer text to cards and HTTP.
    }
  };
  const delivery = projectInvitePorts(stateDir, source, client, resolve, checked);
  const ports: SharedProjectsPorts = {
    now: Date.now, ...sharedProjectAskPorts(), person: async () => person(), bindings: () => readSharedLedgerBindings(stateDir),
    list: who => checked(async () => (await client(who, "read").projects()).projects),
    create: (who, input) => checked(async () => {
      const result = await client(who, "project").createProject({ operationId: input.operationId, name: input.name, ...(input.id ? { id: input.id } : {}) });
      if (result.creatorInvite) invites.set(input.operationId, result.creatorInvite);
      return { project: result.project, operation: result.operation };
    }),
    operation: (who, operationId) => checked(async () => {
      const result = await client(who, "read").projectOperation(operationId);
      return { project: result.project, operation: result.operation };
    }),
    patch: (who, id, input) => checked(async () => (await client(who, "project").updateProject(id, input)).project),
    members: (who, id) => checked(async () => (await client(who, "read").projectMembers(id)).members),
    remove: (who, id, personId) => checked(async () => { await client(who, "project").removeProjectMember(id, personId); }),
    authorizeAnswer: async ask => !!await sharedProjectAnswerPrincipal(ask, stateDir),
    invite: (who, id, peers, note, recipient) => proposeSharedProjectInvite(who, id, peers, note, recipient, ports, delivery),
    sendInvite: (who, ask) => sendApprovedSharedProjectInvite(who, ask, ports, delivery),
    ...completionPorts(principal, stateDir, fetcher, invites, client, resolve, checked),
    eligible: async () => readSharedLedgerProjects(stateDir).projects.filter(p => !isPersonalProject(p)).map(p => ({ id: p.id, name: p.name })),
    setDirs: async (who, id, localId, dirs) => {
      client(who, "project");
      await withSharedLedgerProjectMutation(async () => {
        const bindings = readSharedLedgerBindings(stateDir);
        if (!bindings.some(b => b.centerId === who.centerId && b.teamId === who.teamId && b.projectId === id
          && (b.localProjectId ?? b.projectId) === localId)) throw new SharedProjectsError(409, "binding_changed");
        requireSharedLedgerProject(localId, stateDir);
        const data = readSharedLedgerProjects(stateDir);
        data.projects = data.projects.map(p => p.id === localId ? { ...p, dirs: [...dirs] } : p);
        await writeProjects(data, join(stateDir, "projects.json"));
      }, stateDir);
    },
    leave: async () => { throw new SharedProjectsError(503, SHARED_PROJECTS_CAPABILITIES.leave.reason); },
    deploymentAuthorized: async () => false,
    preflight: async () => { throw new SharedProjectsError(503, SHARED_PROJECTS_CAPABILITIES.bootstrap.reason); },
    confirmOwner: async () => { throw new SharedProjectsError(503, SHARED_PROJECTS_CAPABILITIES.bootstrap.reason); },
  };
  return ports;
}


type Client = SharedLedgerClient;
type Resolve = ReturnType<typeof resolveSharedProjectOwner>;
function completionPorts(principal: Principal, stateDir: string, fetcher: typeof fetch, invites: Map<string, V2ProjectInvite>,
  client: (who: ProjectPerson, action: "read" | "project") => Client, resolve: (action: "read" | "project") => Resolve,
  checked: <T>(request: () => Promise<T>) => Promise<T>): Pick<SharedProjectsPorts, "enrollCreator" | "credentialSaved" | "gateRead"> {
  return {
    enrollCreator: async (who, operation, selection) => {
      const c = client(who, "project");
      let invite = invites.get(operation.operation.operationId);
      invites.delete(operation.operation.operationId);
      if (!invite) {
        const recovery = await checked(() => c.recoverProjectCreatorCredential(operation.project.projectId,
          { operationId: operation.operation.operationId, rev: operation.operation.rev }));
        if (recovery.operation.paramsDigest !== operation.operation.paramsDigest) throw new SharedProjectsError(403, "operation_params_changed");
        invite = recovery.creatorInvite ?? undefined;
      }
      if (!invite || invite.personId !== who.personId || invite.instanceId !== who.instanceId
        || invite.centerId !== who.centerId || invite.teamId !== who.teamId || invite.projectId !== operation.project.projectId) {
        throw new SharedProjectsError(403, "creator_invite_mismatch");
      }
      const actual = resolve("project");
      const result = await enrollSharedProject(actual.credential.baseUrl, invite.code, selection,
        { teamId: invite.teamId, projectId: invite.projectId, name: operation.project.name,
          centerId: invite.centerId, personId: invite.personId, instanceId: who.instanceId }, stateDir, fetcher);
      return result.localProjectId;
    },
    credentialSaved: async (who, project) => {
      client(who, "read");
      const c = resolveSharedLedgerCredential(principal.id, "person", who.centerId, who.teamId, project.projectId, "read", stateDir);
      return !!c && c.personId === who.personId && c.instanceId === who.instanceId;
    },
    gateRead: async (who, project, localProjectId) => {
      const actual = resolve("read"); client(who, "read");
      const req = new Request("http://local/shared-ledger/features", { headers: { [SHARED_LEDGER_PROJECT_HEADER]: project.projectId } });
      const response = await sharedLedgerGateProxy(req, "/shared-ledger/features", principal, async (_req, _path, _principal, context) => {
        if (context.centerId !== who.centerId || context.teamId !== who.teamId || context.localProjectId !== localProjectId) return new Response(null, { status: 403 });
        const credential = resolveSharedLedgerCredential(principal.id, "person", context.centerId, context.teamId, context.projectId, "read", stateDir);
        if (!credential || credential.personId !== who.personId || credential.instanceId !== who.instanceId) return new Response(null, { status: 403 });
        await new SharedLedgerClient(credential, context.key, { fetch: fetcher }).features();
        return new Response(null, { status: 200 });
      }, { stateDir, key: () => actual.key });
      return response?.status === 200;
    },
  };
}

/** N3 retains member+invite; the bridge's existing signed E2E/HTTPS transport is the only outbound path. */
function projectInvitePorts(stateDir: string, source: SharedLedgerBinding,
  client: (who: ProjectPerson, action: "read" | "project") => Client, resolve: (action: "read" | "project") => Resolve,
  checked: <T>(request: () => Promise<T>) => Promise<T>): ProjectInvitePorts {
  const project = async (who: ProjectPerson, id: string) => {
    const result = await checked(() => client(who, "read").projects());
    const matches = result.projects.filter(p => p.projectId === id);
    if (matches.length !== 1) throw new SharedProjectsError(403, "project_required");
    return matches[0]!;
  };
  const peers = async () => {
    try { return (JSON.parse(await readFile(join(stateDir, "peers.json"), "utf8")) as PeersData).httpPeers ?? []; }
    catch { throw new SharedProjectsError(503, "peer_state_unavailable"); } // Refuse missing/malformed state rather than guess transport recipients.
  };
  return {
    now: Date.now, stateDir, receiptProject: source.localProjectId ?? source.projectId, peers,
    project, members: async (who, id) => (await checked(() => client(who, "read").projectMembers(id))).members,
    mint: async (who, id, recipient) => {
      const result = await checked(() => client(who, "project").inviteProjectMember(id, recipient));
      return { url: resolve("project").credential.baseUrl, member: result.member, invite: result.invite, project: await project(who, id) };
    },
    post: async (peer: HttpPeer, url, body) => {
      const current = (await peers()).filter(p => p.name === peer.name);
      if (current.length !== 1 || v2ObjectDigest(current[0]) !== v2ObjectDigest(peer)) throw new SharedProjectsError(403, "peer_changed");
      const init = { method: "POST", body, redirect: "error" as const,
        headers: { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json",
          ...signedHeaders("POST", new URL(url).pathname, body, resolve("project").key) }, signal: AbortSignal.timeout(20000) };
      return peerFetch(url, init, { e2eOnly: !!peer.e2e });
    },
  };
}

/** Resolve the saved answer's effective credential again; card metadata may select original scope but cannot supply identity. */
export async function sharedProjectsAnswerPorts(ask: import("../../lib/ledger-asks.js").Ask): Promise<SharedProjectsPorts | undefined> {
  const saved = sharedProjectAskPorts().getAsk(ask.id);
  if (!saved?.answer?.owner || saved.answer.external || saved.createdBy !== "system:shared-projects") return;
  const principal = await sharedProjectAnswerPrincipal(saved, STATE_DIR);
  const who = (saved.bind?.params as { who?: ProjectPerson } | undefined)?.who;
  if (!principal || !who?.sourceBinding) return;
  return sharedProjectsClientPorts(principal, null, STATE_DIR, fetch, who.sourceBinding);
}
