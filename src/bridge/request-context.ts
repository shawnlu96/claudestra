/**
 * 请求来源上下文（docs/design-hosted-frontend.md §6）。bridge 里「谁在调 API」有四种来源，权限完全不同：
 *   loopback  真实回环 socket（本机进程、本机浏览器）——回环豁免只认它；
 *   lan       非回环 socket（局域网 / Tailscale 直连）；
 *   relay     经中继隧道、由 relay-dispatch 在进程内直接调进来的请求——它从没经过 socket，
 *             绝不能因为「bridge 在 127.0.0.1 上」被当成回环；
 *   peer-ingress  peer 入口上对外直连或中继转来的 peer 帧（peer-ingress.ts）：只认 peer token，设备端点与设备凭据一律拒；
 *   unknown   没设过上下文的请求：下面的白名单一个都不认它。漏设只会误拒，不会被当成某个有权限的来源。
 * 上下文挂在 Request 对象上（WeakMap），入口处设、鉴权处读。按来源放行一律查 sourceAllows，不写「不是 relay 就放」这种排除式判断。
 */
export type RequestSource = "loopback" | "lan" | "relay" | "peer-ingress" | "unknown";

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
const LEAST_PRIVILEGE: RequestContext = { source: "unknown", clientIp: null, https: false };

/**
 * 各类凭据与入口按来源的正向白名单（权限矩阵：tests/peer-ingress-sources.test.ts）：
 *   device   设备 cookie 与 /api/v1/devices/* 公开端点：peer 入口没有设备身份；
 *   legacy   旧 web 会话换设备凭据：只在直托管同源成立，中继路径与隧道都不算；
 *   peer     peer token：经中继的 peer 请求只走 peer 帧进 peer 入口，路径模式与隧道一律拒；
 *   redeem   兑换邀请：同上，合法兑换只走 peer 帧或直连；
 *   api      /api/v1 的任何凭据（Bearer、设备 cookie）：四个已知来源都认，只拒没定来源的（unknown）。
 */
const SOURCE_POLICY = {
  api: ["loopback", "lan", "relay", "peer-ingress"],
  device: ["loopback", "lan", "relay"],
  legacy: ["loopback", "lan"],
  peer: ["loopback", "lan", "peer-ingress"],
  redeem: ["loopback", "lan", "peer-ingress"],
} as const satisfies Record<string, readonly RequestSource[]>;

export function sourceAllows(req: Request, what: keyof typeof SOURCE_POLICY): boolean {
  return (SOURCE_POLICY[what] as readonly RequestSource[]).includes(requestContextOf(req).source);
}

export function setRequestContext(req: Request, ctx: RequestContext): void {
  contexts.set(req, ctx);
}

export function requestContextOf(req: Request): RequestContext {
  return contexts.get(req) ?? LEAST_PRIVILEGE;
}
