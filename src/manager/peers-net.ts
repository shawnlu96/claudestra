/**
 * peer 握手里跟网络地址打交道的两件事：生成邀请时探测本机对外地址、加入失败时扫 tailnet 找对方。
 * 从 manager/peers.ts 原样搬出（给「一个对方一条记录」的合并逻辑腾地方）。
 */
import { repoEnvVar } from "../lib/env-file.js";
import { DEFAULT_BRIDGE_PORT } from "../lib/bridge-url.js";

/**
 * peer 握手的 `--url` 没给时自动探测本机对外地址（手抄最容易错：IP 记错、忘带端口、填 127.0.0.1）。
 * 顺序：实测可用的 HTTPS 入口（lib/peer-url.ts）→ 主端口只听本机（默认）时 peer 专用端口直连
 * （lib/peer-ingress-config.ts）→ bridge 端口的 Tailscale / 内网地址。返回 null = 确实探不到，调用方要求人工给 --url。
 */
export async function resolveMyBridgeUrl(myUrl: string): Promise<{ url: string; note?: string } | null> {
  // 主端口只听本机时，写它的对外地址对方也连不进来——生成邀请这一刻就说明白（显式 --url 同理）
  const bind = (repoEnvVar("BRIDGE_BIND") || "127.0.0.1").trim();
  const bindWarn = bind === "127.0.0.1" || bind === "localhost" || bind === "::1"
    ? `⚠️ bridge 当前只监听 ${bind}（BRIDGE_BIND 未开放）——对方无法连入。在 .env 设 BRIDGE_BIND=0.0.0.0（或 Tailscale IP）并重启 bridge 后邀请才可用。`
    : "";
  if (myUrl) return { url: myUrl, note: bindWarn || undefined };
  const https = await (await import("../lib/peer-url.js")).httpsPeerUrl(repoEnvVar("PEER_PUBLIC_URL") || "");
  if (https) return { url: https, note: `用 HTTPS 入口 ${https}（反代 → 本机 peer 专用入口，bridge 端口不必对外开放）` };
  const port = parseInt(repoEnvVar("BRIDGE_PORT") || String(DEFAULT_BRIDGE_PORT));
  const direct = bindWarn ? await (await import("../lib/peer-ingress-config.js")).openDirectPeerIngress(port) : null;
  if (direct) return direct;
  const cands = (await import("../lib/net-addr.js")).detectBridgeUrls(port);
  if (cands.length === 0) return null;
  const best = cands[0]!;
  const others = cands.slice(1).map((c) => `${c.url}(${c.kind})`);
  return {
    url: best.url,
    note: `--url 未给，自动用 ${best.kind === "tailscale" ? "Tailscale" : "内网"} 地址 ${best.url}（网卡 ${best.iface}）` +
      (others.length ? `；其它候选: ${others.join(", ")}` : "") +
      (best.kind === "lan" ? "。⚠️ 内网地址只在同一局域网可达，跨网络请改用 Tailscale 或反代域名。" : "") +
      (bindWarn ? ` ${bindWarn}` : ""),
  };
}

/** v2.16.1 跨 tailnet 候选扫描:邀请地址连不上时,扫本机 tailscale 视角的
 *  peer IP 同端口找活着的 bridge(1.5s 超时并行 GET /api/v1/agents,有 HTTP
 *  响应即候选——401 也算,那正是 token 门禁在工作)。只探测不发凭据。 */
export async function scanTailnetBridges(failedUrl: string): Promise<string[]> {
  const port = (() => { try { return new URL(failedUrl).port || String(DEFAULT_BRIDGE_PORT); } catch { return String(DEFAULT_BRIDGE_PORT); } })();
  const failedHost = (() => { try { return new URL(failedUrl).hostname; } catch { return ""; } })();
  // CLI 定位统一走 lib/tailscale（PATH → App 包内 → 常见位置），与 setup / doctor / bridge 同一套
  const { readTailscaleStatusRaw } = await import("../lib/tailscale.js");
  const raw = await readTailscaleStatusRaw();
  if (!raw) return [];
  const ips: string[] = [];
  try {
    const j = raw as { Peer?: Record<string, { TailscaleIPs?: string[]; Online?: boolean }> };
    for (const p of Object.values(j.Peer || {})) {
      if (p.Online === false) continue;
      const v4 = (p.TailscaleIPs || []).find((ip) => /^100\./.test(ip));
      if (v4 && v4 !== failedHost) ips.push(v4);
    }
  } catch { return []; }
  const hits = await Promise.all(
    ips.slice(0, 20).map(async (ip) => {
      try {
        await fetch(`http://${ip}:${port}/api/v1/agents`, { signal: AbortSignal.timeout(1500) });
        return `http://${ip}:${port}`; // 任何 HTTP 响应(含 401)= 有 bridge
      } catch {
        return null;
      }
    })
  );
  return hits.filter((x): x is string => !!x);
}
