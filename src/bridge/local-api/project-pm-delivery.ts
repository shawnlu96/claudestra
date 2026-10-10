import { principalView } from "../../lib/devices.js";
import { getMeta } from "../../lib/ledger-store.js";
import { pmRedirect } from "../../lib/pm-role.js";
import { readRegistryAgentsSync, type RegistryAgent } from "../../lib/registry.js";
import { agentInScope, readPrincipalsStrict, tokenIdOf, type PrincipalsFile } from "../../lib/principals.js";
import { ledgerDb } from "../ledger-feed.js";
import type { AgentCallBook } from "../agent-calls.js";
import type { Envelope, Delivery, LocalEndpoint } from "../router.js";
import { pmDirectedVerdict, type CallerOf } from "../pm-directed-agent.js";
import { isCallerPushback, isHumanDirect, markPmTransfer, pmTargetDrift, retryLater, setPmRoleRoute, undoPmTransfer, type PmTarget } from "../pm-held-transfer.js";
import { pmDigest } from "../pm-digest.js";

interface Receipt { tokenId: string; agentChannelId: string; agentName: string; messageId?: string }
interface RouteFacts { db: ReturnType<typeof ledgerDb>; agents: RegistryAgent[]; principals?(): Promise<PrincipalsFile>; callerOf?: CallerOf }
type Client = { ws: LocalEndpoint["ws"]; cwd?: string };
type Send = (env: Envelope, to: LocalEndpoint) => Promise<Delivery>;

