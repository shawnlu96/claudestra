import { ProjectFailure, projectKey, teamKey, type ProjectMember, type ProjectSnapshot, type SharedProject } from "./shared-projects-model";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectFailure(502);
  return value as ObjectValue;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new ProjectFailure(502);
  return value;
}
function list<T>(value: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new ProjectFailure(502);
  return value.map(parse);
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new ProjectFailure(502);
  return value as T;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ProjectFailure(502);
  return value;
}
function scope(value: ObjectValue) { return { centerId: text(value.centerId), teamId: text(value.teamId) }; }

/** Pick fields explicitly: an accidental center response or error object cannot reach React via a spread. */
export function parseSharedProject(value: unknown): SharedProject {
  const p = object(value);
  if (!Number.isSafeInteger(p.rev) || (p.rev as number) < 1) throw new ProjectFailure(502);
  const local = p.local === null ? null : object(p.local);
  const projectId = text(p.projectId, 32);
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(projectId)) throw new ProjectFailure(502);
  return { ...scope(p), projectId, name: text(p.name, 128), rev: p.rev as number,
    status: choice(p.status, ["active", "archived"]), role: p.role === null ? null : choice(p.role, ["owner", "member"]),
    availability: choice(p.availability, ["ready", "pending"]),
    local: local ? { id: text(local.id, 32), name: text(local.name, 128), dirs: list(local.dirs, v => text(v, 4096)) } : null,
    ...(p.operationId === undefined ? {} : { operationId: text(p.operationId) }),
  };
}

export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  const data = object(value);
  const teams = list(data.teams, v => {
    const t = object(v);
    return { ...scope(t), name: text(t.name, 128), personId: text(t.personId), teamRole: choice(t.teamRole, ["owner", "member"]) };
  });
  const projects = list(data.projects, parseSharedProject);
  const keys = new Set<string>(), bindings = new Set<string>();
  for (const p of projects) {
    if (!teams.some(t => teamKey(t) === teamKey(p)) || keys.has(projectKey(p))) throw new ProjectFailure(502);
    keys.add(projectKey(p));
    if (p.local) {
      if (bindings.has(p.local.id)) throw new ProjectFailure(502);
      bindings.add(p.local.id);
    }
  }
  return { teams, projects,
    localProjects: list(data.localProjects, v => {
      const p = object(v);
      return { id: text(p.id, 32), name: text(p.name, 128), personal: boolean(p.personal), bound: boolean(p.bound) };
    }),
    peers: list(data.peers, v => { const p = object(v); return { id: text(p.id), name: text(p.name, 128) }; }),
  };
}

export function parseProjectMembers(value: unknown): ProjectMember[] {
  return list(value, v => {
    const m = object(v);
    return { personId: text(m.personId), code: text(m.code, 128), role: choice(m.role, ["owner", "member"]),
      status: choice(m.status, ["invited", "active", "removed"]) };
  });
}
