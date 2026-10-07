import { api, ApiError, linkSignals } from "./api/client";
import type { MachineRef } from "./machines";
import { sharedProjectsApi, type ProjectRequest } from "./shared-projects-api";
import { ProjectFailure, projectKey, teamKey, type ProjectSnapshot, type SharedProjectsPort } from "./shared-projects-model";
import { list, object, text } from "./shared-projects-parse";

type Source = { centerId: string; teamId: string; projectId: string; personId: string; instanceId: string };
type Binding = { source: Source; port: SharedProjectsPort; snapshot: ProjectSnapshot | null };
const ambiguous = "绑定无法区分：需要 N4 选择头带 center/team；相关来源已禁用。";

/** These are N4's original binding hints, not credentials and not a second center protocol validator. */
function sources(value: unknown): Source[] {
  return list(object(value).identities, v => {
    const s = object(v);
    return { centerId: text(s.center), teamId: text(s.team), projectId: text(s.project, 32),
      personId: text(s.person), instanceId: text(s.homeInstanceId) };
  });
}
const transient = (status: number) => status === 0 || status === 429 || (status >= 500 && status !== 502);

async function readBinding(binding: Binding, signal: AbortSignal) {
  try {
    const next = await binding.port.list(signal), s = binding.source;
    if (next.teams.length !== 1 || teamKey(next.teams[0]!) !== teamKey(s) || next.teams[0]!.personId !== s.personId
      || next.projects.some(p => p.instanceId !== s.instanceId)) throw new ProjectFailure(502);
    binding.snapshot = next;
    return null;
  } catch (e) {
    const failure = e instanceof ProjectFailure ? e : new ProjectFailure(0);
    if (!transient(failure.status)) binding.snapshot = null;
    return failure;
  }
}

/** Same-team snapshots overlap; retain center identity/display fields and route actions through a successfully read original source. */
function mergeSnapshots(bindings: Binding[], warnings: string[]): ProjectSnapshot {
  const teams = new Map<string, ProjectSnapshot["teams"][number]>(), projects = new Map<string, ProjectSnapshot["projects"][number]>();
  const locals = new Map<string, ProjectSnapshot["localProjects"][number]>(), peers = new Map<string, ProjectSnapshot["peers"][number]>();
  for (const { snapshot } of bindings) {
    if (!snapshot) continue;
    for (const t of snapshot.teams) {
      const old = teams.get(teamKey(t));
      if (old && old.personId !== t.personId) throw new ProjectFailure(502);
      teams.set(teamKey(t), old && old.teamRole !== t.teamRole ? { ...t, teamRole: null } : t);
    }
    for (const p of snapshot.projects) {
      const old = projects.get(projectKey(p));
      if (old && (old.personId !== p.personId || old.instanceId !== p.instanceId)) throw new ProjectFailure(502);
      if (!old || old.rev <= p.rev) projects.set(projectKey(p), p);
    }
    for (const p of snapshot.localProjects) {
      const old = locals.get(p.id);
      locals.set(p.id, { ...p, bound: p.bound || old?.bound === true, personal: p.personal || old?.personal === true });
    }
    for (const p of snapshot.peers) peers.set(p.id, p);
  }
  return { teams: [...teams.values()], projects: [...projects.values()], localProjects: [...locals.values()], peers: [...peers.values()],
    sourceWarnings: [...new Set(warnings)], capabilities: {
      invite: bindings.every(b => !b.snapshot || b.snapshot.capabilities?.invite === true),
      leave: bindings.every(b => !b.snapshot || b.snapshot.capabilities?.leave === true),
    } };
}

/** Read every selectable source. Nothing requests a snapshot without an original binding header, even before context loads. */
export function sharedProjectsByBindings(machine: MachineRef, transport?: ProjectRequest): SharedProjectsPort {
  const request: ProjectRequest = transport ?? ((path, init) => api(path, init, machine));
  let bindings: Binding[] = [];
  let activeRead: AbortController | null = null;
  const operationSources = new Map<string, Binding>();
  const project = (ref: Parameters<SharedProjectsPort["members"]>[0]) => {
    const b = bindings.find(b => b.snapshot?.projects.some(p => projectKey(p) === projectKey(ref)));
    if (!b) throw new ProjectFailure(403);
    return b.port;
  };
  const port: SharedProjectsPort = {
    list: async callerSignal => {
      activeRead?.abort();
      const ctrl = new AbortController(); activeRead = ctrl;
      linkSignals(ctrl, [callerSignal]);
      const signal = ctrl.signal;
      let hints: Source[];
      try { hints = sources(await request("/shared-ledger/context", { signal })); }
      catch (e) { throw e instanceof ProjectFailure ? e : new ProjectFailure(e instanceof ApiError ? e.status : 0); }
      if (signal.aborted) throw new ProjectFailure(0);
      if (!hints.length) { bindings = []; throw new ProjectFailure(403); }
      const warnings: string[] = [];
      const counts = new Map<string, number>();
      for (const s of hints) counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
      const selectable = hints.filter(s => counts.get(s.projectId) === 1);
      if (selectable.length !== hints.length) warnings.push(ambiguous);
      bindings = selectable.map(source => bindings.find(b => JSON.stringify(b.source) === JSON.stringify(source))
        ?? { source, port: sharedProjectsApi(machine, source.projectId, request), snapshot: null });
      const failures = await Promise.all(bindings.map(b => readBinding(b, signal)));
      if (signal.aborted) throw new ProjectFailure(0);
      if (failures.some(e => e?.status === 401)) { bindings = []; throw new ProjectFailure(401); }
      if (!bindings.some(b => b.snapshot) && bindings.length) throw failures.find(e => e !== null) ?? new ProjectFailure(403);
      if (failures.some(Boolean)) warnings.push("部分绑定读取失败；请刷新核对权限与项目状态。");
      const next = mergeSnapshots(bindings, warnings);
      const blocked = new Set(hints.filter(s => !selectable.includes(s)).map(s => projectKey(s)));
      next.projects = next.projects.map(p => blocked.has(projectKey(p)) ? { ...p, availability: "pending" } : p);
      return next;
    },
    create: async (input, signal) => {
      const b = bindings.find(b => b.snapshot?.teams.some(t => teamKey(t) === teamKey(input) && t.teamRole === "owner"));
      if (!b) throw new ProjectFailure(403);
      operationSources.set(input.operationId, b);
      await b.port.create(input, signal);
    },
    complete: async (input, signal) => {
      const b = operationSources.get(input.operationId);
      if (!b || !bindings.includes(b) || !b.snapshot) throw new ProjectFailure(403);
      await b.port.complete(input, signal);
    },
    patch: async (ref, patch, signal) => project(ref).patch(ref, patch, signal),
    members: async (ref, signal) => project(ref).members(ref, signal),
    invite: async (ref, input, signal) => project(ref).invite(ref, input, signal),
    remove: async (ref, id, signal) => project(ref).remove(ref, id, signal),
    directories: async (ref, dirs, signal) => project(ref).directories(ref, dirs, signal),
    leave: async (ref, signal) => project(ref).leave(ref, signal),
    cards: signal => bindings.find(b => b.snapshot)?.port.cards?.(signal) ?? Promise.resolve([]),
    answer: async (card, choices, signal) => {
      const selected = bindings.find(b => b.snapshot)?.port;
      if (!selected?.answer) throw new ProjectFailure(403);
      await selected.answer(card, choices, signal);
    },
  };
  return port;
}