/** This is called for every local delivery, including the replay of held envelopes. */
export async function deliverPmLocal<P extends Receipt>(
  env: Envelope, to: LocalEndpoint, clients: Map<string, Client>, book: AgentCallBook, receipts: Map<string, P[]>, send: Send,
  facts: RouteFacts = { db: ledgerDb(), agents: readRegistryAgentsSync() },
): Promise<Delivery> {
  const { db, agents } = facts;
  const original = agents.find((a) => a.name === to.agentName || a.channelId === to.channelId);
  // The verified active PM naming an agent of its own project (e.g. its predecessor acting as supervisor) is never redirected back to itself.
  // Checked before the no-project shortcut: a named letter whose target left the project / registry is refused, not delivered as plain mail.
  const directed = pmDirectedVerdict(env, original, db, agents, facts.callerOf);
  if (directed === "refused") return { envelope: env, outcome: { kind: "dropped", reason: "sender is no longer the verified active PM that addressed it" } };
  if (!db || !original?.projectId) return send(env, to);
  send = pmDigest.wrap(send, db, original.projectId); // 当班 PM 的非紧急推送合并成摘要（bridge/pm-digest.ts）
  // A retired PM still online finishes the conversations it started itself; offline, the active PM takes the answer over.
  // A human who picked this agent keeps talking to it, online or not: the PM role never answers in its place.
  const pushback = isCallerPushback(env), own = original.channelId ? clients.get(original.channelId) : undefined;
  const direct = isHumanDirect(env);
  const name = (pushback && own) || direct || directed ? null : pmRedirect(db, original.projectId, original.name, env.from.kind === "local" ? env.from.agentName : undefined);
  if (!name) {
    // pmClientFor may have lent another PM's socket under an older pointer; never deliver this channel's message through it.
    const borrowed = agents.some((a) => a.projectId === original.projectId && a.channelId && a.channelId !== to.channelId
      && clients.get(a.channelId)?.ws === to.ws);
    // A held letter replayed while its addressee is offline carries no socket at all: keep it queued, never send on an empty one.
    const lent = borrowed || !to.ws;
    if (lent && !own) return retryLater({ envelope: env, outcome: { kind: "dropped", reason: `${original.name} is offline` } });
    const via: LocalEndpoint = lent && own ? { ...to, ws: own.ws, cwd: own.cwd } : to;
    const drift = pmTargetDrift(env, via.channelId); // flush checked another PM's turn for it: keep it queued, re-check next time
    if (drift) return drift;
    // Whether or not the role would have redirected it, a direct API chat with a PM is re-checked against its exact credential.
    if (direct && getMeta(db, original.projectId).pms.includes(original.name)) {
      const refused = await finalScopeRefusal(env, original.name, facts);
      if (refused) return refused;
      undoPmTransfer(env, via); // an earlier replay may have pointed it at the active PM
    }
    // The predecessor's own answer stays its own: an older build / failed retry may have pointed it at the active PM.
    if (pushback && own) undoPmTransfer(env, via);
    if (borrowed) env.to = via;
    return send(env, via);
  }
  const agent = agents.find((a) => a.name === name && a.projectId === original.projectId);
  const client = agent?.channelId ? clients.get(agent.channelId) : undefined;
  if (!agent?.channelId || !client) return retryLater({ envelope: env, outcome: { kind: "dropped", reason: `active PM ${name} is offline` } });
  const target: LocalEndpoint = { kind: "local", agentName: name, channelId: agent.channelId, ws: client.ws, cwd: client.cwd };
  const drift = pmTargetDrift(env, target.channelId); // before any receipt / return slot moves: flush checked this recipient's turn
  if (drift) return drift;
  // A drifted target is caught above, so the refusal notice can only reach the PM flush checked.
  if (env.from.kind === "api" && !(await apiScopeAllows(env.from, name, facts))) return refuseOutOfScope(env, env.from, original.name, target, send);
  const before = to.channelId;
  // Move only this request's receipt; unrelated old-PM conversations remain with their original target.
  const caller = env.from.kind === "local" ? env.from.channelId : null;
  let moved: { slot: Parameters<AgentCallBook["add"]>[1]; messageId?: string } | undefined;
  if (caller) {
    const slot = book.slot(before, caller), req = slot?.requests?.find((r) => r.messageId === env.meta.messageId);
    if (slot && req) {
      moved = { slot: { ...slot, originalReplyChannel: req.originalReplyChannel, expecting: req.expecting, ts: req.ts }, messageId: req.messageId };
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
  // Replayed held letters reach here again on every flush: the header is replaced via its trusted meta record, never stacked.
  markPmTransfer(env, before, target.channelId, pushback ? `[系统转交：这是回复前任 PM ${original.name} 的问题；当班 PM ${name}]`
    : `[系统转交：原收件人 ${original.name}；当班 PM ${name}]`);
  env.to = target;
  // The previous recipient's session pin is not the new PM's session; pin to the live replacement instead.
  if (env.meta.expectSession) env.meta.expectSession = agent.sessionId;
  const delivery = await send(env, target);
  if (delivery.outcome.kind === "sent") return delivery;
  if (caller) book.dropRequest(target.channelId, caller, env.meta.messageId);
  if (movedReceipt) {
    const key = `${movedReceipt.tokenId}|${target.channelId}`, left = (receipts.get(key) ?? []).filter((p) => p !== movedReceipt);
    if (left.length) receipts.set(key, left);
    else receipts.delete(key);
  }
  // A failed send keeps the held original queued for retry: its return slot and API waiter go back to the former recipient with it.
  if (delivery.outcome.kind !== "error") return delivery;
  if (caller && moved) book.add(before, moved.slot, moved.messageId);
  if (movedReceipt) {
    Object.assign(movedReceipt, { agentChannelId: before, agentName: original.name });
    receipts.set(`${movedReceipt.tokenId}|${before}`, [...(receipts.get(`${movedReceipt.tokenId}|${before}`) ?? []), movedReceipt]);
  }
  return delivery;
}

type ApiFrom = Extract<Envelope["from"], { kind: "api" }>;
/** The final recipient is re-checked against the exact token / device credential, not the principal's broad scope. */
async function apiScopeAllows(from: ApiFrom, name: string, facts: RouteFacts): Promise<boolean> {
  const file = await (facts.principals ?? readPrincipalsStrict)();
  const stored = file.principals.find((p) => tokenIdOf(p) === from.tokenId);
  const p = stored && principalView(file, stored.id, from.credential);
  return !!p && p.peer === from.peer && agentInScope(p, name);
}

/** The original is dropped once the active PM gets a refusal notice; it is the only trace, so a held original stays queued until it gets through. */
async function refuseOutOfScope(env: Envelope, from: ApiFrom, former: string, target: LocalEndpoint, send: Send): Promise<Delivery> {
  const name = target.agentName;
  const { pmTransfer: _, ...plain } = env as Envelope & { pmTransfer?: unknown };
  const notice: Envelope = { ...plain, from: { kind: "bridge", label: "pm-scope-refusal" }, to: target, intent: "notification",
    content: `前任 PM ${former} 的 ${from.peer ? "peer" : "API"} 消息被拒收：令牌范围未包含当班 PM ${name}。`,
    meta: { messageId: `${env.meta.messageId}:pm-refused`, threadId: `${env.meta.threadId}:pm-refused`,
      ts: env.meta.ts, triggerKind: "system", skipInterAgentWatchdog: true } };
  const delivered = await send(notice, target);
  const refused: Delivery = { envelope: env, outcome: { kind: "dropped", reason: `${from.peer ? "peer token" : "API credential"} scope excludes active PM ${name}` } };
  if (delivered.outcome.kind === "sent") return refused;
  console.error("[pm-role] refusal notice delivery failed", delivered.outcome.kind);
  return retryLater(refused);
}

/** A held direct chat replayed after its device lost this agent is dropped quietly: nobody else gets its content. */
async function finalScopeRefusal(env: Envelope, name: string, facts: RouteFacts): Promise<Delivery | null> {
  if (env.from.kind !== "api" || await apiScopeAllows(env.from, name, facts)) return null;
  return { envelope: env, outcome: { kind: "dropped", reason: `API credential scope excludes ${name}` } };
}

/**
 * 押后队列的归属判定（收件箱领取 / 计数、flush 交给当班 PM）：同 deliverPmLocal 的转交规则，但前任自己请求的回程不看在不在线——
 * 押着的就留给它本人，不从正文猜身份。台账读不出来按「留在原频道」，和改动前一样
 */
export function pmRoleRoute(facts?: RouteFacts): (channelId: string) => (env: Envelope) => PmTarget | null {
  return (channelId) => {
    const { db, agents } = facts ?? { db: ledgerDb(), agents: readRegistryAgentsSync() };
    const original = agents.find((a) => a.channelId === channelId);
    return (env) => {
      if (isHumanDirect(env) || isCallerPushback(env)) return null;
      try {
        const directed = pmDirectedVerdict(env, original, db, agents, facts?.callerOf);
        // Refused: never claimable from this inbox. Flush hands it to deliverPmLocal, which drops it without sending to anyone.
        if (directed === "refused") return { agentName: original?.name ?? ((env.to.kind === "local" && env.to.agentName) || channelId), channelId };
        if (directed === "directed" || !db || !original?.projectId) return null; // stays with the named agent
        const name = pmRedirect(db, original.projectId, original.name, env.from.kind === "local" ? env.from.agentName : undefined);
        return name ? { agentName: name, channelId: agents.find((a) => a.name === name && a.projectId === original.projectId)?.channelId } : null;
      } catch (e) {
        console.error("[pm-role] held ownership check failed", (e as Error).message);
        return null;
      }
    };
  };
}
setPmRoleRoute(pmRoleRoute());

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
