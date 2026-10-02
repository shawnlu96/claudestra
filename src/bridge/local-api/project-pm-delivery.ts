import { principalView } from "../../lib/devices.js";
import { pmRedirect } from "../../lib/pm-role.js";
import { readRegistryAgentsSync, type RegistryAgent } from "../../lib/registry.js";
import { agentInScope, readPrincipalsStrict, tokenIdOf, type PrincipalsFile } from "../../lib/principals.js";
import { ledgerDb } from "../ledger-feed.js";
import type { AgentCallBook } from "../agent-calls.js";
import type { Envelope, Delivery, LocalEndpoint } from "../router.js";

interface Receipt { tokenId: string; agentChannelId: string; agentName: string; messageId?: string }
interface RouteFacts { db: ReturnType<typeof ledgerDb>; agents: RegistryAgent[]; principals?(): Promise<PrincipalsFile> }
type Client = { ws: LocalEndpoint["ws"]; cwd?: string };
type Send = (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;

/** This is called for every local delivery, including the replay of held envelopes. */
export async function deliverPmLocal<P extends Receipt>(
  env: Envelope, to: LocalEndpoint, clients: Map<string, Client>, book: AgentCallBook, receipts: Map<string, P[]>, send: Send,
  facts: RouteFacts = { db: ledgerDb(), agents: readRegistryAgentsSync() },
): Promise<Delivery> {
  const { db, agents } = facts;
  const original = agents.find((a) => a.name === to.agentName || a.channelId === to.channelId);
  if (!db || !original?.projectId) return send(env, to);
  // A retired PM still online finishes the conversations it started itself; offline, the active PM takes the answer over.
  const pushback = isCallerPushback(env), own = original.channelId ? clients.get(original.channelId) : undefined;
  const name = pushback && own ? null : pmRedirect(db, original.projectId, original.name, env.from.kind === "local" ? env.from.agentName : undefined);
  if (!name) {
    // pmClientFor may have lent another PM's socket under an older pointer; never deliver this channel's message through it.
    const borrowed = agents.some((a) => a.projectId === original.projectId && a.channelId && a.channelId !== to.channelId
      && clients.get(a.channelId)?.ws === to.ws);
    if (!borrowed) return send(env, to);
    if (!own) return { envelope: env, outcome: { kind: "dropped", reason: `${original.name} is offline` } };
    env.to = { ...to, ws: own.ws, cwd: own.cwd };
    return send(env, env.to);
  }
  const agent = agents.find((a) => a.name === name && a.projectId === original.projectId);
  const client = agent?.channelId ? clients.get(agent.channelId) : undefined;
  if (!agent?.channelId || !client) return { envelope: env, outcome: { kind: "dropped", reason: `active PM ${name} is offline` } };
  const target: LocalEndpoint = { kind: "local", agentName: name, channelId: agent.channelId, ws: client.ws, cwd: client.cwd };
  if (env.from.kind === "api") {
    const file = await (facts.principals ?? readPrincipalsStrict)();
    const from = env.from;
    const stored = file.principals.find((p) => tokenIdOf(p) === from.tokenId);
    const p = stored && principalView(file, stored.id, from.credential);
    if (!p || p.peer !== from.peer || !agentInScope(p, name)) {
      const notice: Envelope = { ...env, from: { kind: "bridge", label: "pm-scope-refusal" }, to: target, intent: "notification",
        content: `前任 PM ${original.name} 的 ${from.peer ? "peer" : "API"} 消息被拒收：令牌范围未包含当班 PM ${name}。`,
        meta: { messageId: `${env.meta.messageId}:pm-refused`, threadId: `${env.meta.threadId}:pm-refused`,
          ts: env.meta.ts, triggerKind: "system", skipInterAgentWatchdog: true } };
      const delivered = await send(notice, target);
      if (delivered.outcome.kind !== "sent") console.error("[pm-role] refusal notice delivery failed", delivered.outcome.kind);
      return { envelope: env, outcome: { kind: "dropped", reason: `${from.peer ? "peer token" : "API credential"} scope excludes active PM ${name}` } };
    }
  }
  const before = to.channelId;
  // Move only this request's receipt; unrelated old-PM conversations remain with their original target.
  const caller = env.from.kind === "local" ? env.from.channelId : null;
  if (caller) {
    const slot = book.slot(before, caller), req = slot?.requests?.find((r) => r.messageId === env.meta.messageId);
    if (slot && req) {
      book.add(target.channelId, { ...slot, targetName: name, originalReplyChannel: req.originalReplyChannel, expecting: req.expecting, ts: req.ts }, req.messageId);
      book.dropRequest(before, caller, env.meta.messageId);
    }
  }
  let movedReceipt: P | undefined;
  if (env.from.kind === "api") {
    const oldKey = `${env.from.tokenId}|${before}`, queue = receipts.get(oldKey);
    const index = queue?.findIndex((p) => p.messageId === env.meta.messageId) ?? -1;
    if (queue && index >= 0) {
      movedReceipt = queue.splice(index, 1)[0]!;
      movedReceipt.agentChannelId = target.channelId;
      movedReceipt.agentName = name;
      const key = `${env.from.tokenId}|${target.channelId}`;
      receipts.set(key, [...(receipts.get(key) ?? []), movedReceipt]);
      if (!queue.length) receipts.delete(oldKey);
    }
  }
  env.to = target;
  env.content = pushback ? `[系统转交：这是回复前任 PM ${original.name} 的问题；当班 PM ${name}]\n${env.content}`
    : `[系统转交：原收件人 ${original.name}；当班 PM ${name}]\n${env.content}`;
  // The previous recipient's session pin is not the new PM's session; pin to the live replacement instead.
  if (env.meta.expectSession) env.meta.expectSession = agent.sessionId;
  const delivery = await send(env, target);
  if (caller && delivery.outcome.kind !== "sent") book.dropRequest(target.channelId, caller, env.meta.messageId);
  if (movedReceipt && delivery.outcome.kind !== "sent") {
    const key = `${movedReceipt.tokenId}|${target.channelId}`;
    receipts.set(key, (receipts.get(key) ?? []).filter((p) => p !== movedReceipt));
  }
  return delivery;
}

// Answers pushed back to the agent that asked: local send_to_agent replies / drains / expiries, and HTTP peer replies.
const PUSHBACK_ID = /^(?:agent_(?:reply|drain|withheld|expired|apierr)|reply_fwd)_/;
function isCallerPushback(env: Envelope): boolean {
  if (env.meta.triggerKind === "peer_http") return true;
  return env.from.kind === "local" && env.meta.triggerKind === "agent_tool" && PUSHBACK_ID.test(env.meta.messageId)
    && (env.intent === "response" || !env.meta.messageId.startsWith("reply_fwd_"));
}

/** After an API delivery, typing / source / handoff bookkeeping belongs to whoever actually received it. */
export function followPmDelivery(agent: { name: string; channelId: string }, delivery: { envelope: Envelope }): void {
  const to = delivery.envelope.to;
  if (to.kind === "local" && to.channelId !== agent.channelId) Object.assign(agent, { name: to.agentName ?? agent.name, channelId: to.channelId });
}

/** Resolve a usable socket before legacy callers reject an offline retired PM; authorization stays in deliverPmLocal. */
export function pmClientFor<T>(
  name: string, clients: Map<string, T>, sender?: string, facts: RouteFacts = { db: ledgerDb(), agents: readRegistryAgentsSync() },
): T | undefined {
  const { db, agents } = facts;
  const original = agents.find((a) => a.name === name || a.channelId === name);
  if (!db || !original?.projectId) return undefined;
  const active = pmRedirect(db, original.projectId, original.name, sender);
  const target = active && agents.find((a) => a.name === active && a.projectId === original.projectId);
  const client = target && target.channelId ? clients.get(target.channelId) : undefined;
  // Discord builds the envelope from client.channelId; keep the addressed channel until the central redirect adds its header.
  return client && typeof client === "object" && "channelId" in client ? { ...client, channelId: original.channelId } as T : client;
}
