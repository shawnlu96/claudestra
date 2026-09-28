/**
 * 请求来源上下文（docs/design-hosted-frontend.md §6）。bridge 里「谁在调 API」有三种来源，权限完全不同：
 *   loopback  真实回环 socket（本机进程、本机浏览器）——回环豁免只认它；
 *   lan       非回环 socket（局域网 / Tailscale 直连）；
 *   relay     经中继隧道、由 relay-dispatch 在进程内直接调进来的请求——它从没经过 socket，
 *             绝不能因为「bridge 在 127.0.0.1 上」被当成回环。
 * 上下文挂在 Request 对象上（WeakMap），入口处设、鉴权处读；没设过的按 lan（最小权限）。
 */
type RequestSource = "loopback" | "lan" | "relay";

export interface RequestContext {
  source: RequestSource;
  /** 展示与限流用，不作身份：经中继时是中继转来的 X-Forwarded-For，可伪造程度与任何反代相同 */
  clientIp: string | null;
  /** 经中继时的中继主机名 */
  relayBase?: string;
  /** 经中继时这台机器的路径前缀 `/m/<fp>`；cookie Path、绝对地址都要带它 */
  pathPrefix?: string;
  /** 浏览器看到的是不是 https（回环 http 不能设 Secure cookie） */
  https: boolean;
  /** 经中继时：中继看到的浏览器出口 IP 与这台机器连中继的出口 IP 相同（同一网络，不代表同一台电脑） */
  sameNetwork?: boolean;
  /** 经中继 peer 帧来、且 peer 入口核过进程内标记的发件人指纹（peer-ingress.ts）；别的入口永远没有，别读原始头 */
  relayFrom?: string;
}

const contexts = new WeakMap<Request, RequestContext>();
const LEAST_PRIVILEGE: RequestContext = { source: "lan", clientIp: null, https: false };

export function setRequestContext(req: Request, ctx: RequestContext): void {
  contexts.set(req, ctx);
}

export function requestContextOf(req: Request): RequestContext {
  return contexts.get(req) ?? LEAST_PRIVILEGE;
}
