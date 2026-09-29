/**
 * 「待你处理」（bridge local-api/asks.ts）：列表、卡片作答、网页可见性心跳；以及聊天里点按钮时带上 askId 的小抄。
 * 门是 canReadLedger：部分 scope 的设备 / guest 拿 403，调用方按「没有待办」处理。
 */
import type { WebAsk } from "@/features/asks/asks-model";
import { api } from "./client";
import { followEventStream } from "./ledger";

/**
 * 每行带 canAnswer（这个凭据能不能答这一条）；guest 只拿得到指给自己的。
 * 老 bridge 只给顶层一个 canAnswer：行上没有就用它（托管前端先升级时，guest 不该看到一点就 403 的按钮）
 */
export async function fetchAsks(signal?: AbortSignal): Promise<{ ok: boolean; asks: WebAsk[]; presence?: string; now: number }> {
  const r = await api<{ ok: boolean; asks: WebAsk[]; presence?: string; now: number; canAnswer?: boolean }>("/asks", { signal, timeoutMs: 10_000 });
  return typeof r.canAnswer === "boolean" ? { ...r, asks: r.asks.map((a) => ({ ...a, canAnswer: a.canAnswer ?? r.canAnswer })) } : r;
}

/**
 * 卡片作答：choices = 回投 wire（[button:id] / [select:id:v1,v2]），text = 文本框里的话；卡片是一次提交，bridge 按全部答完结案。
 * 只给 reply 类用（运行时弹框走 answerAuq / answerPermission）。409 = 已被别处处理 / 已过期
 */
export function answerAskCard(project: string, id: string, body: { choices?: string[]; text?: string }): Promise<{ ok: boolean }> {
  return api(`/ledger/${encodeURIComponent(project)}/asks/${encodeURIComponent(id)}/answer`, { method: "POST", json: body, timeoutMs: 15_000 });
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

/** 侧栏「待你处理」的轻量事件流：bridge 只推 ask 事件（?types=ask），收到就重拉列表 */
export function followAskEvents(opts: { signal: AbortSignal; onOpen: () => void; onAsk: () => void }): Promise<void> {
  return followEventStream("/events?types=ask", { signal: opts.signal, onOpen: opts.onOpen, onEvent: (e) => e.type === "ask" && opts.onAsk() });
}
