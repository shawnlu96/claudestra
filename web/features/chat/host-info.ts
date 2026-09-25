"use client";
import { useEffect, useSyncExternalStore } from "react";

/**
 * 主机信息的客户端缓存（/api/host，登录后拉一次）：本次会话是不是本机打开的、能用哪些程序打开目录。
 * 非本机 → openers 为空，菜单里不出现任何「打开目录」项。独立小 store，不进 chat-store（那文件只许缩）。
 */
export type OpenerKind = "files" | "terminal" | "ide";
export interface Opener {
  id: string;
  label: string;
  kind: OpenerKind;
}
export interface HostInfo {
  local: boolean;
  platform: "darwin" | "linux" | "win32";
  openers: Opener[];
}

const NONE: HostInfo = { local: false, platform: "darwin", openers: [] };
let info: HostInfo = NONE;
let loading: Promise<void> | null = null;
const subs = new Set<() => void>();

export function loadHostInfo(): Promise<void> {
  if (loading) return loading;
  loading = fetch("/api/host")
    .then((r) => (r.ok ? (r.json() as Promise<HostInfo>) : Promise.reject(new Error(String(r.status)))))
    .then((j) => {
      info = j.local ? j : { ...j, openers: [] };
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

/** 用本机程序打开会话目录 / project 目录（index = project 多目录时的下标）。 */
export async function openLocal(
  kind: "agent" | "project",
  key: string,
  target: string,
  index = 0,
): Promise<{ ok: boolean; error?: string }> {
  const url = kind === "agent" ? "/api/agents/open" : "/api/projects/open";
  const body = kind === "agent" ? { name: key, target } : { id: key, target, index };
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}) /* 回包不是 JSON（代理错误页之类）：按空处理，用状态码报错 */)) as { error?: string };
    return r.ok ? { ok: true } : { ok: false, error: j.error || String(r.status) };
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
