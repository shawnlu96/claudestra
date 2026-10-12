import type { DigestMode } from "./pm-digest.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync } from "./state-file.js";

interface Modes { projects?: Record<string, DigestMode>; routeProjects?: Record<string, DigestMode> }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const valid = (v: unknown): boolean => object(v) && (v.projects === undefined || object(v.projects))
  && (v.routeProjects === undefined || object(v.routeProjects));

export function pmRouteMode(path: string, project: string): DigestMode {
  const r = readJsonStateSync(path, valid);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "pm-route");
  const mode = r.status === "ok" ? (r.data as Modes).routeProjects?.[project] : undefined;
  return mode === "off" || mode === "on" ? mode : "observe";
}

export function setPmRouteMode(path: string, project: string, mode: DigestMode): void {
  const r = readJsonStateSync(path, valid);
  if (r.status === "corrupt") throw new StateCorruptError(path, r.error);
  const v = (r.status === "ok" ? r.data : {}) as Modes;
  writeJsonAtomicSync(path, { ...v, routeProjects: { ...v.routeProjects, [project]: mode } });
}

/** 旧 PMDIG off 没有配置独立分流时，不新建只属于分流的记录。 */
export function pmRouteConfigured(path: string, project: string): boolean {
  const r = readJsonStateSync(path, valid);
  const mode = r.status === "ok" ? (r.data as Modes).routeProjects?.[project] : undefined;
  return mode === "on" || mode === "observe" || mode === "off";
}
