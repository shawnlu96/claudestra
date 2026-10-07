/**
 * ACP 宿主窗口输入行发来的动作（acp_terminal 帧，宿主那头是 lib/acp/tty-input.ts；bridge.ts 一行分派到这里）。
 * 每个动作都落到网页已有的那条路上，终端不另开捷径：
 * - message：和 owner 在 Discord 频道里发消息同一个 Envelope → deliver（回合中插话 / 空闲开一轮 / 排队 / 额度闸押住都照旧），
 *   发信人按 owner（Discord 放行名单第一个 id），名字标「owner（终端）」，网页实时气泡和历史都看得出来源；
 * - interrupt：网页打断按钮同一个 interruptAgentByName；config：设置页同一个 acpSettings（会话里改 + 写 registry，不重启）；
 *   clear：网页 /clear 同一个 acpClear；compact：网页 /compact 同一个 acpSlash；permission：卡片按钮同一个认领闸（先到先得）。
 * 身份：能在这个窗口打字 = 有这台机器上这个 agent 的终端（宿主 shell 级）权限，所以按 owner 算（docs/runtimes/codex-acp.md）。
 * 只认这个频道当前登记的宿主连接发来的帧（和 acp_permission 同一道闸）。tests/acp-terminal.test.ts。
 */
import { readRegistryAgents } from "../lib/registry.js";
import { OWNER_PRINCIPAL_ID } from "../lib/devices.js";
import type { TerminalOp, TerminalResult } from "../lib/acp/tty-input.js";
import { acpClear, acpSlash, answerAcpPermissionById } from "./acp-link.js";
import { ALLOWED_USER_IDS } from "./config.js";
import { extensionSocketOf } from "./pi-abort.js";
import { interruptAgentByName } from "./preempt.js";
import { acpSettings } from "./runtime-settings-routes.js";
import { newThreadId, type Delivery, type Envelope, type LocalEndpoint } from "./router.js";

type Socket = { send(data: string): void };
type RunManager = (...args: string[]) => Promise<any>;

export interface TerminalDeps {
  deliver(env: Envelope): Promise<Delivery>;
  clients: Map<string, { ws: unknown; cwd?: string }>;
  runManager: RunManager;
  /** 投出去了：亮网页「思考中」（和 API 消息一样）；终端里打的字不 @ owner（他就在终端前） */
  afterSend(channelId: string): void;
  interrupt?: typeof interruptAgentByName;
}

export const TERMINAL_USER = "owner（终端）";

export async function onAcpTerminal(msg: Record<string, any>, ws: Socket, deps: TerminalDeps): Promise<void> {
  const channelId = String(msg.channelId ?? "");
  if (!channelId || extensionSocketOf(channelId) !== ws) return void console.warn(`⚠️ 丢掉一帧 acp_terminal：不是频道 ${channelId || "?"} 当前登记的宿主发的`);
  const result = await terminalAction(channelId, msg as TerminalOp, deps).catch((e): TerminalResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (typeof msg.requestId === "string") ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result }));
}

async function terminalAction(channelId: string, op: TerminalOp, deps: TerminalDeps): Promise<TerminalResult> {
  const agent = (await readRegistryAgents()).find((a) => a.channelId === channelId);
  if (!agent) return { ok: false, error: "registry 里找不到这个频道的 agent" };
  switch (op.op) {
    case "message": return sendMessage(channelId, String(op.text ?? ""), deps);
    case "interrupt": {
      const r = await (deps.interrupt ?? interruptAgentByName)(agent.name, channelId, { owner: true, name: TERMINAL_USER });
      return { ok: true, note: r.keys.length || r.deduped ? "已请求打断" : "现在没有回合在跑" };
    }
    case "config": {
      const value = String(op.value ?? "").trim();
      if (!value || (op.configId !== "model" && op.configId !== "effort")) return { ok: false, error: "缺少要切到的值" };
      const res = await acpSettings(agent.name, channelId, op.configId === "model" ? value : "", op.configId === "effort" ? value : "", deps.runManager);
      const body = (await res.json()) as { ok?: boolean; error?: string; warning?: string; message?: string };
      if (!body.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
      const aside = body.warning ?? body.message;
      return { ok: true, note: `${op.configId === "model" ? "模型" : "推理强度"}已切到 ${value}${aside ? `（${aside}）` : ""}` };
    }
    case "clear": {
      const r = await acpClear(channelId);
      return r.ok ? { ok: true, note: `已清上下文，新线程 ${String(r.sessionId ?? "").slice(0, 8)}` } : { ok: false, error: r.error };
    }
    case "compact": {
      const r = await acpSlash(channelId, "/compact");
      if (r.ok) deps.afterSend(channelId);
      return r.ok ? { ok: true, note: "已交给 agent 压缩" } : { ok: false, error: r.error };
    }
    case "permission": {
      const r = await answerAcpPermissionById(channelId, String(op.permId ?? ""), String(op.optionId ?? ""), { principal: OWNER_PRINCIPAL_ID, device: "terminal" });
      return r.status === 200 ? { ok: true } : { ok: false, error: String(r.body.error ?? "没答上") };
    }
    default: return { ok: false, error: `不认识的终端动作 ${String((op as { op?: unknown }).op)}` };
  }
}

async function sendMessage(channelId: string, text: string, deps: TerminalDeps): Promise<TerminalResult> {
  if (!text.trim()) return { ok: false, error: "空消息" };
  const client = deps.clients.get(channelId);
  if (!client) return { ok: false, error: "这个 agent 在 bridge 上没有连接" };
  const env: Envelope = {
    from: { kind: "user", userId: ALLOWED_USER_IDS[0] ?? OWNER_PRINCIPAL_ID, channelId, username: TERMINAL_USER },
    to: { kind: "local", channelId, ws: client.ws as LocalEndpoint["ws"], cwd: client.cwd },
    intent: "request",
    content: text,
    meta: { messageId: `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, triggerKind: "user_discord", ts: new Date().toISOString(), threadId: newThreadId() },
  };
  const d = await deps.deliver(env);
  if (d.outcome.kind !== "sent") return { ok: false, error: `没投出去：${d.outcome.kind === "dropped" ? d.outcome.reason : String(d.outcome.error)}` };
  if (d.outcome.heldBy) return { ok: true, note: "押着没投（额度闸 / 停在额度画面），恢复后自动投" };
  deps.afterSend(channelId);
  return { ok: true };
}
