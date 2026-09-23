/**
 * 邀请串里写哪个地址：优先 HTTPS 入口——反代（Caddy `handle /api/v1/*` / tailscale serve
 * `--set-path /api/v1`）把 /api/v1 转到 bridge 的 peer 专用入口（bridge/peer-ingress.ts）。
 * 走它的话 bridge 端口不必对外开放，也不用给每个 peer 加防火墙白名单，新 peer 只要连得到
 * 本机（Tailscale 共享一次）即可。**实测通了才用**：反代没配 /api/v1 时，同一个域名打到的是
 * 网页（404 HTML），写进邀请只会让对方兑换失败。
 */
import { readTailscaleStatus } from "./tailscale.js";

/** 打到 bridge 的 /api/v1 不带 token → 401 JSON {ok:false}；没转发到 bridge（落到网页）则是 404 HTML */
export function isBridgeApiProbe(status: number, contentType: string, body: unknown): boolean {
  return status === 401 && contentType.includes("application/json") && (body as { ok?: unknown } | null)?.ok === false;
}

async function probe(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/v1/agents`, { signal: AbortSignal.timeout(4000) });
    const body = await r.json().catch(() => null); // 非 JSON（落到网页的 HTML）正是要识别的「没转发到 bridge」
    return isBridgeApiProbe(r.status, r.headers.get("content-type") || "", body);
  } catch {
    return false; // 连不上 = 这个入口不可用，退回 bridge 端口地址
  }
}

/** explicit = .env 的 PEER_PUBLIC_URL；没给就试本机 ts.net 名的 443 / 8443（装机向导两种落点） */
export async function httpsPeerUrl(explicit = ""): Promise<string | null> {
  const bases = explicit.trim() ? [explicit.trim().replace(/\/+$/, "")] : [];
  if (!bases.length) {
    const dns = (await readTailscaleStatus())?.dnsName;
    if (dns) bases.push(`https://${dns}`, `https://${dns}:8443`);
  }
  for (const b of bases) if (await probe(b)) return b;
  return null;
}
