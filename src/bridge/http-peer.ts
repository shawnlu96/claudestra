/**
 * v2.11+ HTTP peer 出站 transport（design docs/design-http-peers.md §4）。
 *
 * peer = 另一个 Claudestra 实例。出站 = 拿对方签的 Bearer POST 它的
 * /api/v1/agents/:name/messages（wait 同步等回复）；对方的入站处理与
 * web-ui 完全同路（scope/mirror/history 白拿），无需对方任何新代码。
 *
 * caller 交互协议与 Discord peer 完全一致（agent 无感知差异）：
 *   send_to_agent 返回 {ok, pushBack:true} → 回复以合成 user 消息
 *   「[🤖 来自 peer X/Y] ...」推回 caller ws；失败也以合成消息告知，不静默。
 *
 * 超时链：wait=120s 同步等 → 对方回 202/网络超时 → 每 30s GET /threads/:id
 * 轮询，10 分钟放弃。**不自动重试 POST**——消息投递非幂等，重试=双发。
 */

import type { ServerWebSocket } from "bun";
import type { Envelope, Delivery } from "./router.js";
import { newThreadId } from "./router.js";
import type { HttpPeer } from "../lib/peers.js";
import { recordMetric } from "../lib/metrics.js";

export interface HttpPeerDeps {
  deliver: (env: Envelope) => Promise<Delivery>;
  /** 按 channelId 取 caller 当前 ws——pushback 时原 ws 可能已随 channel-server
   *  重连失效(长轮询 10 分钟窗口内完全可能),失败后用它重查最新连接再投一次 */
  getClientWs?: (channelId: string) => ServerWebSocket<unknown> | null;
  /** 覆盖注入点（单测 fake fetch 用）；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 单测覆盖:轮询间隔/放弃时限(生产别动) */
  pollIntervalMs?: number;
  pollGiveUpMs?: number;
}

let deps: HttpPeerDeps | null = null;
export function initHttpPeer(d: HttpPeerDeps) {
  deps = d;
}

/** 出站 wait 秒数（对方 API 上限 300；留余量给网络） */
const WAIT_SEC = 120;
/** 单次 POST 的硬超时（wait + 网络余量） */
const POST_TIMEOUT_MS = (WAIT_SEC + 15) * 1000;
/** thread 轮询间隔 / 放弃时限 */
const POLL_INTERVAL_MS = 30_000;
const POLL_GIVE_UP_MS = 10 * 60_000;

interface CallerRef {
  ws: ServerWebSocket<unknown>;
  channelId: string;
  name: string;
}

/** 进行中的出站调用数（诊断/测试用） */
export const inflightHttpPeerCalls = new Set<string>();

/** callId → caller channelId(用户接管/kill 取消用) */
const inflightByCaller = new Map<string, string>();
const cancelledCalls = new Set<string>();

/**
 * 取消某 caller 频道上全部在飞的 HTTP peer 调用(v2.4.16 语义在 HTTP 路径的
 * 复刻,review 2026-07-20 #3):用户在频道打字接管、或 agent 被 kill 时调——
 * 之后到货的 peer 回复不再 pushback,避免把 agent 拽回已被用户叫停的线程。
 * 返回取消条数。
 */
export function cancelHttpPeerCallsForChannel(channelId: string): number {
  let n = 0;
  for (const [callId, ch] of inflightByCaller.entries()) {
    if (ch === channelId) {
      cancelledCalls.add(callId);
      n++;
    }
  }
  return n;
}

/**
 * 出站主入口。**同步阶段**只做参数构造——立即给 caller 回 MCP response
 * （ok+pushBack），真正的 HTTP 往返在后台进行，结果一律以合成消息推回。
 * 返回值是给 send_to_agent handler 的 result 对象。
 */
