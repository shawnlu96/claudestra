/**
 * HTTP peer 出站 transport（design docs/design-http-peers.md §4）。peer = 另一个 Claudestra 实例：拿对方签的 Bearer
 * POST 它的 /api/v1/agents/:name/messages，对方入站与 web 客户端同路，无需对方新代码。
 * caller 看到的协议与本机 send_to_agent 一致：返回 {ok, pushBack:true}，回复 / 失败都以合成消息推回，不静默。
 * 超时链：wait=25s 同步等 → 202 → 每 30s GET /threads/:id 轮询，2 小时放弃；轮询中的调用落盘（peer-call-book.ts），
 * bridge 重启后接着轮询。**不自动重试 POST**——消息投递非幂等，重试=双发。
 */

export { sendLendRelay } from "./lend-relay-send.js";
import type { ServerWebSocket } from "bun";
import type { Envelope, Delivery } from "./router.js";
import { newMessageId, newThreadId } from "./router.js";
import { findHttpPeer, type HttpPeer } from "../lib/peers.js";
import { handoffEnd, handoffStart } from "../lib/handoff-log.js";
import { isLendWorkerName } from "../lib/lend-workers-view.js";
import { signedFor } from "../lib/instance-key.js";
import { peerAuthHint, peerCallFailureText, peerCallIsTimeout, peerErrorText } from "../lib/peer-auth-hints.js";
import { readJsonCapped } from "../lib/body-reader.js";
import { isE2eResponse } from "../lib/peer-e2e-client.js";
import { peerReplyText } from "../lib/peer-reply-files.js";
import { recordMetric } from "../lib/metrics.js";
import { startPeerPresence } from "./peer-presence.js";
import { initPush } from "./push/init.js";
import { peerFetch, startRelayLink } from "./relay-link.js";
import { PEER_CALLS_PATH, PeerCallBook, currentPeer, peerIdOf, resumePeerCalls, type PendingPeerCall } from "./peer-call-book.js";

export interface HttpPeerDeps {
  deliver: (env: Envelope) => Promise<Delivery>;
  /** 按 channelId 取 caller 当前 ws：原 ws 可能已随 channel-server 重连失效，恢复的调用则根本没有 */
  getClientWs?: (channelId: string) => ServerWebSocket<unknown> | null;
  /** 覆盖注入点（单测 fake fetch 用）；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** 单测覆盖:轮询间隔/放弃时限(生产别动) */
  pollIntervalMs?: number;
  pollGiveUpMs?: number;
  /** 经中继路径模式进来的请求在进程内调它（终端端点 + /api/v1），bridge.ts 注入 */
  handleApi?: (req: Request) => Promise<Response>;
  /** caller 此刻不在线（bridge 刚重启、channel-server 还没连上）时把推回放进押后队列，连上后投 */
  hold?: (env: Envelope) => void;
  /** 等回复的调用簿落盘位置；单测注入 fake fetch 时缺省不落盘 */
  callBookPath?: string | null;
  /** 恢复 / 轮询时按名字取 peer（单测注入）；缺省读 peers.json */
  findPeer?: (name: string) => Promise<HttpPeer | null>;
  /** 单测覆盖：peers.json 读不了时恢复的重试间隔 */
  resumeRetryMs?: number;
}

let deps: HttpPeerDeps | null = null;
let book = new PeerCallBook(null);
export function initHttpPeer(d: HttpPeerDeps) {
  deps = d;
  book = new PeerCallBook(d.callBookPath !== undefined ? d.callBookPath : d.fetchImpl ? null : PEER_CALLS_PATH);
  resumeFromBook();
  startPeerPresence(); // 在线 peer 列表（peer-presence.ts）
  if (d.fetchImpl) return; // 单测注入 fake fetch：不连中继、不起推送（两者都要真实的磁盘状态）
  void startRelayLink({ handleApi: d.handleApi }); // 中继链路（relay-link.ts）
  initPush(d.deliver); // 推送派发器 + /api/v1/push 路由 + 订阅额度提醒（push/init.ts）；出口按中继在不在线选网关 / 直发
}

/** 出站 wait 秒数。长挂 POST 跨 tailnet 常被中间设备掐，拿到 202 之前就断 → 连 threadId 都没有、回复必丢；
 *  短 wait 保证回执线程几乎必达，慢回复交给轮询 + 空回合守候（git log -S WAIT_SEC）。 */
