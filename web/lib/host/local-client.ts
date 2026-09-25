/**
 * 「这个浏览器是不是跑在服务器这台机器上」的纯逻辑（无 import，tests/ 直测）。
 *
 * 客户端 IP 来自 x-forwarded-for：Next 在没有该头时会用 socket.remoteAddress 补上
 * （base-server：`req.headers['x-forwarded-for'] ??= socket.remoteAddress`），经反代
 * （Caddy / tailscale serve）时则是反代写的真实客户端。⚠ 直连的客户端自己伪造这个头
 * Next 不会覆盖——只有已登录用户能到这些路由，最坏结果是在 owner 的机器上弹一个 Finder 窗，可接受。
 *
 * 判定：客户端 IP 属于本机任一网卡地址（loopback / LAN / tailnet 100.x）→ 本地。这样在本机用
 * localhost、局域网 IP、自己的 tailnet 域名打开都算本地；手机、别的电脑一律不算。
 */

/** x-forwarded-for 的第一跳，去掉 IPv4-mapped 前缀与端口；没有 → null */
export function clientIpFromXff(xff: string | null | undefined): string | null {
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim() ?? "";
  if (!first) return null;
  return normalizeIp(first);
}

export function normalizeIp(ip: string): string {
  let v = ip.trim();
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined); // [::1]:port
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":")); // 1.2.3.4:port
  if (v.toLowerCase().startsWith("::ffff:")) v = v.slice(7);
  return v.toLowerCase();
}

export function isLocalClient(clientIp: string | null, localIps: Iterable<string>): boolean {
  if (!clientIp) return false;
  const ip = normalizeIp(clientIp);
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  for (const l of localIps) if (normalizeIp(l) === ip) return true;
  return false;
}
