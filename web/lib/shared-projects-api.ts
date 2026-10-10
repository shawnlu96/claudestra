import { api, ApiError, type ApiInit } from "./api/client";
import type { MachineRef } from "./machines";
import { ProjectFailure, projectKey, teamKey, type ProjectRef, type ProjectSnapshot, type SharedProjectsPort } from "./shared-projects-model";
import { object, parseTeamRecord, text } from "./shared-projects-parse";
import { projectSourceCards, projectSourceSnapshot } from "./shared-projects-source";

export type ProjectRequest = (path: string, init: ApiInit) => Promise<unknown>;
const ROOT = "/shared-projects", TEAM = `${ROOT}/teams/current`;

/** Pin both machine and original authorization binding. The header selects trusted server state, never supplies person authority. */
export function sharedProjectsApi(machine: MachineRef, sourceProject?: string, transport?: ProjectRequest): SharedProjectsPort {
  let snapshot: ProjectSnapshot | null = null;
  const operations = new Map<string, string>();
  const headers: Record<string, string> = sourceProject ? { "x-shared-ledger-project": sourceProject } : {};
  const request = async (path: string, init: ApiInit = {}) => {
    try { return await (transport ?? ((p, i) => api(p, i, machine)))(path, { ...init, headers: { ...headers, ...init.headers } }); }
    catch (error) {
      if (!(error instanceof ApiError)) throw new ProjectFailure(0);
      let current;
      if (error.status === 409 && path === TEAM) {
        // Only a parsed same-shape current may offer a retry; no current or a project_conflict leaves the result unconfirmed.
        let team = null;
        try { team = error.body.current === undefined ? null : parseTeamRecord(error.body.current); } catch { /* fixed text only */ }
        const code = error.code ?? error.body.code;
        throw new ProjectFailure(409, undefined, { code: typeof code === "string" ? code : null, team });
      }
      if (error.status === 409 && error.body.current && snapshot) {
        const p = object(error.body.current);
        const old = snapshot.projects.find(v => v.centerId === p.centerId && v.teamId === p.teamId && v.projectId === p.projectId);
        if (old) {
          try {
            const { parseSharedProject } = await import("./shared-projects-parse");
            current = parseSharedProject({ ...p, role: old.role, local: old.local, availability: old.availability });
          } catch { /* A malformed conflict cannot replace trusted display state; only fixed error text is shown. */ }
        }
      }
      throw new ProjectFailure(error.status, current);
    }
  };
  const refPath = (ref: ProjectRef) => {
    if (!snapshot?.projects.some(p => projectKey(p) === projectKey(ref))) throw new ProjectFailure(403);
    return `${ROOT}/${encodeURIComponent(ref.projectId)}`;
  };
  const local = (ref: ProjectRef) => {
    const p = snapshot?.projects.find(p => projectKey(p) === projectKey(ref));
    if (!p?.local) throw new ProjectFailure(409);
    return p.local.id;
  };
  const port: SharedProjectsPort = {
    list: async signal => {
      const next = projectSourceSnapshot(await request(`${ROOT}/snapshot`, { signal }));
      if (signal.aborted) throw new ProjectFailure(0);
      snapshot = next; return next;
    },
    create: async (input, signal) => {
      if (!snapshot?.teams.some(t => teamKey(t) === teamKey(input) && t.teamRole === "owner")) throw new ProjectFailure(403);
      const result = object(await request(ROOT, { method: "POST", signal, json: { operationId: input.operationId,
        name: input.name, ...(input.id ? { id: input.id } : {}),
        selection: input.localProjectId ? { mode: "existing", localProjectId: input.localProjectId } : { mode: "create" } } }));
      if (result.ok !== true || result.operationId !== input.operationId) throw new ProjectFailure(502);
      if (result.available !== true) { operations.set(input.operationId, text(result.askId, 128)); throw new ProjectFailure(202); }
    },
    updateTeam: async (scope, json, signal) => {
      if (!snapshot?.teams.some(t => teamKey(t) === teamKey(scope) && t.teamRole === "owner")) throw new ProjectFailure(403);
      const result = object(await request(TEAM, { method: "PATCH", json: { rev: json.rev, name: json.name }, signal }));
      if (result.ok !== true) throw new ProjectFailure(502);
      return parseTeamRecord(result.team);
    },
    complete: async (input, signal) => {
      const id = operations.get(input.operationId);
      if (!id) return port.create(input, signal);
      await request(`/asks/${encodeURIComponent(id)}`, { signal });
      // The normal answer hook executes N4's one-time claim. Reposting /continue would race it or execute twice.
      // N4 exposes no saved completion result; an answered card or a matching name cannot prove gate-read success.
      throw new ProjectFailure(202);
    },
    patch: async (ref, json, signal) => { await request(refPath(ref), { method: "PATCH", json, signal }); },
    members: async (ref, signal) => {
      const { parseProjectMembers } = await import("./shared-projects-parse");
      return parseProjectMembers(object(await request(`${refPath(ref)}/members`, { signal })).members);
    },
    invite: async (ref, json, signal) => {
      const result = object(await request(`${refPath(ref)}/invite`, { method: "POST", json, signal }));
      if (result.ok !== true || !text(result.askId, 128)) throw new ProjectFailure(502);
    },
    remove: async (ref, id, signal) => { await request(`${refPath(ref)}/members/${encodeURIComponent(id)}/remove`, { method: "POST", json: {}, signal }); },
    directories: async (ref, dirs, signal) => { await request(`${refPath(ref)}/dirs`, { method: "PATCH", json: { localProjectId: local(ref), dirs }, signal }); },
    leave: async (ref, signal) => {
      if (snapshot?.capabilities?.leave !== true) throw new ProjectFailure(501);
      await request(`${refPath(ref)}/leave`, { method: "POST", json: { localProjectId: local(ref) }, signal });
    },
    cards: async signal => projectSourceCards(await request("/asks", { signal })),
    answer: async (card, choices, signal) => {
      await request(`/ledger/${encodeURIComponent(card.project)}/asks/${encodeURIComponent(card.id)}/answer`, { method: "POST", json: { choices }, signal });
    },
  };
  return port;
}
