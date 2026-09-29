/**
 * bridge 这一头的 ACP 宿主接线（T60，宿主在 src/acp-host.ts）。宿主发来的帧（bridge.ts 一行分派到 onAcpFrame）：
 * - acp_entries：CC 形状的流式条目 → jsonl-watcher 的推送模式，工具 / 正文 / 状态事件和尾读 rollout 时一样发；带 requestId 的
 *   （回合末最后一批）处理完再回包，宿主等到回包才报 Stop，Stop 的 drain 就看得到收尾文字；
 * - acp_config：会话的 configOptions，存一份给设置页（不重启切模型 / 推理强度）和额度卡用；
 * - acp_failure：额度 → 「待你处理」卡，第一个选项是「等重置」，后面只列 configOptions 里的其它模型，不推荐（owner 的规矩），
 *   点了才经宿主调 set_config_option，绝不自动选；没登录 → 「需要 owner 登录」卡，宿主接上线程后自动结掉；其它失败只有条目；
 * - acp_permission：权限请求 → 卡，owner 点了按 requestId 回给宿主（取消 / 超时由宿主按 cancelled 回适配器）。
 * 只认这个频道当前登记的那条连接发来的帧。tests/acp-link.test.ts。
 */
import type { Client } from "discord.js";
import { parseConfigOptions, quotaCardChoices, type ConfigOption, type QuotaChoice } from "../lib/acp/config.js";
import type { AcpFailure } from "../lib/acp/failures.js";
import type { PermissionCard } from "../lib/acp/permissions.js";
import { apiJson } from "./api-respond.js";
import { openRuntimeAsk, settleRuntimeAsk } from "./ask-runtime.js";
import { agentNameForChannel, pushEntries } from "./jsonl-watcher.js";
import { extensionSocketOf } from "./pi-abort.js";

type Socket = { send(data: string): void };
type Who = { principal?: string; device?: string };

const configs = new Map<string, ConfigOption[]>();
const quotaCards = new Map<string, QuotaChoice[]>();
const authCards = new Set<string>();
const permissionCards = new Map<string, { requestId: string; ws: Socket; card: PermissionCard }>();
const calls = new Map<string, { resolve: (r: { ok: boolean; error?: string }) => void; timer: ReturnType<typeof setTimeout> }>();
let nextCall = 0;
const CALL_TIMEOUT_MS = 15_000;

const QUOTA_PREFIX = "acp_quota_";
const PERM_PREFIX = "acp_perm_";

export const acpConfigOf = (channelId: string): ConfigOption[] => configs.get(channelId) ?? [];

export async function onAcpFrame(msg: Record<string, any>, ws: Socket, discord: Client): Promise<void> {
  const channelId = String(msg.channelId ?? "");
  if (!channelId || extensionSocketOf(channelId) !== ws) return void console.warn(`⚠️ 丢掉一帧 ${msg.type}：不是频道 ${channelId || "?"} 当前登记的宿主发的`);
  switch (msg.type) {
    case "acp_entries": {
      const ok = await pushEntries(channelId, Array.isArray(msg.entries) ? msg.entries : [], discord);
      if (typeof msg.requestId === "string") ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: ok }));
      return;
    }
    case "acp_config":
      configs.set(channelId, parseConfigOptions(msg.configOptions));
      if (authCards.delete(channelId)) settleRuntimeAsk("codex", channelId); // 登好了、接上线程了：登录卡结掉
      return;
    case "acp_failure":
      return onFailure(channelId, msg.failure as AcpFailure, msg.configOptions);
    case "acp_permission":
      return onPermission(channelId, ws, String(msg.requestId ?? ""), msg.card as PermissionCard);
    case "acp_call_result": {
      const c = calls.get(String(msg.id));
      if (c) calls.delete(String(msg.id)), clearTimeout(c.timer), c.resolve(msg.ok ? { ok: true } : { ok: false, error: String(msg.error ?? "宿主拒绝") });
      if (msg.ok && msg.configOptions) configs.set(channelId, parseConfigOptions(msg.configOptions));
      return;
    }
  }
}

