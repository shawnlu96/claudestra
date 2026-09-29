/**
 * 统一派单的本机投递入口（ws `dispatch_to_agent`，T48 P1-1 / P2-1）：只收本机 agent 名，绝不按 `x@peer` / `peer:` 转成远程投递——
 * route_to_agent 会做这种转换，派单若借它走，本机通道就能绕过「只发对方项目 PM + 先脱敏」。带稳定标识（dedup）的，
 * 同一个标识只投一次（lib/delivery-dedup.ts），重发回第一次的 thread。fire-and-forget：不挂回推、不挂 inter-agent 看门狗。
 * 只有 manager 的 `ledger dispatch` / `dispatch-sweep` 经 bridge-client 调；ws 升级本身只收回环（控制面闸门）。
 */
import type { ServerWebSocket } from "bun";
import { dedupKeyOf, noteDelivery, seenDelivery } from "../lib/delivery-dedup.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { newMessageId, newThreadId, type Envelope } from "./router.js";

/** 本机 agent 名：不带 @、不以 peer: 开头（本机真有这种名字也不收，宁可让 PM 改名，也不让通道含糊） */
const LOCAL_NAME_RE = /^(?!peer:)[\p{L}\p{N}_.-]{1,100}$/u;

interface Client { ws: ServerWebSocket<unknown>; cwd?: string }
export interface DispatchRouteDeps {
  clients: Map<string, Client>;
  deliver: (env: Envelope) => Promise<{ outcome: { kind: string; heldBy?: unknown; reason?: string; error?: unknown } }>;
  lastMessageSource: { set(channelId: string, src: "agent"): unknown };
  /** 单测注入：agent 名 → 频道；不给读 registry */
  channelOf?: (name: string) => string | undefined;
}

type Reply = { result: Record<string, unknown> } | { error: string };

export async function dispatchToAgent(msg: { targetName?: unknown; text?: unknown; dedup?: unknown }, ws: ServerWebSocket<unknown>, d: DispatchRouteDeps): Promise<Reply> {
  const name = typeof msg.targetName === "string" ? msg.targetName : "";
  if (!LOCAL_NAME_RE.test(name)) return { error: `本机派单只收本机 agent 名（不带 @、不以 peer: 开头），收到 ${JSON.stringify(name.slice(0, 80))}` };
  const channelId = d.channelOf ? d.channelOf(name) : readRegistryAgentsSync().find((a) => a.name === name)?.channelId;
  const client = channelId ? d.clients.get(channelId) : undefined;
  if (!channelId || !client) return { error: `Agent '${name}' 不存在或未连接到 Bridge` };
  const key = dedupKeyOf(msg.dedup);
  const sender = `local:${name}`;
  const seen = key ? seenDelivery(sender, key) : null;
  if (seen) return { result: { targetName: name, threadId: seen, duplicate: true } };
  const env: Envelope = {
    from: { kind: "local", agentName: "ledger-dispatch", channelId: "", ws },
    to: { kind: "local", agentName: name, channelId, ws: client.ws, cwd: client.cwd },
    intent: "request",
    content: typeof msg.text === "string" ? msg.text : "",
    meta: { messageId: newMessageId("agent"), triggerKind: "agent_tool", ts: new Date().toISOString(), threadId: newThreadId(), skipInterAgentWatchdog: true },
  };
  const delivery = await d.deliver(env);
  if (delivery.outcome.kind !== "sent") return { error: `deliver 失败: ${delivery.outcome.reason ?? String(delivery.outcome.error ?? delivery.outcome.kind)}` };
  if (key) noteDelivery(sender, key, env.meta.threadId);
  d.lastMessageSource.set(channelId, "agent"); // 派单触发的回合不发完成 @（同 route_to_agent）
  return { result: { targetName: name, threadId: env.meta.threadId, queued: !!delivery.outcome.heldBy } };
}
