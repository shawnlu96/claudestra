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

/** 没配中继时给人复制的两行；已知中继地址就填进去，否则给示例 */
export function envSnippet(relayUrl?: string | null, slug?: string | null): string {
  return `RELAY_URL=${relayUrl || "wss://relay.example.com"}\nRELAY_NAME=${slug || "my-mac"}`;
}

export interface PairView {
  code: string;
  display: string;
  url: string;
  expiresAt: string;
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
