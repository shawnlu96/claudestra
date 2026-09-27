"use client";
import { useEffect, useSyncExternalStore } from "react";
import { hostInfo, openAgentDir, openProjectDir, type HostInfo } from "@/lib/api/system";

/**
 * 主机信息的客户端缓存（GET /api/v1/host，进应用后拉一次）：本次会话是不是本机打开的、能用哪些程序打开目录。
 * 非本机 → openers 为空，菜单里不出现任何「打开目录」项。独立小 store，不进 chat-store（那文件只许缩）。
 */
export type OpenerKind = HostInfo["openers"][number]["kind"];
export type Opener = HostInfo["openers"][number];
export type { HostInfo };

const NONE: HostInfo = { local: false, platform: "darwin", openers: [] };
let info: HostInfo = NONE;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

export function loadHostInfo(): Promise<void> {
  if (loading) return loading;
  loading = hostInfo()
    .then((j) => {
      info = j;
      subs.forEach((f) => f());
    })
    .catch(() => {
      loading = null; // 拉失败按「非本机」处理，下次挂载再试；菜单少一项不影响其他功能
    });
  return loading;
}

export function useHostInfo(): HostInfo {
  useEffect(() => {
    void loadHostInfo();
  }, []);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => info,
    () => NONE,
  );
}

/** 用本机程序打开会话目录 / project 目录（index = project 多目录时的下标）。只认回环，远端来的 403。 */
export async function openLocal(kind: "agent" | "project", key: string, target: string, index = 0): Promise<{ ok: boolean; error?: string }> {
  try {
    await (kind === "agent" ? openAgentDir(key, target) : openProjectDir(key, target, index));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 菜单用：按 kind 分组 */
export function groupOpeners(openers: Opener[]): Record<OpenerKind, Opener[]> {
  const g: Record<OpenerKind, Opener[]> = { files: [], terminal: [], ide: [] };
  for (const o of openers) g[o.kind].push(o);
  return g;
}
