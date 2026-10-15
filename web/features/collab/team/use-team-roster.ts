"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useFullScope } from "../../chat/contacts-data";
import { ApiError } from "@/lib/api/client";
import { fetchTeamRoster } from "@/lib/api/team-roster";
import { appConfigSync, loadAppConfig, LOCAL_FP } from "@/lib/app-config";
import { machines } from "@/lib/machines";
import { bindingState, localProjectOf, machineCenterKey, subscribeBindings } from "@/lib/collab-source-binding";
import { sharedProjectsByBindings } from "@/lib/shared-projects-bindings";
import { ProjectFailure, type ProjectSnapshot, type ProjectTeam } from "@/lib/shared-projects-model";
import { sharedIdentity } from "../team-source-key";
import type { LoadStatus } from "./roster-model";
import type { Roster } from "./roster-types";

const POLL = 60_000;
/** Retryable failures before the first full success come back quickly, then settle on the poll (tests/web-roster-load-browser.test.ts). */
const RETRY = 5_000, RETRIES = 3;
interface Part<T> { status: LoadStatus; value: T | null }
/** wait = permission or local project mapping still on its way; off = no seat read now (no permission, no local project). */
type Plan = "read" | "wait" | "off";
interface Dir { state: Part<ProjectSnapshot>; subs: Set<() => void>; port: ReturnType<typeof sharedProjectsByBindings>; at: number; read: Promise<boolean> | null }
interface Store {
  fp: string; project: string | null; plan: Plan; state: Part<Roster>; subs: Set<() => void>; pending: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null; stop: (() => void) | null; ctrl: AbortController | null; fails: number; ok: boolean; missed: boolean;
}
const LOADING = { status: "loading", value: null } as const;
const stores = new Map<string, Store>();
const dirs = new Map<string, Dir>();
const denied = new Set<string>();

/** Direct hosting has no machine record; relay mode has none until the machine list loads, which is "not ready", not local. */
const fpNow = (): string | null => machines.currentFp() ?? (appConfigSync()?.mode === "direct" ? LOCAL_FP : null);
function subscribeFp(cb: () => void): () => void {
  let live = true;
  const off = machines.subscribe(cb);
  if (!appConfigSync()) void loadAppConfig().then(() => { if (live) cb(); });
  return () => { live = false; off(); };
}
const initial = (s: Pick<Store, "fp" | "plan">): Part<Roster> =>
  s.plan === "off" ? { status: "ready", value: null } : s.plan === "read" && denied.has(s.fp) ? { status: "error", value: null } : LOADING;
const notify = (subs: Set<() => void>) => { for (const cb of subs) cb(); };

// A permission refusal lasts until a machine switch, including mounts from the sidebar or the seat tab.
// Recording the direct-mode machine (null -> the same fp) is not a switch. Listeners run before the switch lands,
// so stores already keyed on the new machine restart on the next microtask.
machines.onSwitch((_prev, next) => {
  if (next !== null && next === fpNow()) return;
  denied.clear();
  const old = [...dirs.values()];
  dirs.clear();
  for (const d of old) notify(d.subs);
  for (const s of stores.values()) {
    s.ctrl?.abort(); s.pending = null; s.fails = 0; s.ok = false; s.state = initial(s);
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    notify(s.subs);
  }
  queueMicrotask(() => { for (const s of stores.values()) if (s.stop) cycle(s); });
});

function storeOf(fp: string, project: string | null, plan: Plan): Store {
  const key = JSON.stringify([fp, project, plan]);
  let s = stores.get(key);
  if (!s) {
    s = { fp, project, plan, state: LOADING, subs: new Set(), pending: null, timer: null, stop: null, ctrl: null, fails: 0, ok: false, missed: false };
    s.state = initial(s);
    stores.set(key, s);
  }
  return s;
}
function dirOf(fp: string): Dir {
  let d = dirs.get(fp);
  if (!d) dirs.set(fp, d = { state: LOADING, subs: new Set(), port: sharedProjectsByBindings({ fp }), at: 0, read: null });
  return d;
}
/**
 * One directory read per machine, shared by every store and reused for a poll period. Resolves true when the answer is final:
 * a snapshot, or 403/404 (no readable binding = truly no team directory). Other failures stay unknown and are retried.
 */
