/**
 * 机器级端点：主机信息与本机打开目录（只认回环）、用量看板、中继状态 / 配对码、手机访问、peer / cron / project 管理、
 * 会话清单与归档、后台任务（升级 / 全体重启）、语音转写、client-log。BFF 时代的 {data} 包装在这里还原成组件既有形状。
 */
import { api, apiRaw, DEVICE_HEADER, type ApiError } from "./client";

// ── 主机 / 打开目录 ──
export interface HostInfo {
  local: boolean;
  platform: "darwin" | "linux" | "win32";
  openers: { id: string; label: string; kind: "files" | "terminal" | "ide" }[];
}
export function hostInfo(): Promise<HostInfo> {
  return api<Partial<HostInfo>>("/host", { timeoutMs: 8000 }).then((j) => ({
    local: j.local === true,
    platform: j.platform ?? "darwin",
    openers: j.local && Array.isArray(j.openers) ? j.openers : [],
  }));
}
export function openAgentDir(name: string, target: string): Promise<{ ok: true; dir?: string }> {
  return api(`/agents/${encodeURIComponent(name)}/open`, { method: "POST", json: { with: target }, timeoutMs: 20_000 });
}
export function openProjectDir(id: string, target: string, index: number): Promise<{ ok: true; dir?: string }> {
  return api(`/projects/${encodeURIComponent(id)}/open`, { method: "POST", json: { with: target, index }, timeoutMs: 20_000 });
}

// ── 用量看板：?refresh=1 强制重抓账号 gauge（最长 ~20s）──
export function stats<T>(refresh: boolean): Promise<T> {
  return api<T>(`/stats${refresh ? "?refresh=1" : ""}`, { timeoutMs: refresh ? 30_000 : 8000 });
}

// ── 中继（Peer 面板的中继卡）──
export function relayStatus<T>(): Promise<T> {
  return api<T>("/relay/status", { timeoutMs: 5000 });
}
export function relayPairNew<T>(): Promise<T> {
  return api<T>("/relay/pair", { method: "POST", json: {}, timeoutMs: 5000 });
}

// ── 手机访问面板（探测要起子进程 + TLS 握手，bridge 缓存 60s）──
export function remoteAccess<T>(fresh: boolean): Promise<T> {
  return api<T>(`/remote-access${fresh ? "?fresh=1" : ""}`, { timeoutMs: 15_000 });
}

// ── peers：GET 清单；POST {action, …} 分发到 bridge 的各端点（与 BFF 同一张表）──
export function peersList<T>(): Promise<T> {
  return api<T>("/peers", { timeoutMs: 10_000 });
}
const NAMELESS = new Set(["invite-new", "join-auto", "invite-revoke", "tidy", "inspect"]);
export function peersAction<T>(body: Record<string, unknown> & { action?: string; name?: string }): Promise<T> {
  const { action, name } = body;
  if (!action) return Promise.reject(new Error("action 不能为空"));
  const safeName = typeof name === "string" ? name.trim() : "";
  if (!NAMELESS.has(action) && !safeName) return Promise.reject(new Error("name 不能为空"));
  const e = encodeURIComponent(safeName);
  const post = (path: string, json: unknown, timeoutMs = 60_000) => api<T>(path, { method: "POST", json, timeoutMs });
  switch (action) {
    case "invite-new":
      return post("/peers/invite-new", { agents: body.agents, url: body.url, force: body.force });
    case "join-auto":
      return post("/peers/join-auto", { invite: body.invite, agents: body.agents, url: body.url, force: body.force }, 25_000);
    case "invite-revoke":
      return post("/peers/invite-revoke", { id: body.id });
    case "tidy":
      return post("/peers/tidy", {});
    case "inspect":
      return post("/peers/inspect", { invite: body.invite }, 15_000);
    case "invite":
    case "join":
    case "accept":
      return post(`/peers/${action}`, { name: safeName, agents: body.agents, url: body.url, invite: body.invite, receipt: body.receipt, force: body.force, rotate: body.rotate });
    case "test":
      return post(`/peers/${e}/test`, {}, 20_000);
    case "scope":
      return post(`/peers/${e}/scope`, { agents: body.agents, force: body.force });
    case "remove":
      return post(`/peers/${e}/remove`, {});
  }
  return Promise.reject(new Error(`未知 action: ${action}`));
}

