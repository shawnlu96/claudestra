/**
 * 会话内的动作（此前 BFF chat/* 路由）：发消息（含 multipart 附件，直接打 bridge 的 messages 端点）、中断、清空、
 * 权限 / AUQ 应答、skills / tasks、全局搜索、消息隐藏。形状与 chat-store / 组件既有约定一致。
 */
import { apiAgentName, uiAgentName } from "@/lib/chat/agents";
import { takeAskHint } from "./asks";
import { api, ApiError } from "./client";
import { t } from "@/lib/i18n";
import { invalidateHidden } from "./history";

const enc = (agent: string) => encodeURIComponent(apiAgentName(agent));

export interface SendResult {
  /** bridge 走了 tmux 直通（CC 原生解释，无常规回合）——前端据此不进「正在回复」态 */
  slash?: boolean;
  ccText?: string;
  /** bridge 押住了、没有回合（额度闸 / 目标停在额度菜单，只给全权 owner 设备；别人只拿到 queued） */
  heldBy?: "quota_wall" | "wall_menu";
  /** 押住了但不告诉原因（非全权设备 / guest：额度是 owner 的事）：同样没有回合 */
  queued?: boolean;
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

/**
 * 一键中断。bridge 最坏要等约 16 秒（打断间隔 + Esc 窗口锁 12 秒 + 锁内 1.2 秒）才回结果，等不到锁会如实回失败；
 * 这里要等得比它久、又短于 bridge 的 HTTP 空闲上限 30 秒（src/lib/esc-guard.ts HTTP_IDLE_TIMEOUT_S），不然只能看到超时
 */
export function interruptAgent(agent: string): Promise<{ ok: boolean; agent?: string }> {
  return api(`/agents/${enc(agent)}/interrupt`, { method: "POST", json: {}, timeoutMs: 20_000 });
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

/** bridge 带了已知 code 的发送失败，按当前界面语言说（字典在 lib/i18n-dict.ts）；其余用 bridge 的原始 error */
const SEND_ERROR_TEXT: Record<string, string> = {
  slash_owner_only: "斜杠命令只有 owner 能用，请直接发文字", // bridge/api-slash.ts：guest / scoped token 发了会直通的斜杠命令
};

export function sendErrorText(e: unknown): string {
  const zh = e instanceof ApiError && e.code ? SEND_ERROR_TEXT[e.code] : undefined;
  return zh ? t(zh) : (e as Error).message;
}