function readDirectory(fp: string): Promise<boolean> {
  const d = dirOf(fp);
  if (d.read) return d.read;
  if (d.state.status === "ready" && Date.now() - d.at < POLL) return Promise.resolve(true);
  const read = d.port.list(new AbortController().signal).then(
    (value): Part<ProjectSnapshot> => ({ status: "ready", value }),
    (e): Part<ProjectSnapshot> | null => e instanceof ProjectFailure && (e.status === 403 || e.status === 404) ? { status: "ready", value: null } : null,
  ).then(next => {
    d.read = null;
    if (dirs.get(fp) !== d || fpNow() !== fp) return true; // Switched away: the late answer belongs to no view.
    if (next) d.at = Date.now();
    // A failure after a good read keeps the last directory; before any good read it is shown as a failure, not as "none".
    const state = next ?? (d.state.status === "ready" ? d.state : { status: "error", value: null });
    if (state !== d.state) { d.state = state; notify(d.subs); }
    return next !== null;
  });
  d.read = read;
  return read;
}
async function readRoster(s: Store, ctrl: AbortController, live: () => boolean): Promise<boolean> {
  if (s.plan !== "read" || !s.project || denied.has(s.fp)) return true;
  try {
    const value = await fetchTeamRoster(s.project, ctrl.signal);
    if (live()) { s.state = { status: "ready", value }; notify(s.subs); }
    return true;
  } catch (e) {
    if (!live()) return true;
    const forbidden = e instanceof ApiError && e.status === 403;
    if (forbidden) denied.add(s.fp);
    s.state = { status: "error", value: null }; // Failed reads clear counts instead of showing stale seats.
    notify(s.subs);
    return forbidden;
  }
}
/** The next read is scheduled when this one finishes, so a slow or failed first read never costs a whole extra period. */
function cycle(s: Store) {
  if (s.pending || fpNow() !== s.fp) return;
  if (document.visibilityState === "hidden") { s.missed = true; return; }
  if (s.timer) clearTimeout(s.timer);
  s.timer = null; s.missed = false;
  const ctrl = new AbortController();
  s.ctrl = ctrl;
  const live = () => !ctrl.signal.aborted && fpNow() === s.fp;
  const pending = Promise.all([readDirectory(s.fp), readRoster(s, ctrl, live)]).then(([dir, roster]) => {
    if (!live()) return;
    const ok = dir && roster;
    s.fails = ok ? 0 : s.fails + 1;
    s.ok ||= ok;
    s.timer = setTimeout(() => cycle(s), !s.ok && s.fails <= RETRIES ? RETRY : POLL);
  });
  s.pending = pending;
  void pending.finally(() => { if (s.pending === pending) s.pending = null; });
}
function subscribe(s: Store, cb: () => void) {
  s.subs.add(cb);
  if (!s.stop) {
    const onVisible = () => { if (document.visibilityState === "visible" && s.missed) cycle(s); };
    document.addEventListener("visibilitychange", onVisible);
    s.stop = () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (s.timer) clearTimeout(s.timer);
      s.ctrl?.abort(); s.timer = null; s.pending = null; s.stop = null; s.missed = false;
    };
    cycle(s);
  }
  return () => { s.subs.delete(cb); if (!s.subs.size) s.stop?.(); };
}

/** Machine, permission and (for a team key) the local project mapping; undefined local = mapping not known yet. */
function useReadiness(project: string) {
  const fp = useSyncExternalStore(subscribeFp, fpNow, () => null);
  const shared = sharedIdentity(project);
  const full = useFullScope(!shared);
  const centered = !!fp && !!shared && machineCenterKey(fp, project);
  const subBindings = useCallback((cb: () => void) => centered && fp ? subscribeBindings(fp, cb) : () => {}, [centered, fp]);
  // The binding store drops answers while no machine is current (direct dev without a record), so waiting there would never end.
  const bound = useSyncExternalStore(subBindings, () => !centered || !fp || bindingState(fp).settled || !machines.currentFp(), () => false);
  const local = !shared ? project || null : !centered ? null : bound ? localProjectOf(project) : undefined;
  // A team key reads permission passively (no local contact query); nothing guarantees an answer, so unknown there is not
  // shown as loading. It still never reads seats until the answer is true, and the read starts the moment it is.
  const plan: Plan = local === null || full === false || (full === null && shared) ? "off" : local === undefined || full === null ? "wait" : "read";
  return { fp, shared, local, plan };
}

/** One roster read per machine/local project and permission, shared across simultaneous consumers; directory and seats publish separately. */
export function useTeamRoster(project: string) {
  const { fp, shared, local, plan } = useReadiness(project);
  const s = fp ? storeOf(fp, local ?? null, plan) : null;
  const d = fp ? dirOf(fp) : null;
  const sub = useCallback((cb: () => void) => s ? subscribe(s, cb) : () => {}, [s]);
  const subDir = useCallback((cb: () => void) => { if (!d) return () => {}; d.subs.add(cb); return () => { d.subs.delete(cb); }; }, [d]);
  const state = useSyncExternalStore(sub, () => s?.state ?? LOADING, () => LOADING);
  const dir = useSyncExternalStore(subDir, () => d?.state ?? LOADING, () => LOADING);
  const snapshot = dir.value;
  let team: ProjectTeam | null = null;
  if (shared) team = snapshot?.teams.find(t => t.centerId === shared.center && t.teamId === shared.team) ?? null;
  else {
    const bound = snapshot?.projects.find(p => p.local?.id === project);
    if (bound) team = snapshot?.teams.find(t => t.centerId === bound.centerId && t.teamId === bound.teamId) ?? null;
  }
  const projects = snapshot?.projects.filter(p => p.local && p.centerId === team?.centerId && p.teamId === team?.teamId)
    .map(p => ({ localId: p.local!.id, name: p.name })) ?? [];
  return { roster: plan === "read" ? state.value : null, rosterLoading: state.status === "loading", directory: team?.directory ?? null,
    directoryStatus: dir.status, selfPersonId: team?.personId ?? null, instances: team?.instances ?? null, projects,
    reason: local === null ? "没有本机项目" : "这台设备读不到位子" };
}