export function routeToHttpPeer(
  ws: ServerWebSocket<unknown>,
  fromChannelId: string,
  fromName: string,
  peer: HttpPeer,
  peerAgentName: string,
  text: string,
  expecting?: string,
): { ok: true; targetName: string; pushBack: true } {
  const caller: CallerRef = { ws, channelId: fromChannelId, name: fromName };
  const callId = `hp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  inflightHttpPeerCalls.add(callId);
  inflightByCaller.set(callId, fromChannelId);
  void runCall(callId, caller, peer, peerAgentName, text, expecting).finally(() => {
    inflightHttpPeerCalls.delete(callId);
    inflightByCaller.delete(callId);
    cancelledCalls.delete(callId);
  });
  return { ok: true, targetName: `peer:${peer.name}.${peerAgentName}`, pushBack: true };
}

async function runCall(
  callId: string,
  caller: CallerRef,
  peer: HttpPeer,
  peerAgentName: string,
  text: string,
  expecting?: string,
) {
  const d = deps;
  if (!d) return;
  const f = d.fetchImpl ?? fetch;
  const base = (peer.baseUrl || "").replace(/\/+$/, "");
  const label = `peer ${peer.name}/${peerAgentName}`;

  let res: Response;
  try {
    res = await f(`${base}/api/v1/agents/${encodeURIComponent(peerAgentName)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${peer.outToken || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, wait: WAIT_SEC }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 网络不可达：${(e as Error).message}。请确认对方实例在线（peer-http-test ${peer.name}）。`, peer, peerAgentName, false, callId);
    recordMetric("http_peer_out_error", { channelId: caller.channelId, meta: { peer: peer.name, kind: "network" } });
    return;
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应按状态码兜底 */
  }

  if (res.status === 401 || res.status === 403) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 拒绝了请求（${res.status}：${body?.error || "token 无效或 agent 不在授权范围"}）。可能对方已 revoke——联系对方确认或重新握手。`, peer, peerAgentName, false, callId);
    recordMetric("http_peer_out_error", { channelId: caller.channelId, meta: { peer: peer.name, kind: "auth", status: res.status } });
    return;
  }
  if (res.status === 404 || res.status === 409) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label}：${body?.error || `对方 agent 不存在或离线（${res.status}）`}`, peer, peerAgentName, false, callId);
    recordMetric("http_peer_out_error", { channelId: caller.channelId, meta: { peer: peer.name, kind: "target", status: res.status } });
    return;
  }
  if (!res.ok && res.status !== 202) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 返回 ${res.status}：${body?.error || "未知错误"}`, peer, peerAgentName, false, callId);
    recordMetric("http_peer_out_error", { channelId: caller.channelId, meta: { peer: peer.name, kind: "http", status: res.status } });
    return;
  }

  // 同步拿到回复（wait 命中）
  const replyText = extractReplyText(body);
  if (replyText) {
    await pushReply(caller, peer, peerAgentName, replyText, expecting, callId);
    recordMetric("http_peer_out_ok", { channelId: caller.channelId, meta: { peer: peer.name, mode: "wait" } });
    return;
  }
  // 200 且 reply 为 null/空串 = 对方回合结束但没有文本回复（罕见）——终止,不空转轮询
  // (空串场景:对方 reply() 只发按钮/附件无文本,ApiReplyResult.reply 是 "")
  if (res.status === 200 && body && body.ok && "reply" in body && !String(body.reply ?? "").trim()) {
    await pushToCaller(caller, `[🤖 peer ${peer.name}/${peerAgentName}] 对方回合已结束但没有文本回复。`, peer, peerAgentName, false, callId);
    recordMetric("http_peer_out_ok", { channelId: caller.channelId, meta: { peer: peer.name, mode: "wait", empty: true } });
    return;
  }

  // 202 / wait 超时未答 → thread 轮询兜底
  const threadId: string | undefined = typeof body?.thread_id === "string" ? body.thread_id : typeof body?.threadId === "string" ? body.threadId : undefined;
  if (!threadId) {
    await pushToCaller(caller, `[⚠️ peer 调用] ${label} 已接收请求但未返回可追踪的 thread——对方版本可能过旧，回复无法自动送达。`, peer, peerAgentName, false, callId);
    return;
  }
  const pollMs = d.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + (d.pollGiveUpMs ?? POLL_GIVE_UP_MS);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const pr = await f(`${base}/api/v1/threads/${encodeURIComponent(threadId)}`, {
        headers: { Authorization: `Bearer ${peer.outToken || ""}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (pr.status === 404) continue; // 还没答
      // 鉴权失败不是瞬时故障——对方 revoke/轮换了 token,继续轮只是空转 10 分钟
      // 再误报「超时」(review 2026-07-19 #7)
      if (pr.status === 401 || pr.status === 403) {
        await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 在等待回复期间拒绝了鉴权（${pr.status}）——对方可能已 revoke,需要重新握手。`, peer, peerAgentName, false, callId);
        recordMetric("http_peer_out_error", { channelId: caller.channelId, meta: { peer: peer.name, kind: "auth_poll", status: pr.status } });
        return;
      }
      if (!pr.ok) continue;            // 瞬时故障,下轮再试
      const pb: any = await pr.json().catch(() => null);
      const t = extractReplyText(pb);
      if (t) {
        await pushReply(caller, peer, peerAgentName, t, expecting, callId);
        recordMetric("http_peer_out_ok", { channelId: caller.channelId, meta: { peer: peer.name, mode: "poll" } });
        return;
      }
      if (pb && pb.ok && "reply" in pb && !String(pb.reply ?? "").trim()) {
        await pushToCaller(caller, `[🤖 peer ${peer.name}/${peerAgentName}] 对方回合已结束但没有文本回复。`, peer, peerAgentName, false, callId);
        return;
      }
    } catch {
      /* 单轮失败不放弃 */
    }
  }
  await pushToCaller(caller, `[⚠️ peer 调用超时] ${label} 在 ${Math.round((WAIT_SEC * 1000 + POLL_GIVE_UP_MS) / 60000)} 分钟内没有回复。对方可能仍在处理——需要的话稍后再问一次。`, peer, peerAgentName, false, callId);
  recordMetric("http_peer_out_timeout", { channelId: caller.channelId, meta: { peer: peer.name } });
}

