/**
 * 本机对外可达地址探测 —— peer 握手时 `--url` 的自动填充来源。
 *
 * 建 peer 要求双方各自报出「对方能连到我的 bridge 的地址」。手抄这个地址是整个
 * 三步握手里最容易出错的一环：IP 记错一位、忘带端口、把 127.0.0.1 填进去（对方
 * 永远连不上，而错误要到 peer-http-test 才暴露）。
 *
 * 两条路：
 *   - 有 Tailscale CLI（lib/tailscale 负责定位，App 包内的也找得到）→ 以 `status --json`
 *     的 TailscaleIPs 为准标 tailscale，并可追加 MagicDNS 名候选。只按地址段猜会把运营商
 *     CGNAT / 其它 overlay 的 100.64/10 地址误标成 Tailscale。
 *   - 拿不到 status → 退回按网卡地址段判断：跨平台、零依赖，作兜底。
 */

import { networkInterfaces, type NetworkInterfaceInfo } from "os";

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

/** magicdns 只在调用方显式要求时出现（跨 tailnet 的 peer 解析不了对方的 MagicDNS 名，IP 更稳） */
export type AddrKind = "tailscale" | "lan" | "magicdns";

/** 来自 `tailscale status --json` 的最小子集；传了就以它为准 */
export interface TailnetSelf {
  ipv4: string[];
  dnsName?: string;
}

export interface AddrCandidate {
  url: string;
  kind: AddrKind;
  /** 网卡名，用于在多网卡机器上让人认出是哪一个 */
  iface: string;
  address: string;
}

/**
 * 纯函数核心：网卡列表 (+ 可选 tailnet 自身信息) → 候选，**tailscale 优先**：
 * 它是唯一在两台机器不同网络时仍然可达的地址，而 LAN 地址只在同一局域网有效。
 */
export function classifyInterfaces(
  ifaces: Record<string, NetworkInterfaceInfo[] | undefined>,
  port: number,
  ts?: TailnetSelf | null,
  opts: { includeMagicDNS?: boolean } = {},
): AddrCandidate[] {
  const tsSet = ts ? new Set(ts.ipv4) : null;
  const out: AddrCandidate[] = [];
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      // Node 18+ 的 family 是 "IPv4"，老版本给 4 —— 两种都认
      const isV4 = a.family === "IPv4" || (a.family as unknown as number) === 4;
      if (!isV4 || a.internal) continue;
      const isTs = tsSet ? tsSet.has(a.address) : isTailscaleAddr(a.address);
      const kind: AddrKind | null = isTs ? "tailscale" : isPrivateAddr(a.address) ? "lan" : null;
      if (!kind) continue; // 公网地址不主动推荐：直接裸奔暴露 bridge 不是我们该默认的事
      out.push({ url: `http://${a.address}:${port}`, kind, iface, address: a.address });
    }
  }
  const rank = (k: AddrKind) => (k === "lan" ? 1 : 0);
  out.sort((a, b) => rank(a.kind) - rank(b.kind));
  if (opts.includeMagicDNS && ts?.dnsName) {
    const firstTs = out.findIndex((c) => c.kind !== "tailscale");
    const cand: AddrCandidate = { url: `http://${ts.dnsName}:${port}`, kind: "magicdns", iface: "tailscale", address: ts.dnsName };
    out.splice(firstTs === -1 ? out.length : firstTs, 0, cand);
  }
  return out;
}

/** 同步版（无 CLI 信息，按地址段）—— 既有调用方保持原行为 */
export function detectBridgeUrls(port: number, ts?: TailnetSelf | null, opts?: { includeMagicDNS?: boolean }): AddrCandidate[] {
  return classifyInterfaces(networkInterfaces(), port, ts, opts);
}

/** 优先读 `tailscale status`（拿不到就退回地址段判断） */
export async function detectBridgeUrlsPreferStatus(port: number, opts?: { includeMagicDNS?: boolean }): Promise<AddrCandidate[]> {
  const { readTailscaleStatus } = await import("./tailscale.js");
  const st = await readTailscaleStatus().catch(() => null);
  return detectBridgeUrls(port, st?.running ? { ipv4: st.ipv4, dnsName: st.dnsName } : null, opts);
}

/** 最佳猜测：优先 tailscale，其次 LAN，都没有则 null（此时必须人工给 --url） */
export function guessBridgeUrl(port: number): AddrCandidate | null {
  return detectBridgeUrls(port)[0] ?? null;
}
