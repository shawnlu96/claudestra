/**
 * 回合以 API 错误结束 ⇒ 60s 无活动自动续跑一次（规则、判据见 lib/api-error-resume.ts）的接线：订阅事件 + 15s 定时器。
 * 从 bridge.ts 搬出来，在平台无关的初始化里起：以前写在 Discord ready 里，web-only 永远等不到 ready，API 错误从来不续跑。
 * 撞额度（CC 的 rate_limit、Codex 的 usage limit）不续跑：续了必然再撞，交给额度闸（isQuotaError）。
 * 续跑后再撞 ⇒ 升级：频道里发一条 bridge 通知（web 显示），Discord 频道另外 send 一条——web-only 的 local-* 频道以前没人知道。
 */
import type { ServerWebSocket } from "bun";
import { emitEvent, subscribeEvents } from "./event-bus.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";
import { countsAsActivity, dueForResume, isQuotaError, markResumed, noteActivity, noteApiError, resumeText, type ApiErrorState } from "../lib/api-error-resume.js";
import { recordMetric } from "../lib/metrics.js";

export interface ApiErrorResumeDeps {
  client(channelId: string): { ws: ServerWebSocket<unknown>; cwd?: string } | undefined;
  deliver(env: Envelope): Promise<unknown>;
  /** 续跑消息记成 agent 来源（完成通知不 @ 人） */
  markAgentSource(channelId: string): void;
  /** Discord 频道里发一条；web-only 没有 */
  discordSend?(channelId: string, text: string): Promise<void>;
}

function escalationText(agent: string, err: string): string {
  return `⛔ ${agent} 连续两次因 API 错误中断（自动续跑一次已用完，不再续）：${err || "API Error"}。需要人看一眼网络/代理后手动发一句继续。`;
}

export function startApiErrorResume(d: ApiErrorResumeDeps): void {
  const states = new Map<string, ApiErrorState>();
  subscribeEvents({}, (evt) => {
    const ts = Date.parse(evt.ts) || Date.now();
    if (evt.type === "api_error_turn") {
      const err = String((evt.data as { error?: unknown }).error ?? "");
      if (isQuotaError(err)) return void console.log(`⏸ 回合撞额度结束: ${evt.agent}（${err}）→ 不自动续跑，交给额度闸`);
      const r = noteApiError(states, evt.chatId, err, ts);
      console.log(`⚠️ 回合以 API 错误结束: ${evt.agent}（${err || "API Error"}）→ ${r === "track" ? "60s 后自动续跑" : "续跑后再撞，升级到频道"}`);
      recordMetric("api_error_turn", { agent: evt.agent, meta: { error: err, action: r } });
      if (r === "escalate") escalate(d, evt.agent, evt.chatId, err);
      return;
    }
    if (countsAsActivity(evt.type, evt.data)) noteActivity(states, evt.chatId, ts);
  });
  setInterval(() => resumeDue(d, states), 15_000);
}

function escalate(d: ApiErrorResumeDeps, agent: string, chatId: string, err: string): void {
  const text = escalationText(agent, err);
  emitEvent({ agent, chatId, type: "chat_message", data: { direction: "out", from: "bridge", text, notice: true } });
  if (/^\d+$/.test(chatId) && d.discordSend) {
    d.discordSend(chatId, text).catch((e) => console.error("api-error 升级通知失败:", (e as Error).message));
  }
}

function resumeDue(d: ApiErrorResumeDeps, states: Map<string, ApiErrorState>): void {
  const now = Date.now();
  for (const cid of dueForResume(states, now)) {
    const st = states.get(cid);
    const target = d.client(cid);
    if (!st || !target) { states.delete(cid); continue; }
    markResumed(states, cid, now);
    d.markAgentSource(cid);
    void d.deliver({
      from: { kind: "bridge", label: "api-error-resume" },
      to: { kind: "local", channelId: cid, ws: target.ws, cwd: target.cwd },
      intent: "notification",
      content: resumeText(st.error, st.errorAt),
      meta: { messageId: newMessageId("api_resume"), triggerKind: "bridge_synth", ts: new Date(now).toISOString(), threadId: newThreadId() },
    }).then(() => {
      console.log(`🔁 api-error-resume → ${cid}`);
      recordMetric("api_error_resume", { channelId: cid, meta: { error: st.error } });
    }).catch((e) => console.error("api-error-resume 投递失败:", (e as Error).message));
  }
}
