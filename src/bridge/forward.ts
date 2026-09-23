/**
 * 「转交」的投递（规则见 lib/forward.ts）：agent 调 forward_to_agent(message_id, target, reason)，
 * 这里从最近收到的入站消息里取出**原话**（不经 agent 转述，附件原样带上），以用户的身份投给接手方——
 * 于是接手方的 reply 直接回到用户：Web 用户回到同一个 api: 地址（网页里出现在接手方的对话下），
 * Discord 用户回到接手方自己的频道（先把原话贴过去，用户对得上上下文）。
 * 原 agent 这条请求视为已处理（清掉 pendingReply，Stop 不再催它回复），它的对话里留一行「↪ 已转给 X」。
 *
 * 状态只有一个内存环（最近 300 条入站）：bridge 重启后之前的消息转不了，agent 会拿到原因、改为回复用户。
 */
import type { ServerWebSocket } from "bun";
import type { Client } from "discord.js";
import { discordReply } from "./discord-api.js";
import type { Envelope, LocalEndpoint } from "./router.js";
import { newThreadId } from "./router.js";
import { readRegistryAgents } from "../lib/registry.js";
import { agentInScope, readPrincipals } from "../lib/principals.js";
import { forwardHeader, forwardNotice, forwardVerdict } from "../lib/forward.js";

const RECENT_MAX = 300;
const recent = new Map<string, { env: Envelope; channelId: string }>();

/** deliverToLocal 每投一条用户请求就记一笔（转交只能转「刚发给我」的用户原话） */
export function rememberInbound(env: Envelope, channelId: string): void {
  if (env.intent !== "request" || (env.from.kind !== "user" && env.from.kind !== "api")) return;
  recent.set(env.meta.messageId, { env, channelId });
  if (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value as string);
}

export interface ForwardDeps {
  clients: Map<string, { ws: ServerWebSocket<unknown> }>;
  deliver: (env: Envelope) => Promise<unknown>;
  pendingReplies: Map<string, unknown>;
  pendingThreads: Map<string, unknown>;
  emitEvent: (e: { agent: string; chatId: string; type: "chat_message"; data: Record<string, unknown> }) => void;
  /** Discord 客户端；web-only 模式为 null（不贴原话、不发频道提示） */
  discord: Client | null;
  controlChannelId: string;
}
let deps: (ForwardDeps & { postDiscord?: (channelId: string, text: string, files?: string[]) => Promise<unknown> }) | null = null;
export function initForward(d: ForwardDeps): void {
  const dc = d.discord;
  deps = { ...d, postDiscord: dc ? (ch, text, files) => discordReply(dc, ch, text, undefined, undefined, files) : undefined };
}

type Result = { result: Record<string, unknown> } | { error: string };

export async function handleForward(ws: ServerWebSocket<unknown>, msg: Record<string, unknown>): Promise<Result> {
  if (!deps) return { error: "bridge 还没初始化转交" };
  const d = deps;
  const fromChannelId = [...d.clients.entries()].find(([, c]) => c.ws === ws)?.[0] ?? "";
  const orig = recent.get(String(msg.messageId || ""));
  if (!orig || orig.channelId !== fromChannelId) {
    return { error: "找不到这条消息（只能转交刚发给你的用户消息；bridge 重启过的话之前的也找不到）——请直接回复用户，告诉他该找谁" };
  }
  const regs = await readRegistryAgents();
  const fromName = fromChannelId === d.controlChannelId ? "master" : regs.find((r) => r.channelId === fromChannelId)?.name ?? "agent";
  const rawTarget = String(msg.target || "").trim();
  const targetName = rawTarget === "master" ? "master" : rawTarget.startsWith("agent-") ? rawTarget : `agent-${rawTarget}`;
  const target = regs.find((r) => r.name === targetName);
  const targetClient = target?.channelId ? d.clients.get(target.channelId) : undefined;
  const from = orig.env.from;
  let inScope = true;
  if (from.kind === "api") {
    const p = (await readPrincipals()).principals.find((x) => x.id === `token:${from.tokenId}` && !x.disabled);
    inScope = !!p && agentInScope(p, targetName);
  }
  const err = forwardVerdict({
    srcKind: from.kind, peer: from.kind === "api" ? from.peer : undefined, forwarded: !!orig.env.meta.forwarded,
    fromAgent: fromName, target: targetName, targetExists: !!target, targetOnline: !!targetClient,
    targetIsMaster: targetName === "master", inScope,
  });
  if (err || !target?.channelId || !targetClient) return { error: err ?? "目标不可用" };

  const short = (n: string) => n.replace(/^agent-/, "");
  const to: LocalEndpoint = { kind: "local", agentName: targetName, channelId: target.channelId, ws: targetClient.ws };
  const env: Envelope = {
    from: from.kind === "user" ? { ...from, channelId: target.channelId } : from,
    to,
    intent: "request",
    content: `${forwardHeader(short(fromName), String(msg.reason || ""))}\n\n${orig.env.content}`,
    meta: { ...orig.env.meta, messageId: `fwd_${Date.now()}`, threadId: newThreadId(), ts: new Date().toISOString(), forwarded: true, discordMsg: undefined },
  };
  if (from.kind === "user" && d.postDiscord) {
    await d.postDiscord(target.channelId, `↪ 由 <#${fromChannelId}> 转来（原本发给 ${short(fromName)}）：\n${orig.env.content}`, orig.env.meta.attachments)
      .catch((e: Error) => console.error(`⚠️ 转交：原话贴到 ${targetName} 频道失败: ${e.message}`));
  }
  await d.deliver(env);
  // 原请求算已处理：Stop 不再催原 agent 回复
  d.pendingReplies.delete(orig.env.meta.threadId);
  d.pendingThreads.delete(orig.env.meta.threadId);
  const notice = forwardNotice(targetName);
  d.emitEvent({ agent: fromName, chatId: fromChannelId, type: "chat_message", data: { direction: "out", from: fromName, text: notice, threadId: orig.env.meta.threadId, notice: true } });
  if (from.kind === "user" && d.postDiscord) {
    await d.postDiscord(fromChannelId, `↪ 已转给 <#${target.channelId}>`).catch((e: Error) => console.error(`⚠️ 转交提示发送失败: ${e.message}`));
  }
  console.log(`↪ 转交: ${fromName} → ${targetName}（${from.kind}）`);
  return { result: { ok: true, target: short(targetName) } };
}
