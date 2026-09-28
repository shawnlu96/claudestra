/**
 * 「待你处理」（bridge local-api/asks.ts）：列表、卡片作答、网页可见性心跳；以及聊天里点按钮时带上 askId 的小抄。
 * 门是 canReadLedger：部分 scope 的设备 / guest 拿 403，调用方按「没有待办」处理。
 */
import type { WebAsk } from "@/features/asks/asks-model";
import { api } from "./client";

export function fetchAsks(signal?: AbortSignal): Promise<{ ok: boolean; asks: WebAsk[]; presence?: string; now: number }> {
  return api("/asks", { signal, timeoutMs: 10_000 });
}

/** 卡片作答：choices = 回投 wire（[button:id] / [select:id:v1,v2]），text = 文本框里的话。409 = 已被别处处理 / 已过期 */
export function answerAskCard(project: string, id: string, choices: string[], text: string): Promise<{ ok: boolean }> {
  return api(`/ledger/${encodeURIComponent(project)}/asks/${encodeURIComponent(id)}/answer`, { method: "POST", json: { choices, text }, timeoutMs: 15_000 });
}

export function postPresence(visible: boolean): Promise<unknown> {
  return api("/presence", { method: "POST", json: { visible }, timeoutMs: 10_000 });
}

/**
 * 聊天气泡里点按钮时，气泡知道它对应哪条 ask，但发送走的是普通的 messages 端点（chat-store.send）。
 * 点之前在这里记一笔 wire → askId，sendMessage 发同一条 wire 时带上 ?ask=，bridge 就不用按「最新一条开着的」去猜。
 */
const hints = new Map<string, { askId: string; at: number }>();
const key = (agent: string, wire: string) => `${agent}\n${wire}`;

export function hintAskForWire(agent: string, wire: string, askId: string): void {
  hints.set(key(agent, wire), { askId, at: Date.now() });
}

/** 取走（一次性）；10 秒内的才算——防止很久以后手打同样的 wire 被错挂到旧 ask 上 */
export function takeAskHint(agent: string, wire: string): string | null {
  const k = key(agent, wire);
  const h = hints.get(k);
  hints.delete(k);
  return h && Date.now() - h.at < 10_000 ? h.askId : null;
}

/** SSE 里的 ask 事件（agent 流按会话过滤之前先截下来）→ 窗口事件，asks-store 收到就重拉 */
export const ASK_EVENT = "cstra-ask";
export function notifyAskEvent(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ASK_EVENT));
}