function onFailure(channelId: string, f: AcpFailure, rawConfig: unknown): void {
  const agentName = agentNameForChannel(channelId) ?? channelId;
  if (f?.kind === "quota") {
    const opts = parseConfigOptions(rawConfig);
    const choices = quotaCardChoices(opts.length ? opts : acpConfigOf(channelId));
    quotaCards.set(channelId, choices);
    const buttons = choices.map((c, i) => ({ id: `${QUOTA_PREFIX}${i}`, label: c.label, style: c.value === null ? "secondary" : "primary" }));
    void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "decide", title: "Codex 额度用完了", context: f.message, quota: true, acp: true, options: [{ type: "buttons", buttons }] });
  } else if (f?.kind === "auth") {
    authCards.add(channelId);
    const context = "在这台机器的终端里跑一次 `codex login`（或设好 API key）。登好之后宿主每分钟自动重试，接上线程后这张卡自己结掉。";
    void openRuntimeAsk({ source: "codex", channelId, agentName, kind: "owner_action", title: "Codex 需要 owner 登录", context, options: [] });
  }
}

function onPermission(channelId: string, ws: Socket, requestId: string, card: PermissionCard): void {
  if (!requestId || !card?.options?.length) return;
  permissionCards.set(channelId, { requestId, ws, card });
  const buttons = card.options.map((o) => ({ id: `${PERM_PREFIX}${o.id}`, label: o.label, style: o.style }));
  const agentName = agentNameForChannel(channelId) ?? channelId;
  void openRuntimeAsk({ source: "permission", channelId, agentName, kind: "authorize", title: card.title, context: card.detail, acp: true, options: [{ type: "buttons", buttons }] });
}

/** 经宿主调 session/set_config_option（设置页的模型 / 推理强度、额度卡的「切到 X」）：不重启 */
export const acpSetConfig = (channelId: string, configId: string, value: string) => acpCall(channelId, { op: "set_config", configId, value });

/** 斜杠命令（/compact 等）原样当一轮 prompt 交给宿主：不包 <channel>，适配器自己认（lib/runtimes/codex.ts CODEX_ACP_CONTROL.slashAsPrompt） */
export const acpSlash = (channelId: string, text: string) => acpCall(channelId, { op: "slash", text });

function acpCall(channelId: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const ws = extensionSocketOf(channelId);
  if (!ws) return Promise.resolve({ ok: false, error: "ACP 宿主不在线" });
  const id = `acpcall_${++nextCall}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => (calls.delete(id), resolve({ ok: false, error: "宿主没回应（15s）" })), CALL_TIMEOUT_MS);
    calls.set(id, { resolve, timer });
    ws.send(JSON.stringify({ type: "acp_call", id, ...body }));
  });
}

/** POST /agents/:name/answer {kind:"acp", action} 的响应（作答人记凭据，和权限卡一样） */
export async function answerAcpResponse(channelId: string, body: any, principal: { id: string; credential?: string }): Promise<Response> {
  const r = await answerAcp(channelId, String(body?.action || ""), { principal: principal.id, device: principal.credential });
  return apiJson(r.status, r.body);
}

/** 卡上的按钮：返回 HTTP 状态 + 响应体 */
export async function answerAcp(channelId: string, action: string, who: Who): Promise<{ status: number; body: Record<string, unknown> }> {
  if (action.startsWith(QUOTA_PREFIX)) {
    const choice = quotaCards.get(channelId)?.[Number(action.slice(QUOTA_PREFIX.length))];
    if (!choice) return { status: 409, body: { ok: false, code: "ask_stale", error: "这张额度卡已经处理过或过期了" } };
    if (choice.value !== null) {
      const r = await acpSetConfig(channelId, "model", choice.value);
      if (!r.ok) return { status: 409, body: { ok: false, error: `没切成：${r.error}` } };
    }
    quotaCards.delete(channelId);
    settleRuntimeAsk("codex", channelId, "interact", choice.label, who);
    return { status: 200, body: { ok: true, model: choice.value } };
  }
  if (action.startsWith(PERM_PREFIX)) {
    const p = permissionCards.get(channelId);
    const optionId = action.slice(PERM_PREFIX.length);
    const opt = p?.card.options.find((o) => o.id === optionId);
    if (!p || !opt) return { status: 409, body: { ok: false, code: "ask_stale", error: "这个权限请求已经不在了" } };
    permissionCards.delete(channelId);
    p.ws.send(JSON.stringify({ type: "response", requestId: p.requestId, result: { optionId } }));
    settleRuntimeAsk("permission", channelId, "interact", opt.label, who);
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { ok: false, error: `不认识的操作 ${action}` } };
}