const WAIT_SEC = 25;
/** 单次 POST 的硬超时（wait + 网络余量） */
const POST_TIMEOUT_MS = (WAIT_SEC + 15) * 1000;
/** thread 轮询间隔 / 放弃时限 */
const POLL_INTERVAL_MS = 30_000;
// 长任务（编译 / 审计 / 大重构）动辄 30–60 分钟，所以等 2 小时；对侧结果留存窗口配套放宽（api-routes）
const POLL_GIVE_UP_MS = 2 * 3600_000;

interface CallerRef {
  /** 发起时的连接；从调用簿恢复的调用没有，推回时按 channelId 现取 */
  ws?: ServerWebSocket<unknown>;
  channelId: string;
  name: string;
  onDelivered?: () => void; // 只在发起时有；不进调用簿
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
      book.delete(callId); // 取消要落盘：否则轮询还没退出时重启，会把已取消的调用又恢复出来
      n++;
    }
  }
  return n;
}

/**
 * 出站主入口。**同步阶段**只做参数构造——立即给 caller 回 MCP response
 * （ok+pushBack），真正的 HTTP 往返在后台进行，结果一律以合成消息推回。
 */
export function routeToHttpPeer(
  ws: ServerWebSocket<unknown>,
  fromChannelId: string,
  fromName: string,
  peer: HttpPeer,
  peerAgentName: string,
  text: string,
  expecting?: string,
  oneShot = false,
  onDelivered?: () => void, // 对方 2xx 收下之后才调（PM 带 ask id 的回话记成已答）；POST 失败 / 被拒不调
): { ok: true; targetName: string; pushBack: boolean } {
  const caller: CallerRef = { ws, channelId: fromChannelId, name: fromName, onDelivered };
  const callId = `hp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (isLendWorkerName(peerAgentName)) oneShot = true; // 出借 worker 没有 reply，只走 ask 回话：不挂 2 小时轮询、不进调用簿（i28-W6）
  // oneShot 是 FYI 通知，不等回复，不算一次交接
  if (!oneShot) void handoffStart(callId, { dir: "out", peer: peer.name, localAgent: fromName, remoteAgent: peerAgentName }, text.length);
  track(callId, fromChannelId, () => runCall(callId, caller, peer, peerAgentName, text, expecting, oneShot));
  return { ok: true, targetName: `peer:${peer.name}.${peerAgentName}`, pushBack: !oneShot };
}

/** 在飞登记（用户接管 / kill 时按 caller 频道取消），无论什么结局都清掉 */
function track(callId: string, callerChannelId: string, run: () => Promise<void>): void {
  inflightHttpPeerCalls.add(callId);
  inflightByCaller.set(callId, callerChannelId);
  void run().finally(() => {
    inflightHttpPeerCalls.delete(callId);
    inflightByCaller.delete(callId);
    cancelledCalls.delete(callId);
  });
}

/**
 * 一次出站调用的结局：运维 metric 照记，再给交接记录结账（lib/handoff-log.ts）。
 * 「对方回合结束但没文本」（empty）还会继续轮询，不算结局。
 */
function settle(
  callId: string,
  caller: CallerRef,
  metric: "http_peer_out_ok" | "http_peer_out_error" | "http_peer_out_timeout",
  meta: Record<string, unknown>,
  replyChars?: number,
): void {
  recordMetric(metric, { channelId: caller.channelId, meta });
  if (meta.empty || meta.mode === "oneshot") return;
  if (metric === "http_peer_out_ok") void handoffEnd(callId, "reply", replyChars !== undefined ? { chars: replyChars } : {});
  else void handoffEnd(callId, metric === "http_peer_out_timeout" ? "timeout" : "error", { detail: String(meta.kind ?? "") });
}

async function runCall(
  callId: string,
  caller: CallerRef,
  peer: HttpPeer,
  peerAgentName: string,
  text: string,
  expecting?: string,
  // oneShot = fire-and-forget：wait:0 立即 202，不轮询、不推回复、不报超时；投递失败仍推回（失败绝不静默）
  oneShot = false,
) {
  const d = deps;
  if (!d) return;
  const f = d.fetchImpl ?? fetch;
  // oneShot 只等 202 回执,15s 足够;常规调用等 wait 同步窗口 + 网络余量
  const postTimeoutMs = oneShot ? 15_000 : POST_TIMEOUT_MS;
  const base = (peer.baseUrl || "").replace(/\/+$/, "");
  const label = `peer ${peer.name}/${peerAgentName}`;

  let res: Response;
  try {
    const url = `${base}/api/v1/agents/${encodeURIComponent(peerAgentName)}/messages`;
    const body = JSON.stringify({ text, wait: oneShot ? 0 : WAIT_SEC, nonce: crypto.randomUUID(), acceptsReplyFiles: true }); // nonce：同一秒同样的正文签名也不同，不会被对方当成重放；acceptsReplyFiles：回复里的 files 会推给 caller
    res = await peerFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${peer.outToken || ""}`,
        "Content-Type": "application/json",
        ...signedFor("POST", url, body), // 实例签名（lib/instance-key.ts），对方凭它认定是我本人（lib/peer-trust.ts）
      },
      body,
      signal: AbortSignal.timeout(postTimeoutMs),
    }, { fetchImpl: f, timeoutMs: postTimeoutMs }); // relay:// 的 peer 经中继（relay-link.ts），其余原样 fetch
  } catch (e) {
    // 结局分类：超时时消息多半已送达，统一说成「网络不可达」会诱发重复投递；中继入站的拒绝按原因说（lib/peer-auth-hints.ts）
    const isTimeout = peerCallIsTimeout(e);
    await pushToCaller(
      caller,
      isTimeout
        ? `[⚠️ peer 调用超时] ${label} 在 ${Math.round(postTimeoutMs / 1000)}s 内没返回回执。消息**可能已送达**但未取得回执线程,回复无法自动取回——不要立刻重发,对方在线的话稍后重问一次即可。`
        : peerCallFailureText(label, e, peer.name),
      peer, peerAgentName, false, callId,
    );
    settle(callId, caller, "http_peer_out_error", { peer: peer.name, kind: isTimeout ? "post_timeout" : "network" });
    return;
  }

  const body: any = await readJsonCapped(res); // 有上限地读（lib/body-reader.ts）；超限 / 非 JSON 为 null，按状态码兜底
  const errText = (fallback: string) => peerErrorText(isE2eResponse(res), body, fallback, peer.name); // 明文的 error 文字不进 agent

  if (res.status === 401 || res.status === 403 || res.status === 429) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 拒绝了请求（${res.status}：${errText("token 无效或 agent 不在授权范围")}）。${peerAuthHint(body)}。`, peer, peerAgentName, false, callId);
    settle(callId, caller, "http_peer_out_error", { peer: peer.name, kind: "auth", status: res.status });
    return;
  }
  if (res.status === 404 || res.status === 409) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label}：${errText(`对方 agent 不存在或离线（${res.status}）`)}`, peer, peerAgentName, false, callId);
    settle(callId, caller, "http_peer_out_error", { peer: peer.name, kind: "target", status: res.status });
    return;
  }
  if (!res.ok && res.status !== 202) {
    await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 返回 ${res.status}：${errText("未知错误")}`, peer, peerAgentName, false, callId);
    settle(callId, caller, "http_peer_out_error", { peer: peer.name, kind: "http", status: res.status });
    return;
  }
  try { caller.onDelivered?.(); } catch (e) { console.error(`⚠️ ${label} 投递后回调失败：${(e as Error).message}`); } // 出错不影响取回复

  // oneShot:对方已接收(2xx)即完成——不取回复不轮询,让对方按 FYI 处理
  if (oneShot) return settle(callId, caller, "http_peer_out_ok", { peer: peer.name, mode: "oneshot" });

  // 同步拿到回复（wait 命中）
  const replyText = peerReplyText(body, peer.name); // 附件只带引用，不带文件本身（lib/peer-reply-files.ts）
  if (replyText) {
    await pushReply(caller, peer, peerAgentName, replyText, expecting, callId);
    settle(callId, caller, "http_peer_out_ok", { peer: peer.name, mode: "wait" }, replyText.length);
    return;
  }
  // v2.17.2 任务#84:200 且 reply 空 = 对方回合结束但没有文本回复。此前这里直接
  // 终止——但对方常在下一个回合才补正式回复(迟到 reply 在对方侧 2h 内仍会写回
  // 原 threadId,apiThreadResults.set 按 threadId 覆写)——弃守就是把它永远丢掉
  // (Shawn-2 丢 bug 报告实锤)。改为:通知一次 + 继续轮询到期限。
  let emptyNoticed = false;
  if (res.status === 200 && body && body.ok && "reply" in body && !String(body.reply ?? "").trim()) {
    emptyNoticed = true;
    await pushToCaller(caller, `[🤖 peer ${peer.name}/${peerAgentName}] 对方回合已结束但没有文本回复。我会继续盯 2 小时——对方补回复会自动送达。`, peer, peerAgentName, false, callId);
    settle(callId, caller, "http_peer_out_ok", { peer: peer.name, mode: "wait", empty: true });
  }

  // 202 / wait 超时未答 → thread 轮询兜底
  const threadId: string | undefined = typeof body?.thread_id === "string" ? body.thread_id : typeof body?.threadId === "string" ? body.threadId : undefined;
  if (!threadId) {
    await pushToCaller(caller, `[⚠️ peer 调用] ${label} 已接收请求但未返回可追踪的 thread——对方版本可能过旧，回复无法自动送达。`, peer, peerAgentName, false, callId);
    void handoffEnd(callId, "error", { detail: "no_thread" });
    return;
  }
  const deadline = Date.now() + (d.pollGiveUpMs ?? POLL_GIVE_UP_MS);
  const rec: PendingPeerCall = { callerChannelId: caller.channelId, callerName: caller.name, peerName: peer.name, peerAgent: peerAgentName,
    threadId, expecting, emptyNoticed, deadline, peerId: peerIdOf(peer) };
  book.set(callId, rec);
  await pollThread(callId, caller, peer, rec);
}

/** 轮询对方 thread，直到拿到回复 / 鉴权被拒 / 发起方被用户接管 / 过了截止时间；每种结局都从调用簿摘掉 */
async function pollThread(callId: string, caller: CallerRef, peer: HttpPeer, rec: PendingPeerCall): Promise<void> {
  const d = deps;
  if (!d) return;
  const f = d.fetchImpl ?? fetch;
  const { threadId, expecting, peerAgent: peerAgentName } = rec;
  const label = `peer ${peer.name}/${peerAgentName}`;
  const pollMs = d.pollIntervalMs ?? POLL_INTERVAL_MS;
  try {
    while (Date.now() < rec.deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (cancelledCalls.has(callId)) {
        void handoffEnd(callId, "error", { detail: "cancelled" });
        return;
      }
      // 每拍重读：token 轮换后用新的；peer 删了 / 同名换成别的实例就别再拿旧凭据去问（读不了 peers.json 这拍照旧）
      const cur = await currentPeer(rec, d.findPeer ?? findHttpPeer);
      if (cur === null) {
        await pushToCaller(caller, `[⚠️ peer 调用] ${label} 在等回复期间被删除或换成了别的实例，回复不再跟踪。`, peer, peerAgentName, false, callId);
        void handoffEnd(callId, "error", { detail: "peer_gone" });
        return;
      }
      if (cur) peer = cur;
      const base = (peer.baseUrl || "").replace(/\/+$/, "");
      try {
        const pollUrl = `${base}/api/v1/threads/${encodeURIComponent(threadId)}`;
        const pr = await peerFetch(pollUrl, {
          headers: { Authorization: `Bearer ${peer.outToken || ""}`, ...signedFor("GET", pollUrl, "") },
          signal: AbortSignal.timeout(15_000),
        }, { fetchImpl: f, timeoutMs: 15_000 });
        if (pr.status === 404) continue; // 还没答
        // 鉴权失败不是瞬时故障——对方 revoke/轮换了 token,继续轮只是空转 10 分钟
        // 再误报「超时」(review 2026-07-19 #7)
        if (pr.status === 401 || pr.status === 403) {
          const why = peerAuthHint(await readJsonCapped(pr)) /* 不是 JSON：按 token 问题提示 */;
          await pushToCaller(caller, `[⚠️ peer 调用失败] ${label} 在等待回复期间拒绝了鉴权（${pr.status}）——${why}。`, peer, peerAgentName, false, callId);
          settle(callId, caller, "http_peer_out_error", { peer: peer.name, kind: "auth_poll", status: pr.status });
          return;
        }
        if (!pr.ok) continue;            // 瞬时故障,下轮再试
        const pb: any = await readJsonCapped(pr);
        const t = peerReplyText(pb, peer.name);
        if (t) {
          await pushReply(caller, peer, peerAgentName, t, expecting, callId);
          settle(callId, caller, "http_peer_out_ok", { peer: peer.name, mode: "poll" }, t.length);
          return;
        }
        // 空回合结束:通知一次后继续轮询(任务#84,同上——迟到回复会按 threadId
        // 覆写结果,下一拍就能取到;弃守=永久丢失)
        if (!rec.emptyNoticed && pb && pb.ok && "reply" in pb && !String(pb.reply ?? "").trim()) {
          rec.emptyNoticed = true;
          book.set(callId, rec);
          await pushToCaller(caller, `[🤖 peer ${peer.name}/${peerAgentName}] 对方回合已结束但没有文本回复。我会继续盯 2 小时——对方补回复会自动送达。`, peer, peerAgentName, false, callId);
        }
      } catch {
        /* 单轮失败不放弃 */
      }
    }
    await pushToCaller(
      caller,
      rec.emptyNoticed
        ? `[ℹ️ peer 调用收尾] ${label} 空回合结束后 ${Math.round(POLL_GIVE_UP_MS / 60000)} 分钟内没有补回复，线程停止跟踪。需要的话稍后再问一次。`
        : `[⚠️ peer 调用超时] ${label} 在 ${Math.round((WAIT_SEC * 1000 + POLL_GIVE_UP_MS) / 60000)} 分钟内没有回复。对方可能仍在处理——需要的话稍后再问一次。`,
      peer, peerAgentName, false, callId,
    );
    settle(callId, caller, "http_peer_out_timeout", { peer: peer.name });
  } finally {
    book.delete(callId);
  }
}

/** bridge 启动时把上次没等到回复的跨机调用接着轮询（截止时间不重算；发起方多半还没连上，推回走押后分支） */
function resumeFromBook(): void {
  const d = deps;
  if (!d || !book.size) return;
  console.log(`♻️ 恢复等待中的跨机调用 ${book.size} 条（接着轮询对方的回复）`);
  const callerOf = (rec: PendingPeerCall): CallerRef => ({ channelId: rec.callerChannelId, name: rec.callerName });
  resumePeerCalls(book, d.findPeer ?? findHttpPeer, {
    poll: (callId, rec, peer) => track(callId, rec.callerChannelId, () => pollThread(callId, callerOf(rec), peer, rec)),
    gone: (rec) => pushToCaller(callerOf(rec), `[⚠️ peer 调用] 重启后找不到 peer ${rec.peerName}（已删除或换了实例），${rec.peerAgent} 的回复不再跟踪。`, { name: rec.peerName } as HttpPeer, rec.peerAgent),
  }, d.resumeRetryMs);
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
  const ws = (caller.ws ?? d.getClientWs?.(caller.channelId) ?? undefined) as ServerWebSocket<unknown>;
  // messageId 按 callId 派生：重启后同一条推回再推一次时 ID 不变，收件方认得出是重复
  const messageId = callId ? `hp_${callId}_${isReply ? "reply" : Bun.hash(content).toString(36)}` : newMessageId("hp_reply");
  const env: Envelope = {
    from: { kind: "local", agentName: `peer ${peer.name}/${peerAgent}`, channelId: caller.channelId, ws },
    to: { kind: "local", agentName: caller.name, channelId: caller.channelId, ws },
    intent: isReply ? "response" : "notification",
    content,
    // bridge 合成的推回不挂「没回应」看门狗；以前靠 from.ws === to.ws 躲开，押后剥掉 ws 后就对不上了（tests/http-peer-resume.test.ts）
    meta: { messageId, triggerKind: "peer_http", ts: new Date().toISOString(), threadId: newThreadId(), skipInterAgentWatchdog: true },
  };
  if (!ws) {
    // 发起方此刻不在线（多半是 bridge 刚重启、它的 channel-server 还没连上）：进押后队列，连上后投
    if (d.hold) d.hold(env);
    console.log(`⏸ ${caller.name} 不在线,peer ${peer.name}/${peerAgent} 的推回${d.hold ? "进押后队列" : "丢弃（没有押后队列）"}`);
    return;
  }
  try {
    let delivery = await d.deliver(env);
    if (delivery.outcome.kind !== "sent" && d.getClientWs) {
      // 原 ws 已随 channel-server 重连失效——重查最新连接重投一次
      const freshWs = d.getClientWs(caller.channelId);
      if (freshWs && freshWs !== ws) {
        (env.from as { ws?: unknown }).ws = freshWs;
        (env.to as { ws?: unknown }).ws = freshWs;
        delivery = await d.deliver(env);
      }
    }
    if (delivery.outcome.kind === "sent") return;
    console.error(`HTTP peer pushback 投递失败 (${peer.name}/${peerAgent})，进押后队列:`, delivery.outcome);
  } catch (e) {
    console.error("HTTP peer pushback 异常，进押后队列:", e);
  }
  d.hold?.(env); // 调用方接着会把这条调用从簿里摘掉：投不出去也得有持久的地方接住，否则对方的回复就丢了（codex 2026-09-28 复核）
}
