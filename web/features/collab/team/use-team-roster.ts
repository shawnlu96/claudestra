"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useMachineFp } from "../../talk/use-talk";
import { useFullScope } from "../../chat/contacts-data";
import { ApiError } from "@/lib/api/client";
import { fetchTeamRoster } from "@/lib/api/team-roster";
import { LOCAL_FP } from "@/lib/app-config";
import { machines } from "@/lib/machines";
import { localProjectOf, machineCenterKey } from "@/lib/collab-source-binding";
import { sharedProjectsByBindings } from "@/lib/shared-projects-bindings";
import type { ProjectSnapshot, ProjectTeam } from "@/lib/shared-projects-model";
import { sharedIdentity } from "../team-source-key";
import type { Roster } from "./roster-types";

const POLL = 60_000;
interface State { roster: Roster | null; snapshot: ProjectSnapshot | null }
interface Store {
  state: State; subs: Set<() => void>; pending: Promise<void> | null; readAt: number;
  stop: (() => void) | null; ctrl: AbortController | null;
}
const EMPTY: State = { roster: null, snapshot: null };
const stores = new Map<string, Store>();
const directories = new Map<string, { port: ReturnType<typeof sharedProjectsByBindings>; at: number; read: Promise<ProjectSnapshot | null> }>();
const denied = new Set<string>();
// A permission refusal lasts until a machine switch, including mounts from the sidebar or the seat tab.
machines.onSwitch(() => {
  denied.clear(); directories.clear();
  for (const s of stores.values()) {
    s.ctrl?.abort(); s.pending = null; s.readAt = 0; s.state = EMPTY;
    for (const cb of s.subs) cb();
  }
});

function storeOf(key: string): Store {
  let s = stores.get(key);
  if (!s) stores.set(key, s = { state: EMPTY, subs: new Set(), pending: null, readAt: 0, stop: null, ctrl: null });
  return s;
}
function directoryOf(fp: string): Promise<ProjectSnapshot | null> {
  const previous = directories.get(fp);
  if (previous && Date.now() - previous.at < POLL) return previous.read;
  const port = previous?.port ?? sharedProjectsByBindings({ fp });
  const read = port.list(new AbortController().signal).catch(() => null); // Unavailable directory is unknown, not an empty team.
  directories.set(fp, { port, at: Date.now(), read });
  return read;
}
async function refresh(s: Store, fp: string, project: string | null, allowed: boolean) {
  if (s.pending || document.visibilityState === "hidden" || Date.now() - s.readAt < POLL) return;
  const ctrl = new AbortController(); s.ctrl = ctrl;
  const roster = async () => {
    if (!allowed || !project || denied.has(fp)) return null;
    try { return await fetchTeamRoster(project, ctrl.signal); }
    catch (e) {
      if (e instanceof ApiError && e.status === 403 && !ctrl.signal.aborted) denied.add(fp);
      return null; // Failed reads must clear counts; normal polling is the only retry.
    }
  };
  const pending = (async () => {
    const [r, snapshot] = await Promise.all([roster(), directoryOf(fp)]);
    if (ctrl.signal.aborted || (machines.currentFp() ?? LOCAL_FP) !== fp) return;
    s.readAt = Date.now(); s.state = { roster: r, snapshot };
    for (const cb of s.subs) cb();
  })();
  s.pending = pending;
  try { await pending; } finally { if (s.pending === pending) s.pending = null; }
}
function subscribe(s: Store, fp: string, project: string | null, allowed: boolean, cb: () => void) {
  s.subs.add(cb);
  if (!s.stop) {
    const tick = () => void refresh(s, fp, project, allowed);
    const timer = setInterval(tick, POLL);
    document.addEventListener("visibilitychange", tick);
    s.stop = () => {
      clearInterval(timer); document.removeEventListener("visibilitychange", tick);
      s.ctrl?.abort(); s.pending = null; s.readAt = 0; s.stop = null;
    };
    tick();
  }
  return () => { s.subs.delete(cb); if (!s.subs.size) s.stop?.(); };
}

/** One roster read per machine/local project and permission, shared across simultaneous consumers. */
export function useTeamRoster(project: string) {
  const fp = useMachineFp() ?? LOCAL_FP;
  const shared = sharedIdentity(project);
  const full = useFullScope(!shared);
  const local = shared ? fp && machineCenterKey(fp, project) ? localProjectOf(project) : null : project || null;
  const allowed = full === true;
  const key = JSON.stringify([fp, local, allowed]);
  const s = storeOf(key);
  const sub = useCallback((cb: () => void) => fp ? subscribe(s, fp, local, allowed, cb) : () => {}, [s, fp, local, allowed]);
  const state = useSyncExternalStore(sub, () => s.state, () => EMPTY);
  const snapshot = state.snapshot;
  let team: ProjectTeam | null = null;
  if (shared) team = snapshot?.teams.find(t => t.centerId === shared.center && t.teamId === shared.team) ?? null;
  else {
    const bound = snapshot?.projects.find(p => p.local?.id === project);
    if (bound) team = snapshot?.teams.find(t => t.centerId === bound.centerId && t.teamId === bound.teamId) ?? null;
  }
  const projects = snapshot?.projects.filter(p => p.local && p.centerId === team?.centerId && p.teamId === team?.teamId)
    .map(p => ({ localId: p.local!.id, name: p.name })) ?? [];
  return { roster: allowed && local ? state.roster : null, directory: team?.directory ?? null, selfPersonId: team?.personId ?? null,
    instances: team?.instances ?? null, projects, reason: local ? "这台设备读不到位子" : "没有本机项目" };
}
