/**
 * 会话内的动作（此前 BFF chat/* 路由）：发消息（含 multipart 附件，直接打 bridge 的 messages 端点）、中断、清空、
 * 权限 / AUQ 应答、skills / tasks、全局搜索、消息隐藏。形状与 chat-store / 组件既有约定一致。
 */
import { apiAgentName, uiAgentName } from "@/lib/chat/agents";
import { takeAskHint } from "./asks";
import { api } from "./client";
import { invalidateHidden } from "./history";

const enc = (agent: string) => encodeURIComponent(apiAgentName(agent));

export interface SendResult {
  /** bridge 走了 tmux 直通（CC 原生解释，无常规回合）——前端据此不进「正在回复」态 */
  slash?: boolean;
  ccText?: string;
}

/** 投递一条用户消息（fire-and-forget，wait=0）。带附件走 multipart（text + files[]，bridge 落 inbox 并注入路径）。 */
export function sendMessage(agent: string, text: string, files: File[] | undefined, signal: AbortSignal): Promise<SendResult> {
  if (files?.length) {
    const fd = new FormData();
    fd.append("text", text);
    fd.append("wait", "0");
    for (const f of files) fd.append("files", f);
    return api<SendResult>(`/agents/${enc(agent)}/messages`, { method: "POST", body: fd, signal, timeoutMs: 0 });
  }
  const ask = takeAskHint(agent, text); // 气泡里点的按钮：告诉 bridge 答的是哪条「待你处理」
  return api<SendResult>(`/agents/${enc(agent)}/messages${ask ? `?ask=${encodeURIComponent(ask)}` : ""}`, { method: "POST", json: { text, wait: 0 }, signal, timeoutMs: 0 });
}

/** 一键中断：tmux C-c（master → master:0） */
export function interruptAgent(agent: string): Promise<{ ok: boolean; agent?: string }> {
  return api(`/agents/${enc(agent)}/interrupt`, { method: "POST", json: {}, timeoutMs: 10_000 });
}

/** 清空会话：bridge 打原生 /clear + 后台轮转；回合进行中 409 */
export function clearAgentSession(agent: string): Promise<{ ok: boolean }> {
  return api(`/agents/${enc(agent)}/clear`, { method: "POST", json: {}, timeoutMs: 15_000 });
}

const PERM_ACTION: Record<string, string> = { perm_allow: "allow", perm_allow_session: "allow_session", perm_deny: "deny", allow: "allow", allow_session: "allow_session", deny: "deny" };

/** 应答权限卡；session-idle 应答已随迁移移除（不认识的 action 直接报） */
export function answerPermission(agent: string, action: string): Promise<{ ok: boolean }> {
  const mapped = PERM_ACTION[action];
  if (!mapped) return Promise.reject(new Error(`不支持的 action: ${action}`));
  return api(`/agents/${enc(agent)}/answer`, { method: "POST", json: { kind: "permission", action: mapped }, timeoutMs: 15_000 });
}

/** 应答 AskUserQuestion：submit(selections[][]) 或 cancel */
export function answerAuq(agent: string, action: "submit" | "cancel", selections: number[][] = []): Promise<{ ok: boolean }> {
  return api(`/agents/${enc(agent)}/answer`, { method: "POST", json: { kind: "auq", action, selections }, timeoutMs: 15_000 });
}

export interface SlashCmdInfo {
  name: string;
  description: string;
  [k: string]: unknown;
}

/** 某 agent 可用的 slash 命令（builtin + 全局 skill + 项目 skill） */
export function agentSkills<T = SlashCmdInfo>(agent: string): Promise<T[]> {
  return api<{ commands?: T[] }>(`/agents/${enc(agent)}/skills`, { timeoutMs: 8000 }).then((r) => (Array.isArray(r.commands) ? r.commands : []));
}

/** Claude Code 原生任务清单（TaskCreate 落盘文件） */
export function agentTasks<T>(agent: string): Promise<T[]> {
  return api<{ tasks?: T[] }>(`/agents/${enc(agent)}/tasks`, { timeoutMs: 8000 }).then((r) => r.tasks ?? []);
}

export interface SearchHit {
  agent: string;
  sessionId: string;
  source: string;
  seq: number;
  ts: string | null;
  role: string;
  snippet: string;
  from?: string;
  compact?: boolean;
}

/** 聊天记录全局搜索（跨 agent 跨 session，live+归档）；agent 限定为会话内搜索。agent 名映射回前端会话名 */
export async function searchHistory(q: string, agent?: string): Promise<SearchHit[]> {
  const agentQ = agent ? `&agent=${encodeURIComponent(apiAgentName(agent))}` : "";
  const r = await api<{ hits?: SearchHit[] }>(`/history/search?q=${encodeURIComponent(q)}&limit=30${agentQ}`, { timeoutMs: 30_000 });
  return (r.hits || []).map((h) => ({ ...h, agent: uiAgentName(h.agent) }));
}

/** 消息「删除」= 跨设备隐藏（按 session + 原始记录 seq 区间）；hide=false 撤销 */
export async function setHidden(agent: string, sessionId: string, fromSeq: number, toSeq: number, hide: boolean): Promise<void> {
  await api(`/agents/${enc(agent)}/hidden`, { method: "POST", json: { sessionId, fromSeq, toSeq, hide }, timeoutMs: 10_000 });
  invalidateHidden(agent);
}
