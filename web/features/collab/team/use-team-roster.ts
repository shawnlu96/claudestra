"use client";
import { useCallback, useSyncExternalStore } from "react";
import { useFullScope } from "../../chat/contacts-data";
import { ApiError } from "@/lib/api/client";
import { fetchTeamRoster } from "@/lib/api/team-roster";
import { appConfigSync, loadAppConfig, LOCAL_FP } from "@/lib/app-config";
import { machines } from "@/lib/machines";
import { bindingState, localProjectOf, machineCenterKey, subscribeBindings } from "@/lib/collab-source-binding";
import { sharedProjectsByBindings } from "@/lib/shared-projects-bindings";
import type { ProjectSnapshot, ProjectTeam } from "@/lib/shared-projects-model";
import { sharedIdentity } from "../team-source-key";
import type { LoadStatus } from "./roster-model";
import type { Roster } from "./roster-types";

const POLL = 60_000;
/** Retryable failures before a source's first success come back quickly, then settle on the poll (tests/web-roster-load-browser.test.ts). */
const RETRY = 5_000, RETRIES = 3;
interface Part<T> { status: LoadStatus; value: T | null }
/** wait = permission or local project mapping still on its way; off = no seat read now (no permission, no local project). */
type Plan = "read" | "wait" | "off";
interface Dir { state: Part<ProjectSnapshot>; subs: Set<() => void>; port: ReturnType<typeof sharedProjectsByBindings>; at: number; read: Promise<boolean> | null }
/** One self-scheduling read loop; directory and seats each own one so a slow source never delays the other's retry. */
interface Loop { pending: boolean; timer: ReturnType<typeof setTimeout> | null; fails: number; ok: boolean; missed: boolean }
interface Store {
  fp: string; project: string | null; plan: Plan; state: Part<Roster>; subs: Set<() => void>; gen: number;
  loops: { dir: Loop; roster: Loop }; stop: (() => void) | null; ctrl: AbortController | null;
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
const newLoop = (): Loop => ({ pending: false, timer: null, fails: 0, ok: false, missed: false });
/** Drops everything in flight: late answers see a new generation and neither publish nor reschedule. */
function reset(s: Store) {
  s.gen++; s.ctrl?.abort(); s.ctrl = null;
  for (const l of Object.values(s.loops)) if (l.timer) clearTimeout(l.timer);
  s.loops = { dir: newLoop(), roster: newLoop() };
}

// A permission refusal lasts until a machine switch, including mounts from the sidebar or the seat tab.
// Recording the direct-mode machine (null -> the same fp) is not a switch. Listeners run before the switch lands,
// so stores already keyed on the new machine restart on the next microtask.
machines.onSwitch((_prev, next) => {
  if (next !== null && next === fpNow()) return;
  denied.clear();
  const old = [...dirs.values()];
  dirs.clear();
  for (const d of old) notify(d.subs);
  for (const s of stores.values()) { reset(s); s.state = initial(s); notify(s.subs); }
  queueMicrotask(() => { for (const s of stores.values()) if (s.stop) start(s); });
});

function storeOf(fp: string, project: string | null, plan: Plan): Store {
  const key = JSON.stringify([fp, project, plan]);
  let s = stores.get(key);
  if (!s) {
    s = { fp, project, plan, state: LOADING, subs: new Set(), gen: 0, loops: { dir: newLoop(), roster: newLoop() }, stop: null, ctrl: null };
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
 * One directory read per machine, shared by every store and reused for a poll period; resolves whether it succeeded.
 * Any failure is unknown, never "no directory" (403 also covers a binding whose read was refused): the binding store decides absence.
 */
function readDirectory(fp: string): Promise<boolean> {
  const d = dirOf(fp);
  if (d.read) return d.read;
  if (d.state.status === "ready" && Date.now() - d.at < POLL) return Promise.resolve(true);
  const read = d.port.list(new AbortController().signal).then(value => ({ status: "ready", value }) as const, () => null).then(next => {
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
async function readRoster(s: Store, live: () => boolean): Promise<boolean> {
  if (!s.project || denied.has(s.fp)) return true;
  const ctrl = new AbortController();
  s.ctrl = ctrl;
  const current = () => live() && !ctrl.signal.aborted;
  try {
    const value = await fetchTeamRoster(s.project, ctrl.signal);
    if (current()) { s.state = { status: "ready", value }; notify(s.subs); }
    return true;
  } catch (e) {
    if (!current()) return true;
    const forbidden = e instanceof ApiError && e.status === 403;
    if (forbidden) denied.add(s.fp);
    s.state = { status: "error", value: null }; // Failed reads clear counts instead of showing stale seats.
    notify(s.subs);
    return forbidden;
  }
}
/** The next read is scheduled when this one finishes, so a slow or failed first read never costs a whole extra period. */
function run(s: Store, loop: Loop, read: (live: () => boolean) => Promise<boolean>) {
  if (loop.pending || fpNow() !== s.fp) return;
  if (document.visibilityState === "hidden") { loop.missed = true; return; }
  if (loop.timer) clearTimeout(loop.timer);
  loop.timer = null; loop.missed = false; loop.pending = true;
  const gen = s.gen, live = () => s.gen === gen && fpNow() === s.fp;
  void read(live).then(ok => {
    if (!live()) return;
    loop.pending = false;
    loop.fails = ok ? 0 : loop.fails + 1;
    loop.ok ||= ok;
    loop.timer = setTimeout(() => run(s, loop, read), !loop.ok && loop.fails <= RETRIES ? RETRY : POLL);
  });
}
const readDir = (s: Store) => () => readDirectory(s.fp);
function start(s: Store, onlyMissed = false) {
  const { dir, roster } = s.loops;
  if (!onlyMissed || dir.missed) run(s, dir, readDir(s));
  if (s.plan === "read" && (!onlyMissed || roster.missed)) run(s, roster, live => readRoster(s, live));
}
function subscribe(s: Store, cb: () => void) {
  s.subs.add(cb);
  if (!s.stop) {
    const onVisible = () => { if (document.visibilityState === "visible") start(s, true); };
    document.addEventListener("visibilitychange", onVisible);
    s.stop = () => { document.removeEventListener("visibilitychange", onVisible); reset(s); s.stop = null; };
    start(s);
  }
  return () => { s.subs.delete(cb); if (!s.subs.size) s.stop?.(); };
}

/** Machine, permission, the binding context and (for a team key) the local project; undefined local = mapping not known yet. */
function useReadiness(project: string) {
  const fp = useSyncExternalStore(subscribeFp, fpNow, () => null);
  const shared = sharedIdentity(project);
  const full = useFullScope(!shared);
  const subBindings = useCallback((cb: () => void) => fp ? subscribeBindings(fp, cb) : () => {}, [fp]);
  // The whole state, not "settled": a failed first context read settles with identities null, and its recovery must re-render.
  const binding = useSyncExternalStore(subBindings, () => fp ? bindingState(fp) : null, () => null);
  const ids = binding?.identities ?? null;
  // No guess from the key's center project id: the mapping is known once a context read lands (MachineGate records the machine first).
  const centered = !!fp && !!shared && machineCenterKey(fp, project);
  const local = !shared ? project || null : !centered ? null : ids !== null ? localProjectOf(project) : undefined;
  /** Whether this view has a team binding at all: null = context not read yet. */
  const bound = shared ? true : ids ? ids.some(i => (i.localProjectId ?? i.project) === project) : null;
  // A team key reads permission passively (no local contact query), so nothing guarantees an answer: no seat read and no spinner
  // until it is true (the read starts that moment); the reason says it is still being checked, unlike a refusal.
  const plan: Plan = local === null || full === false || (full === null && shared) ? "off" : local === undefined || full === null ? "wait" : "read";
  const reason = local === null ? "没有本机项目" : full === null && shared ? "正在确认位子权限" : "这台设备读不到位子";
  return { fp, shared, local, bound, plan, reason };
}
/** Only a read context without a binding, or a snapshot without the project, proves there is no team directory. */
function directoryStatus(dir: Part<ProjectSnapshot>, team: ProjectTeam | null, bound: boolean | null): LoadStatus {
  if (team) return team.directory ? "ready" : "error"; // Team present, directory unavailable (old bridge, degraded read): unknown.
  if (bound === false) return "ready";
  if (dir.status === "loading") return "loading";
  return dir.status === "ready" && bound === null ? "ready" : "error";
}

/** One roster read per machine/local project and permission, shared across simultaneous consumers; directory and seats publish separately. */
export function useTeamRoster(project: string) {
  const { fp, shared, local, bound, plan, reason } = useReadiness(project);
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
    const hit = snapshot?.projects.find(p => p.local?.id === project);
    if (hit) team = snapshot?.teams.find(t => t.centerId === hit.centerId && t.teamId === hit.teamId) ?? null;
  }
  const projects = snapshot?.projects.filter(p => p.local && p.centerId === team?.centerId && p.teamId === team?.teamId)
    .map(p => ({ localId: p.local!.id, name: p.name })) ?? [];
  return { roster: plan === "read" ? state.value : null, rosterLoading: state.status === "loading", directory: team?.directory ?? null,
    directoryStatus: fp ? directoryStatus(dir, team, bound) : "loading" as LoadStatus, selfPersonId: team?.personId ?? null,
    instances: team?.instances ?? null, projects, reason, teamName: team?.team?.name ?? null, snapshotReady: dir.status === "ready" };
}
