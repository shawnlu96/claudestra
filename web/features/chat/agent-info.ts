"use client";
import { useSyncExternalStore } from "react";

/**
 * 「会话详情」弹窗的打开状态（哪个 agent）+ 数据访问（owner 2026-09-27）。独立小 store，同 host-info.ts 的做法，
 * 不进 chat-store（那文件只许缩）。三个入口共用：侧栏右键「详情」、顶栏 ⓘ、Peer 面板里未开闸 agent 旁的按钮。
 */
export interface AgentInfo {
  name: string;
  displayName: string | null;
  purpose: string;
  cwd: string | null;
  status: string | null;
  sessionId: string | null;
  channelId: string | null;
  projectId: string | null;
  runtime: string;
  model: string | null;
  effort: string | null;
  created: string | null;
  external: boolean;
  /** 正把它放在 scope 里的 peer 名 */
  sharedWith: string[];
}

let target: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function openAgentInfo(name: string): void {
  target = name;
  emit();
}
export function closeAgentInfo(): void {
  target = null;
  emit();
}
export function useAgentInfoTarget(): string | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => target,
    () => null,
  );
}

type Res<T> = { ok: true; data: T } | { ok: false; error: string; needConfirm?: boolean; sharedWith?: string[] };

async function call<T>(input: RequestInfo, init?: RequestInit): Promise<Res<T>> {
  try {
    const r = await fetch(input, init);
    const j = (await r.json().catch(() => ({}) /* 非 JSON 回包（代理错误页）：按空处理，用状态码报错 */)) as Record<string, unknown>;
    if (r.ok && j.ok !== false) return { ok: true, data: j as T };
    return { ok: false, error: String(j.error || r.status), needConfirm: j.needConfirm === true, sharedWith: Array.isArray(j.sharedWith) ? (j.sharedWith as string[]) : undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function fetchAgentInfo(name: string): Promise<Res<{ agent: AgentInfo }>> {
  return call(`/api/agents/info?name=${encodeURIComponent(name)}`);
}

/** 关闭且正在共享时后端要 confirm=会话名，否则回 409 needConfirm（前端据此弹输入确认框）。
 *  stillSharedWith = 持全量 "*" 授权、关了闸门仍能访问的 peer（要去 Peer 面板改 scope）。 */
export function setAgentExternal(name: string, on: boolean, confirm?: string): Promise<Res<{ removedFromPeers?: string[]; stillSharedWith?: string[] }>> {
  return call("/api/agents/external", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, on, confirm }) });
}