// ── cron：GET 清单；POST {action:add|toggle|remove|edit, id?, …} ──
export function cronList<T>(): Promise<T> {
  return api<T>("/cron", { timeoutMs: 10_000 });
}
export function cronAction<T>(body: Record<string, unknown> & { action?: string; id?: string }): Promise<T> {
  const { action, id } = body;
  if (action === "add") return api<T>("/cron", { method: "POST", json: body });
  if (action === "toggle" || action === "remove" || action === "edit") {
    if (!id) return Promise.reject(new Error("id 不能为空"));
    return api<T>(`/cron/${encodeURIComponent(id)}/${action}`, { method: "POST", json: body });
  }
  return Promise.reject(new Error(`未知 action: ${action}`));
}

// ── projects：GET 清单；POST {action:add|edit|remove|assign, …} 委托 manager CLI ──
export function projectsList<T>(): Promise<T> {
  return api<T>("/projects", { timeoutMs: 10_000 });
}
export function projectsAction<T>(body: Record<string, unknown>): Promise<T> {
  return api<T>("/projects", { method: "POST", json: body });
}

// ── 会话清单（含未纳管）/ 单会话历史 / 处置 / 归档 ──
export function sessionList<T>(): Promise<{ count: number; sessions: T[] }> {
  return api<{ count?: number; sessions?: T[] }>("/session-list", { timeoutMs: 25_000 }).then((j) => ({ count: j.count ?? 0, sessions: j.sessions ?? [] }));
}
export function sessionHistory<T>(sessionId: string, qs: URLSearchParams): Promise<T> {
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return api<T>(`/sessions/${encodeURIComponent(sessionId)}/history${suffix}`, { timeoutMs: 25_000 });
}
export function sessionManage<T>(sessionId: string, body: { action: "archive" | "delete"; runtime?: string; cwd?: string }): Promise<T> {
  return api<T>(`/sessions/${encodeURIComponent(sessionId)}/manage`, { method: "POST", json: body });
}
export function archivedList<T>(): Promise<T[]> {
  return api<{ entries?: T[] }>("/sessions/archived", { timeoutMs: 8000 }).then((j) => j.entries ?? []);
}
export function archivedRestore(id: string): Promise<Record<string, unknown>> {
  return api(`/sessions/archived/${encodeURIComponent(id)}/restore`, { method: "POST", json: {} });
}

// ── 后台任务（升级 / 全体重启）：POST 点火回 202 + runId；GET /log?run= 只回本轮 ──
export type JobKind = "update" | "restart-all";
export function jobStart<T>(kind: JobKind): Promise<T> {
  return api<T>(`/${kind}`, { method: "POST", json: kind === "restart-all" ? { includeMaster: true } : {}, timeoutMs: 30_000 });
}
export function jobLog<T>(kind: JobKind, runId?: string | null): Promise<T> {
  return api<T>(`/${kind}/log?tail=40${runId ? `&run=${runId}` : ""}`, { timeoutMs: 8000 });
}

// ── 语音转写（multipart audio，≤20MB）；没配 key bridge 回 501 ──
export function transcribe(blob: Blob, filename: string): Promise<{ text?: string }> {
  const fd = new FormData();
  fd.append("audio", blob, filename);
  return api("/transcribe", { method: "POST", body: fd, timeoutMs: 45_000 });
}

/** 会话文件不在磁盘上（404）与其它错误的文案分流 */
export function sessionHistoryError(e: unknown, zh: boolean): string {
  const err = e as ApiError;
  if (err?.status === 404) return zh ? "会话文件已不在磁盘上" : "Session file is gone from disk";
  return `${zh ? "读取历史失败" : "History read failed"}: ${err?.message ?? String(e)}`;
}

/** 前端排障打点：fire-and-forget，keepalive 让页面卸载中也发得出去（api() 不支持 keepalive，这里直接 fetch） */
export function postClientLogLine(base: string, msg: string): void {
  try {
    void fetch(`${base}/api/v1/client-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [DEVICE_HEADER]: "1" },
      body: JSON.stringify({ lines: [msg] }),
      credentials: "include",
      keepalive: true,
    }).catch(() => {}); // 打点丢了就丢了，不能反过来影响主流程
  } catch {
    /* fetch 本身不可用（极老 WebView）：同上 */
  }
}

/** 直接取原始响应（附件之外别处不用）——留给终端流之类要看状态码的调用方 */
export { apiRaw };
