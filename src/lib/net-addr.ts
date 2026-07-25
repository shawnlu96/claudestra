/**
 * 本机对外可达地址探测 —— peer 握手时 `--url` 的自动填充来源。
 *
 * 建 peer 要求双方各自报出「对方能连到我的 bridge 的地址」。手抄这个地址是整个
 * 三步握手里最容易出错的一环：IP 记错一位、忘带端口、把 127.0.0.1 填进去（对方
 * 永远连不上，而错误要到 peer-http-test 才暴露）。
 *
 * 这里不依赖 `tailscale` CLI —— macOS 上它常常只装了 App（CLI 在
 * /Applications/Tailscale.app/Contents/MacOS/Tailscale，不在 PATH）。改为直接看
 * 网卡地址段判断，跨平台且零依赖。
 */

import { networkInterfaces } from "os";

/** Tailscale 分配的地址落在 100.64.0.0/10（CGNAT 段） */
export function isTailscaleAddr(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** RFC1918 私网段 */
export function isPrivateAddr(ip: string): boolean {
  if (/^192\.168\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

export type AddrKind = "tailscale" | "lan";

export interface AddrCandidate {
  url: string;
  kind: AddrKind;
  /** 网卡名，用于在多网卡机器上让人认出是哪一个 */
  iface: string;
  address: string;
}

/**
 * 列出可以填进 peer `--url` 的候选，**tailscale 优先**：
 * 它是唯一在两台机器不同网络时仍然可达的地址，而 LAN 地址只在同一局域网有效。
 */
export function detectBridgeUrls(port: number): AddrCandidate[] {
  const out: AddrCandidate[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      // Node 18+ 的 family 是 "IPv4"，老版本给 4 —— 两种都认
      const isV4 = a.family === "IPv4" || (a.family as unknown as number) === 4;
      if (!isV4 || a.internal) continue;
      const kind: AddrKind | null = isTailscaleAddr(a.address)
        ? "tailscale"
        : isPrivateAddr(a.address)
          ? "lan"
          : null;
      if (!kind) continue; // 公网地址不主动推荐：直接裸奔暴露 bridge 不是我们该默认的事
      out.push({ url: `http://${a.address}:${port}`, kind, iface, address: a.address });
    }
  }
  return out.sort((a, b) => Number(b.kind === "tailscale") - Number(a.kind === "tailscale"));
}

/** 最佳猜测：优先 tailscale，其次 LAN，都没有则 null（此时必须人工给 --url） */
export function guessBridgeUrl(port: number): AddrCandidate | null {
  return detectBridgeUrls(port)[0] ?? null;
}
