/**
 * 路径模式的入站请求（front 加了 x-claudestra-relay-mode: api）在 bridge 进程内直接调 API 处理器：不经回环 HTTP，
 * 所以永远不会被当成回环来源享受豁免（docs/design-hosted-frontend.md §6）。请求上下文 source:"relay"，
 * 客户端 IP 取中继转来的 X-Forwarded-For，只作展示与节流。路径再核一次必须在 /api/v1 下（中继已核，两端都查）。
 */
import { apiPathOk, isRedeemRequest, RELAY_BASE_HEADER } from "../lib/relay-protocol.js";
import { RELAY_MODE_HEADER, RELAY_PREFIX_HEADER, RELAY_SAME_NET_HEADER } from "../lib/relay-machine-path.js";
import { forwardHeaders, gzipJson, headersToObject } from "../lib/relay-stream.js";
import { RelayError, type InboundContext, type InboundRequest, type InboundResponse } from "../lib/relay-client-types.js";
import { setRequestContext } from "./request-context.js";
import { renewDeviceCookie } from "./device-cookie-renew.js";

export type ApiHandler = (req: Request) => Promise<Response>;

const REDEEM_REFUSED = new TextEncoder().encode(JSON.stringify({ ok: false, error: "invites are not redeemed on the relay path", code: "redeem_via_relay_path" }));

const DROP_REQUEST: ReadonlySet<string> = new Set([
  "host", RELAY_MODE_HEADER, RELAY_PREFIX_HEADER, RELAY_SAME_NET_HEADER, RELAY_BASE_HEADER, "x-claudestra-relay-mark", "x-claudestra-relay-from",
]);

export async function dispatchMachineRequest(req: InboundRequest, ctx: InboundContext, handleApi: ApiHandler): Promise<InboundResponse> {
  if (!apiPathOk(req.path)) throw new RelayError("path_forbidden", "client", `${req.path} is not under /api/v1`);
  const method = req.method.toUpperCase();
  // 兑换邀请只走 peer 帧（带发起方签名）或直连；浏览器没有理由在路径模式里兑换
  if (isRedeemRequest(method, req.path)) return { status: 403, headers: { "content-type": "application/json" }, body: REDEEM_REFUSED };
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers = forwardHeaders(req.headers, (k) => DROP_REQUEST.has(k));
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: ctx.signal, ...(hasBody ? { body: req.body, duplex: "half" } : {}) };
  const request = new Request(`http://relay.local${req.path}`, init);
  setRequestContext(request, {
    source: "relay",
    https: true,
    clientIp: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null,
    ...(req.headers[RELAY_BASE_HEADER] ? { relayBase: req.headers[RELAY_BASE_HEADER] } : {}),
    ...(req.headers[RELAY_PREFIX_HEADER] ? { pathPrefix: req.headers[RELAY_PREFIX_HEADER] } : {}),
    ...(req.headers[RELAY_SAME_NET_HEADER] === "1" ? { sameNetwork: true } : {}),
  });
  const r = renewDeviceCookie(request, await handleApi(request)); // 设备 cookie 随使用续发，iOS 7 天清 cookie 也掉不了配对
  return { status: r.status, ...(await gzipJson(headersToObject(r.headers), r.body, req.headers["accept-encoding"])) };
}
