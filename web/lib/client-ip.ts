/**
 * 登录限流 / 累进封禁用的「客户端地址」（2026-09-23 D4-9）。
 *
 * 以前直接取 X-Forwarded-For 最左一项。但 web 监听 *:3333，直连（明文 LAN / tailnet IP）
 * 的客户端可以自己写 XFF，每次换一个就换一个桶——「每分钟 5 次」和累进封禁形同虚设，
 * 而这个登录背后校验的是本机 SSH 账号密码。
 *
 * 口径：
 *  - 对端（TCP 真实地址）不是本机 → 直连，XFF 是客户端自己写的，**只认对端地址**；
 *  - 对端是本机 → 来自本机反代（Caddy / tailscale serve），取 XFF **最右**一项
 *    （离我们最近的那一跳代理追加的；Caddy 默认还会整个覆盖不受信的 XFF）；
 *  - 拿不到对端（探针没装上，如 dev 下）→ 退回 XFF 最右一项，至少不再信最左。
 *
 * 对端地址 Next 的 Route Handler 拿不到（它只在 XFF 缺席时用 `??=` 补上 socket 地址），
 * 所以由 instrumentation 里装的 peer-stamp 在每个请求进来时写进 PEER_HEADER，
 * 并且总是覆盖——客户端伪造这个头没用。
 */

export const PEER_HEADER = "x-cstra-peer";

export function isLoopback(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
}

export function clientIp(h: { peer: string | null | undefined; xff: string | null | undefined }): string {
  const peer = (h.peer || "").trim();
  if (peer && !isLoopback(peer)) return peer;
  const hops = (h.xff || "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] || peer;
}

export function requestClientIp(request: Request): string {
  return clientIp({
    peer: request.headers.get(PEER_HEADER),
    xff: request.headers.get("x-forwarded-for"),
  });
}
