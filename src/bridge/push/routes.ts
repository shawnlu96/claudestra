/**
 * 推送与未读的 /api/v1 端点（契约 docs/design-hosted-frontend.md §13.3；在 bridge/api-extensions.ts 登记）：
 *   GET  /push/config                          {webPush:{vapidPublicKey}|null, apns, mode}
 *   POST /push/subscriptions {subscription, userAgent, vapidKey?} · DELETE /push/subscriptions {endpoint}
 *   POST /push/apns {token, device?}           · DELETE /push/apns/:token
 *   GET  /unread → {counts}   POST /agents/:name/read → {ok}   GET /reads → {reads: {agent: isoTs}}
 * 只给 owner（canManage：owner 设备凭据 / 过渡期的全 scope token）——未读是 owner 一个人的状态。例外（T11b）：guest 等别的设备凭据
 * 也能 GET /push/config 与订阅 / 退订 Web Push，订阅记成 guest、只收指派给自己的「待你处理」，退订只删得掉自己的（guestPush）。
 * 订阅的 endpoint 按 SSRF 规则先验（lib/push-endpoint.ts），中继那边还会再验一次。
 */
import type { Database } from "bun:sqlite";
import { canManage } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { pushEndpointProblem } from "../../lib/push-endpoint.js";
import { isSandbox, sandboxPushEndpointProblem } from "../../lib/sandbox.js";
import { deleteApnsDevice, deletePushSubscription, saveApnsDevice, savePushSubscription, type PushSubscriber } from "../../lib/push-store.js";
import { APNS_TOKEN_RE, asWebPushSubscription } from "../../lib/relay-protocol.js";
import { markAllRead, markAgentRead, pruneUnread, readMarks, unreadCounts } from "../../lib/unread-store.js";
import { apiJson, forbidden } from "../api-respond.js";
import type { ExtensionHandler } from "../api-extensions.js";
import type { PushSender } from "./sender.js";

export interface PushRouteDeps {
  db: Database;
  sender: PushSender;
  /** 当前存在的 agent 名（registry）；GET /unread 顺手清掉已删 agent 的未读行 */
  liveAgents: () => Promise<string[]>;
}

const PREFIX = "/api/v1";
const READ_RE = /^\/api\/v1\/agents\/([^/]+)\/read$/;
const APNS_RE = /^\/api\/v1\/push\/apns\/([^/]+)$/;
/** agent 名：与 registry 的名字一致即可，只挡控制字符与超长 */
const AGENT_NAME_OK = (s: string) => s.length > 0 && s.length <= 64 && !/[\s/\\\x00-\x1f]/.test(s);

