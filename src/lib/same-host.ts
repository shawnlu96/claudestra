/**
 * 「这个请求是不是这台机器自己的浏览器发的」——给本机打开目录这类只对本机有意义、又低危的功能用（bridge/local-api/host.ts）。
 * 配对、控制面豁免这类信任判定不用它，仍只认真实回环（bridge/web-gateway.ts isDirectLoopback）。
 * 来源地址：对端是回环且带 X-Forwarded-For = 本机反代（Caddy / tailscale serve）转来的，取最右一跳（反代追加的真实客户端；
 * 客户端自己写在左边的伪造值够不着）；对端不是回环 = 直连，XFF 是客户端自己写的，只认对端。
 * 地址属于本机任一网卡（回环 / 局域网 / tailnet）就算本机：在这台电脑上用 localhost、局域网 IP、自己的 tailnet 域名打开都算，
 * 手机和别的电脑都不算（tests/same-host.test.ts）。
 */
import { networkInterfaces } from "node:os";

/** 去掉 [ ]、IPv4 端口、IPv6 zone、IPv4-mapped 前缀，统一小写 */
export function normalizeIp(ip: string): string {
  let v = ip.trim().toLowerCase();
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  const zone = v.indexOf("%");
  if (zone > 0) v = v.slice(0, zone);
  if (v.startsWith("::ffff:") && v.includes(".")) v = v.slice(7);
  return v;
}

const isLoopbackIp = (ip: string): boolean => ip === "::1" || ip.startsWith("127.");

/** 这次请求的真实来源地址（见文件头的口径）；拿不到对端 → null */
export function requestSourceIp(socketIp: string | null | undefined, forwardedFor: string | null | undefined): string | null {
  if (!socketIp) return null;
  const peer = normalizeIp(socketIp);
  if (!isLoopbackIp(peer)) return peer;
  const hops = (forwardedFor ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops.length ? normalizeIp(hops[hops.length - 1]) : peer;
}

export function isOwnAddress(ip: string | null, own: Iterable<string>): boolean {
  if (!ip) return false;
  if (isLoopbackIp(ip)) return true;
  for (const a of own) if (normalizeIp(a) === ip) return true;
  return false;
}

let cache: { at: number; list: string[] } | null = null;
/** 本机所有网卡地址；缓存 10 秒（每个 /host 请求都要现判，Wi-Fi / Tailscale 换地址后很快跟上） */
export function ownAddresses(now = Date.now()): string[] {
  if (cache && now - cache.at < 10_000) return cache.list;
  const list = Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((n) => n.address));
  cache = { at: now, list };
  return list;
}

export function isSameHostRequest(socketIp: string | null | undefined, forwardedFor: string | null | undefined, own: Iterable<string> = ownAddresses()): boolean {
  return isOwnAddress(requestSourceIp(socketIp, forwardedFor), own);
}
