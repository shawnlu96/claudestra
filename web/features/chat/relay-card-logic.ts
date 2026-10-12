/**
 * Peer 面板「中继」卡的纯逻辑（tests/web-relay-card.test.ts）：状态归类、.env 示例、配对码倒计时。
 * 数据来自 /api/relay/status（bridge 的 GET /relay/status）与 /api/relay/pair。
 */

export interface RelayStatusView {
  ok?: boolean;
  error?: string;
  enabled?: boolean;
  connected?: boolean;
  state?: string | null;
  url?: string | null;
  slug?: string | null;
  base?: string | null;
  relayUrl?: string | null;
  lastError?: string | null;
  retryAt?: number | null;
}

export type RelayMode = "unknown" | "off" | "connecting" | "online";

/** 读不到 → unknown；没配 → off；配了没连上 → connecting；连上且有地址 → online */
export function relayMode(s: RelayStatusView | null | undefined): RelayMode {
  if (!s || s.ok === false) return "unknown";
  if (!s.enabled) return "off";
  return s.connected && s.url ? "online" : "connecting";
}

/** 请求本身失败（没拿到 bridge 的 JSON）：把原因带进卡片，否则权限不够、超时、bridge 不响应都只显示「读取失败」，没法远程排查 */
export function relayLoadFailure(e: unknown): RelayStatusView {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return { ok: false, error: msg || "unknown error" };
}

/** 「我的中继地址」：中继首页（路径模式，别的设备在这里扫码配对）；旧 bridge 不报 base 时退回子域名 */
export function relayHome(s: RelayStatusView | null | undefined): string | null {
  return s?.base ? `https://${s.base}` : (s?.url ?? null);
}

/** 没配中继时给人复制的两行；已知中继地址就填进去，否则给示例 */
export function envSnippet(relayUrl?: string | null, slug?: string | null): string {
  return `RELAY_URL=${relayUrl || "wss://relay.example.com"}\nRELAY_NAME=${slug || "my-mac"}`;
}

/** 距过期还有几秒；解析不了或已过 → 0 */
export function remainingSeconds(expiresAt: string, now: number): number {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : 0;
}

export function fmtRemaining(sec: number, lang: "zh" | "en"): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (lang === "en") return m ? `${m}m ${s}s` : `${s}s`;
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}