/** 对方 messages/threads 响应里提取回复正文（wait 命中与轮询兑现同构）。
 *  导出仅为单测——这是对 api-routes ApiReplyResult 形状的契约。 */
export function extractReplyText(body: any): string | null {
  if (!body) return null;
  const r = body.reply ?? body.result?.reply ?? null;
  if (typeof r === "string" && r.trim()) return r.trim();
  if (r && typeof r.text === "string" && r.text.trim()) return r.text.trim();
  if (typeof body.text === "string" && body.text.trim() && body.answered) return body.text.trim();
  return null;
}

async function pushReply(caller: CallerRef, peer: HttpPeer, peerAgent: string, text: string, expecting?: string, callId?: string) {
  const bodyText = expecting
    ? `[💡 你之前 send_to_agent 给 peer ${peer.name}/${peerAgent} 时填的期望：${expecting}\n对方答复如下，请按计划继续，不要只 relay 给用户。]\n\n${text}`
    : text;
  await pushToCaller(caller, bodyText, peer, peerAgent, true, callId);
}

/** 以合成消息把文本推回 caller（与 Discord peer pushback 同款 envelope 形态）。
 *  调用已被用户接管取消(cancelHttpPeerCallsForChannel)的,静默丢弃不投。 */
async function pushToCaller(caller: CallerRef, content: string, peer: HttpPeer, peerAgent: string, isReply = false, callId?: string) {
  const d = deps;
  if (!d) return;
  if (callId && cancelledCalls.has(callId)) {
    console.log(`🚫 HTTP peer 调用已被用户接管取消,丢弃 pushback (${peer.name}/${peerAgent} → ${caller.channelId})`);
    return;
  }
  const env: Envelope = {
    from: {
      kind: "local",
      agentName: `peer ${peer.name}/${peerAgent}`,
      channelId: caller.channelId,
      ws: caller.ws,
    },
    to: {
      kind: "local",
      agentName: caller.name,
      channelId: caller.channelId,
      ws: caller.ws,
    },
    intent: isReply ? "response" : "notification",
    content,
    meta: {
      messageId: `hp_reply_${Date.now()}`,
      triggerKind: "peer_http",
      ts: new Date().toISOString(),
      threadId: newThreadId(),
    },
  };
  try {
    let delivery = await d.deliver(env);
    if (delivery.outcome.kind !== "sent" && d.getClientWs) {
      // 原 ws 已随 channel-server 重连失效——重查最新连接重投一次
      const freshWs = d.getClientWs(caller.channelId);
      if (freshWs && freshWs !== caller.ws) {
        (env.from as { ws?: unknown }).ws = freshWs;
        (env.to as { ws?: unknown }).ws = freshWs;
        delivery = await d.deliver(env);
      }
    }
    if (delivery.outcome.kind !== "sent") {
      console.error(`HTTP peer pushback 投递失败 (${peer.name}/${peerAgent}):`, delivery.outcome);
    }
  } catch (e) {
    console.error("HTTP peer pushback 异常:", e);
  }
}
