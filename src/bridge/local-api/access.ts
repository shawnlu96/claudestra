/**
 * 网页「访问」页的总览（web/features/chat/components/access-paths.tsx）：手机能经哪几条路连到这台电脑。
 *   GET /api/v1/access-paths → { relay: {enabled, connected, state, home}, lan: {bind, bindAll, urls} }
 * Tailscale 与反代入口另走 /api/v1/remote-access（要起子进程 + TLS 探测，60 秒缓存），这里只给不花钱的两项。
 * 要 manage：局域网地址、监听地址都是机器信息。
 */
import { canManage } from "../../lib/devices.js";
import { detectBridgeUrls } from "../../lib/net-addr.js";
import type { Principal } from "../../lib/principals.js";
import { isWildcardBind } from "../../lib/tailscale.js";
import { apiJson, forbidden } from "../api-respond.js";
import { BRIDGE_PORT } from "../config.js";
import { relayInfo } from "../relay-link.js";

interface Deps {
  bind: () => string;
  lanUrls: () => string[];
  relay: () => { enabled: boolean; connected: boolean; state: string | null; base: string | null };
}
const realDeps: Deps = {
  bind: () => process.env.BRIDGE_BIND || "127.0.0.1",
  lanUrls: () => detectBridgeUrls(BRIDGE_PORT).filter((c) => c.kind === "lan").map((c) => c.url),
  relay: relayInfo,
};
let deps = realDeps;
/** 单测注入监听地址 / 网卡 / 中继状态；生产不调 */
export function setAccessDepsForTest(d: Partial<Deps> | undefined): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

export function handleAccessPaths(req: Request, path: string, principal: Principal): Response | null {
  if (path !== "/access-paths" || req.method !== "GET") return null;
  if (!canManage(principal)) return forbidden("access-paths requires a credential with manage grant");
  const bind = deps.bind();
  // 只听回环时局域网地址打不开：照样报出来（前端据此说「改 BRIDGE_BIND 就能用」），但标明没开
  const bindAll = isWildcardBind(`${bind}:${BRIDGE_PORT}`);
  const r = deps.relay();
  return apiJson(200, {
    ok: true,
    relay: { enabled: r.enabled, connected: r.connected, state: r.state, home: r.base ? `https://${r.base}` : null },
    lan: { bind, bindAll, urls: deps.lanUrls() },
  });
}