async function body(req: Request): Promise<Record<string, unknown>> {
  const v = await req.json().catch(() => null); // 空 body / 坏 JSON 都按空对象：各端点自己报缺哪个字段
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function mine(url: URL): boolean {
  const p = url.pathname;
  return p.startsWith(`${PREFIX}/push/`) || p === `${PREFIX}/unread` || p === `${PREFIX}/reads` || p === `${PREFIX}/agents/read-all` || READ_RE.test(p);
}

export function createPushRoutes(d: PushRouteDeps): ExtensionHandler {
  return async (req, url, principal) => {
    if (!mine(url)) return null;
    if (!canManage(principal)) return guestPush(d, req, url, principal);
    const p = url.pathname;
    const m = req.method.toUpperCase();
    const who: PushSubscriber = { audience: "owner", principal: principal.id, ...(principal.credential ? { credential: principal.credential } : {}) };
    if (p === `${PREFIX}/push/config` && m === "GET") return apiJson(200, d.sender.config());
    if (p === `${PREFIX}/push/subscriptions` && m === "POST") return subscribe(d, req, await body(req), who);
    if (p === `${PREFIX}/push/subscriptions` && m === "DELETE") {
      const { endpoint } = await body(req);
      if (typeof endpoint !== "string" || !endpoint) return apiJson(400, { ok: false, error: '"endpoint" required' });
      return apiJson(200, { ok: true, removed: deletePushSubscription(d.db, endpoint) });
    }
    if (p === `${PREFIX}/push/apns` && m === "POST") {
      const b = await body(req);
      if (typeof b.token !== "string" || !APNS_TOKEN_RE.test(b.token)) return apiJson(400, { ok: false, error: "token invalid" });
      saveApnsDevice(d.db, b.token, typeof b.device === "string" ? b.device : "", new Date(), who);
      return apiJson(200, { ok: true, configured: d.sender.config().apns });
    }
    const apns = APNS_RE.exec(p);
    if (apns && m === "DELETE") return apiJson(200, { ok: true, removed: deleteApnsDevice(d.db, decodeURIComponent(apns[1])) });
    if (p === `${PREFIX}/unread` && m === "GET") {
      pruneUnread(d.db, await d.liveAgents().catch(() => [])); // registry 读不到就不清孤儿：这次多显示几个数，下次再清
      return apiJson(200, { counts: unreadCounts(d.db) });
    }
    if (p === `${PREFIX}/reads` && m === "GET") return apiJson(200, { reads: readMarks(d.db) });
    if (p === `${PREFIX}/agents/read-all` && m === "POST") return apiJson(200, { ok: true, cleared: markAllRead(d.db) });
    const read = READ_RE.exec(p);
    if (read && m === "POST") {
      const agent = decodeURIComponent(read[1]).trim();
      if (!AGENT_NAME_OK(agent)) return apiJson(400, { ok: false, error: "agent name invalid" });
      markAgentRead(d.db, agent);
      return apiJson(200, { ok: true });
    }
    return null;
  };
}

/** 不是 owner 的设备凭据（guest、manage=false 的设备）：只能看配置、订阅 / 退订自己的 Web Push；peer 与没有设备凭据的 token 一律不行 */
async function guestPush(d: PushRouteDeps, req: Request, url: URL, principal: Principal): Promise<Response> {
  const p = url.pathname;
  const m = req.method.toUpperCase();
  const device = !!principal.credential && !principal.peer && !principal.disabled;
  if (!device || !(p === `${PREFIX}/push/config` || p === `${PREFIX}/push/subscriptions`)) return forbidden("push and unread endpoints require the owner");
  if (m === "GET" && p === `${PREFIX}/push/config`) return apiJson(200, d.sender.config());
  if (m === "POST" && p === `${PREFIX}/push/subscriptions`) {
    return subscribe(d, req, await body(req), { audience: "guest", principal: principal.id, credential: principal.credential });
  }
  if (m === "DELETE" && p === `${PREFIX}/push/subscriptions`) {
    const { endpoint } = await body(req);
    if (typeof endpoint !== "string" || !endpoint) return apiJson(400, { ok: false, error: '"endpoint" required' });
    return apiJson(200, { ok: true, removed: deletePushSubscription(d.db, endpoint, principal.id) });
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}

function subscribe(d: PushRouteDeps, req: Request, b: Record<string, unknown>, who: PushSubscriber): Response {
  const sub = asWebPushSubscription(b.subscription);
  if (!sub) return apiJson(400, { ok: false, error: "subscription invalid (endpoint https + keys.p256dh/auth required)" });
  // lab 沙箱（沙箱里只有 lab 挂这些路由）只收 lab 假推送端点的订阅，真推送服务的订阅一律拒
  const problem = isSandbox() ? sandboxPushEndpointProblem(sub.endpoint) : pushEndpointProblem(sub.endpoint);
  if (problem) return apiJson(400, { ok: false, error: "endpoint_forbidden" });
  const ua = typeof b.userAgent === "string" && b.userAgent ? b.userAgent : req.headers.get("user-agent") || "";
  // 浏览器报的公钥只认本机签得了的；老前端不报就按此刻 config 给出去的那把记（记错了投递时会换路并改正）
  const known = d.sender.webPushKeys();
  const vapidKey = typeof b.vapidKey === "string" && known.includes(b.vapidKey) ? b.vapidKey : (d.sender.config().webPush?.vapidPublicKey ?? null);
  savePushSubscription(d.db, sub, ua, vapidKey, new Date(), who);
  return apiJson(200, { ok: true });
}

// ── 登记进 api-extensions 的那一个 handler：deps 由 init.ts 在启动时配好 ──────────
let live: ExtensionHandler | null = null;

export function configurePushRoutes(d: PushRouteDeps): void {
  live = createPushRoutes(d);
}

export const pushRoutes: ExtensionHandler = (req, url, principal: Principal) => {
  if (live) return live(req, url, principal);
  if (!mine(url)) return null;
  return apiJson(503, { ok: false, error: "push not initialized" });
};
