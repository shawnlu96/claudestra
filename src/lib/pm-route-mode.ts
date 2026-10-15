import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireLock } from "./file-lock.js";
import type { DigestMode } from "./pm-digest.js";
import { readJsonStateSync, reportCorrupt, StateCorruptError, writeJsonAtomicSync } from "./state-file.js";

interface Modes { projects?: Record<string, DigestMode>; routeProjects?: Record<string, DigestMode>; pullProjects?: Record<string, PullMode> }
export type PullMode = "on" | "off";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const valid = (v: unknown): boolean => object(v) && (v.projects === undefined || object(v.projects))
  && (v.routeProjects === undefined || object(v.routeProjects)) && (v.pullProjects === undefined || object(v.pullProjects));

export function pmRouteMode(path: string, project: string): DigestMode {
  const r = readJsonStateSync(path, valid);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "pm-route");
  const mode = r.status === "ok" ? (r.data as Modes).routeProjects?.[project] : undefined;
  return mode === "off" || mode === "on" ? mode : "observe";
}

/**
 * pm-digest-mode.json 的读改写都在这把锁里（agents-PULLTODO1；路由 / 拉取 / 摘要三个开关的 setter 共用，锁文件与它同目录）：
 * 拿不到按 file-lock 的等待上限报错、不写，不退回裸写。
 */
export async function withModeLock<T>(path: string, fn: () => T, waitMs?: number): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = join(dirname(path), `${basename(path)}.lock`);
  const lock = await acquireLock(lockPath, waitMs);
  if (!lock) throw new Error(`拿不到 ${lockPath} 的锁（别的进程一直占着），开关没改`);
  try {
    if (!lock.held()) throw new Error(`${lockPath} 的锁已失租，开关没改`);
    return fn();
  } finally { lock.release(); }
}

export function setPmRouteMode(path: string, project: string, mode: DigestMode): Promise<void> {
  return withModeLock(path, () => {
    const r = readJsonStateSync(path, valid);
    if (r.status === "corrupt") throw new StateCorruptError(path, r.error);
    const v = (r.status === "ok" ? r.data : {}) as Modes;
    writeJsonAtomicSync(path, { ...v, routeProjects: { ...v.routeProjects, [project]: mode } });
  });
}

/** 旧 PMDIG off 没有配置独立分流时，不新建只属于分流的记录。 */
export function pmRouteConfigured(path: string, project: string): boolean {
  const r = readJsonStateSync(path, valid);
  const mode = r.status === "ok" ? (r.data as Modes).routeProjects?.[project] : undefined;
  return mode === "on" || mode === "observe" || mode === "off";
}

/**
 * 摘要队列只供 PM 拉取（pullProjects，缺省 on）：可合并的常规推送只记账，PM 用 `ledger pm-digest --list` 按需看；
 * 不搭在别的消息前面送、也不按窗口单独送。off 回到旧的推送摘要。文件损坏按缺省 on（不推比多推安全：条目都还在队里能拉）。
 */
export function pmDigestPull(path: string, project: string): PullMode {
  const r = readJsonStateSync(path, valid);
  if (r.status === "corrupt") reportCorrupt(path, r.error, "pm-digest");
  return r.status === "ok" && (r.data as Modes).pullProjects?.[project] === "off" ? "off" : "on";
}

export function setPmDigestPull(path: string, project: string, mode: PullMode): Promise<void> {
  return withModeLock(path, () => {
    const r = readJsonStateSync(path, valid);
    if (r.status === "corrupt") throw new StateCorruptError(path, r.error);
    const v = (r.status === "ok" ? r.data : {}) as Modes;
    writeJsonAtomicSync(path, { ...v, pullProjects: { ...v.pullProjects, [project]: mode } });
  });
}
